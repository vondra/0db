//! adsb.lol JSON trace parser → `TracePoint` stream.
//!
//! TAR layout: one `subset.tar` (or split `.tar.aa` + `.tar.ab`) per day,
//! containing `traces/{xx}/trace_full_{icao24}.json.gz`. Each gzipped
//! JSON has shape `{ "icao", "t", "timestamp", "trace": [[ts_offset, lat,
//! lon, alt_ft|"ground", speed_kt, track_deg, on_ground_bit, baro_rate,
//! ...], ...] }`.
//!
//! Parsing here is intentionally permissive — only structural failures
//! (truncated gzip, malformed JSON) drop a record. Per-point sanity
//! checks live in `filters::point_is_sane` so the filter set has a
//! single source of truth.

use anyhow::Result;
use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;

/// Trace-point bit 0 — `on_ground` set by the adsb.lol bitfield.
pub const FLAG_ON_GROUND_RAW: u8 = 1 << 0;
/// Trace-point bit 1 — altitude column was the literal string `"ground"`.
pub const FLAG_ALT_IS_GROUND: u8 = 1 << 1;

/// One ADS-B point. `flags` packs the two ground-related raw signals so
/// the v6 Arrow schema can carry them as a single byte without losing
/// the distinction the composite ground inference relies on.
#[derive(Clone, Debug)]
pub struct TracePoint {
    pub timestamp: f64,
    pub lat: f32,
    pub lon: f32,
    /// Barometric altitude in feet. `NaN` when [`FLAG_ALT_IS_GROUND`] is
    /// set; read via [`TracePoint::airborne_alt_ft`] to keep ground
    /// sentinels out of arithmetic.
    pub alt_ft: f32,
    pub speed_kt: f32,
    pub track_deg: f32,
    pub baro_rate_fpm: f32,
    pub flags: u8,
}

impl TracePoint {
    pub fn alt_is_ground(&self) -> bool {
        self.flags & FLAG_ALT_IS_GROUND != 0
    }
    pub fn on_ground_raw(&self) -> bool {
        self.flags & FLAG_ON_GROUND_RAW != 0
    }
    /// `Some(alt_ft)` for airborne points, `None` for `alt_is_ground`
    /// sentinel rows whose `alt_ft` is `NaN`. Funnels every alt-arithmetic
    /// site through one flag-aware accessor so a missed branch can't
    /// silently propagate NaN into AGL / ROCD / teleport arithmetic.
    pub fn airborne_alt_ft(&self) -> Option<f32> {
        if self.alt_is_ground() {
            None
        } else {
            Some(self.alt_ft)
        }
    }
}

/// All trace points for one aircraft on one day.
pub struct AircraftTrace {
    pub icao24: String,
    pub aircraft_type: String,
    pub points: Vec<TracePoint>,
}

/// Read every aircraft trace from a single day's TAR archive(s).
/// Multipart support handles `.tar.aa` + `.tar.ab` continuation files.
pub fn read_day_traces(day_dir: &Path) -> Result<Vec<AircraftTrace>> {
    let mut tar_parts: Vec<_> = std::fs::read_dir(day_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => return false,
            };
            name.ends_with(".tar") || name.ends_with(".tar.aa") || name.ends_with(".tar.ab")
        })
        .collect();
    tar_parts.sort();
    if tar_parts.is_empty() {
        return Ok(Vec::new());
    }

    let readers: Vec<File> = tar_parts
        .iter()
        .map(File::open)
        .collect::<io::Result<Vec<_>>>()?;
    let concat = ConcatReader::new(readers);
    let buf = BufReader::with_capacity(1 << 20, concat);
    let mut archive = tar::Archive::new(buf);

    let mut traces = Vec::new();
    for entry in archive.entries()? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = match entry.path() {
            Ok(p) => p.to_path_buf(),
            Err(_) => continue,
        };
        let path_str = path.to_str().unwrap_or("");
        if !path_str.contains("trace_full_") || !path_str.ends_with(".json") {
            continue;
        }
        if let Ok(Some(trace)) = parse_trace(entry) {
            traces.push(trace);
        }
    }
    Ok(traces)
}

/// Parse one gzipped `trace_full_*.json` from a TAR entry. Returns
/// `None` when the JSON is empty, missing the trace array, or has
/// fewer than two valid points.
pub fn parse_trace<R: Read>(reader: R) -> Result<Option<AircraftTrace>> {
    let json_bytes = {
        let mut gz = GzDecoder::new(reader);
        let mut buf = Vec::new();
        match gz.read_to_end(&mut buf) {
            Ok(_) if !buf.is_empty() => buf,
            _ => return Ok(None),
        }
    };
    let val: serde_json::Value = match serde_json::from_slice(&json_bytes) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let icao24 = val
        .get("icao")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let aircraft_type = val
        .get("t")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_timestamp = val.get("timestamp").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let trace_arr = match val.get("trace").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Ok(None),
    };

    let mut points = Vec::with_capacity(trace_arr.len());
    for entry in trace_arr {
        let arr = match entry.as_array() {
            Some(a) if a.len() >= 7 => a,
            _ => continue,
        };
        let ts_offset = arr[0].as_f64().unwrap_or(0.0);
        let lat = arr[1].as_f64().unwrap_or(0.0) as f32;
        let lon = arr[2].as_f64().unwrap_or(0.0) as f32;
        let (alt_ft, alt_is_ground) = parse_altitude_ft(&arr[3]);
        let speed_kt = arr[4].as_f64().unwrap_or(0.0) as f32;
        let track_deg = arr[5].as_f64().unwrap_or(0.0) as f32;
        let on_ground_bit = arr[6].as_i64().unwrap_or(0);
        let baro_rate_fpm = arr.get(7).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;

        let mut flags = 0u8;
        if on_ground_bit & 1 != 0 {
            flags |= FLAG_ON_GROUND_RAW;
        }
        if alt_is_ground {
            flags |= FLAG_ALT_IS_GROUND;
            // adsb.lol semantics: "alt is ground" implies on_ground.
            flags |= FLAG_ON_GROUND_RAW;
        }
        points.push(TracePoint {
            timestamp: base_timestamp + ts_offset,
            lat,
            lon,
            alt_ft,
            speed_kt,
            track_deg,
            baro_rate_fpm,
            flags,
        });
    }
    if points.len() < 2 {
        return Ok(None);
    }
    Ok(Some(AircraftTrace {
        icao24,
        aircraft_type,
        points,
    }))
}

/// `"ground"` string maps to `(NaN, true)` — not `(0.0, true)` — so a
/// sub-sea-level aerodrome (Schiphol −3 m, Atyrau −22 m) can't collide
/// with the on-surface marker, and a missed flag check downstream
/// surfaces as NaN rather than as a silent underground truncation.
fn parse_altitude_ft(value: &serde_json::Value) -> (f32, bool) {
    if let Some(alt_ft) = value.as_f64() {
        return (alt_ft as f32, false);
    }
    if value
        .as_str()
        .map(|s| s.eq_ignore_ascii_case("ground"))
        .unwrap_or(false)
    {
        return (f32::NAN, true);
    }
    (f32::NAN, false)
}

/// Sequentially reads a list of byte-contiguous parts as one stream.
/// Used to recover the multipart TAR continuation files.
struct ConcatReader<R> {
    readers: Vec<R>,
    current: usize,
}

impl<R: Read> ConcatReader<R> {
    fn new(readers: Vec<R>) -> Self {
        Self { readers, current: 0 }
    }
}

impl<R: Read> Read for ConcatReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.current < self.readers.len() {
            let n = self.readers[self.current].read(buf)?;
            if n > 0 {
                return Ok(n);
            }
            self.current += 1;
        }
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn gz(json: &str) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(json.as_bytes()).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn parses_ground_altitude_marker() {
        let raw = gz(
            r#"{"icao":"49d261","t":"PC12","timestamp":1000,"trace":[
                [10,50.0,14.0,"ground",12.0,90.0,0,0],
                [20,50.001,14.001,600.0,80.0,120.0,0,0]
            ]}"#,
        );
        let t = parse_trace(raw.as_slice()).unwrap().unwrap();
        assert_eq!(t.points.len(), 2);
        assert!(t.points[0].alt_is_ground());
        assert!(t.points[0].on_ground_raw()); // implied by alt_is_ground
        assert!(t.points[0].alt_ft.is_nan());
        assert!(t.points[0].airborne_alt_ft().is_none());
        assert!(!t.points[1].alt_is_ground());
        assert_eq!(t.points[1].alt_ft, 600.0);
    }

    #[test]
    fn parses_bitfield_on_ground() {
        let raw = gz(
            r#"{"icao":"49c083","t":"WT9","timestamp":2000,"trace":[
                [10,50.0,14.0,300.0,40.0,90.0,1,0],
                [20,50.001,14.001,400.0,60.0,120.0,0,0]
            ]}"#,
        );
        let t = parse_trace(raw.as_slice()).unwrap().unwrap();
        assert!(t.points[0].on_ground_raw());
        assert!(!t.points[0].alt_is_ground());
        assert!(!t.points[1].on_ground_raw());
    }

    #[test]
    fn drops_traces_with_fewer_than_two_points() {
        let raw = gz(r#"{"icao":"abc123","t":"B738","timestamp":1,"trace":[[1,50.0,14.0,1000.0,250.0,90.0,0,0]]}"#);
        assert!(parse_trace(raw.as_slice()).unwrap().is_none());
    }

    #[test]
    fn missing_baro_rate_defaults_to_zero() {
        // 7-element row (no baro_rate column) should still parse.
        let raw = gz(
            r#"{"icao":"49d262","t":"PC12","timestamp":1000,"trace":[
                [10,50.0,14.0,500.0,80.0,90.0,0],
                [20,50.001,14.001,600.0,80.0,90.0,0]
            ]}"#,
        );
        let t = parse_trace(raw.as_slice()).unwrap().unwrap();
        assert_eq!(t.points[0].baro_rate_fpm, 0.0);
    }

    #[test]
    fn concat_reader_glues_two_streams() {
        let a = b"first half".to_vec();
        let b = b" second half".to_vec();
        let concat = ConcatReader::new(vec![a.as_slice(), b.as_slice()]);
        let mut out = Vec::new();
        BufReader::new(concat).read_to_end(&mut out).unwrap();
        assert_eq!(&out, b"first half second half");
    }

    /// Smoke test against real cached data when available — proves the
    /// parser handles the actual adsb.lol layout, not just synthetic
    /// fixtures. Skipped when the cache is missing.
    #[test]
    fn smoke_real_praha_cache() {
        let day = Path::new("/0db.app/v4.0-wt2/data/source/flights-cache/radius/praha-150km/2025/2025-01-21");
        if !day.exists() {
            return;
        }
        let traces = read_day_traces(day).unwrap();
        assert!(traces.len() > 100, "got only {} traces", traces.len());
        let total_pts: usize = traces.iter().map(|t| t.points.len()).sum();
        assert!(total_pts > 50_000, "got only {total_pts} pts");
        // At least some have a 4-character ICAO typecode (most common case).
        let typed = traces.iter().filter(|t| t.aircraft_type.len() >= 3).count();
        assert!(typed > traces.len() / 2);
    }
}
