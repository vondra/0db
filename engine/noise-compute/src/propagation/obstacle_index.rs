//! Uniform-grid edge index for vector obstacles (buildings ∪ noise barriers)
//! — exact ray×edge crossings for screening, geodata-v2 Phase 1.
//!
//! Obstacle footprints are decomposed into EDGES in a local equirectangular
//! metric frame (origin fixed at construction; same flat-earth model as the
//! kernels' `M_PER_DEG_LAT` / `M_PER_DEG_LON_EQ·cos(lat)` math), binned into a
//! uniform grid, and each source→receiver ray walks its grid cells (DDA)
//! collecting exact intersection chainages. Crossings are dominant-edge
//! CANDIDATES for `path_effects` — they never extend the cadence sample
//! arrays (GPU `MAXT` envelope, IMD/vegetation integral algebra and the
//! bare-earth δ* fit stay untouched by construction; plan v5 Phase 1).

use crate::constants::{m_per_deg_lon, M_PER_DEG_LAT};

/// One obstacle edge in the index's local metric frame.
#[derive(Clone, Copy, Debug)]
struct ObstacleEdge {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    height_m: f32,
    kind: ObstacleKind,
    id: u32,
}

/// What produced an edge — popup trace classification ("building" vs
/// "barrier") becomes exact instead of raster-inferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObstacleKind {
    Building,
    Barrier,
}

/// One exact ray×edge crossing: chainage `t ∈ (0, 1)` along the ray plus the
/// obstacle's height above local ground. `path_effects` turns it into a
/// dominant-edge candidate `z = terrain(t) + height_m`.
#[derive(Clone, Copy, Debug)]
pub struct CrossingCandidate {
    pub t: f64,
    pub height_m: f32,
    pub kind: ObstacleKind,
    pub id: u32,
}

/// Uniform-grid spatial index over obstacle edges. Build once per tile+halo
/// (or per popup query), then run many rays against it. CSR layout: cell →
/// slice of edge refs.
pub struct ObstacleIndex {
    origin_lat: f64,
    origin_lon: f64,
    m_per_deg_lon: f64,
    /// Grid cell size (m). ~2× the raster cell keeps cells-per-ray low while
    /// average edges-per-cell stays small in cities.
    cell_m: f64,
    min_x: f64,
    min_y: f64,
    cols: usize,
    rows: usize,
    cell_starts: Vec<u32>,
    edge_refs: Vec<u32>,
    edges: Vec<ObstacleEdge>,
}

/// Default grid pitch (m) — coarse enough that a 10 km ray walks ~160 cells.
pub const OBSTACLE_GRID_CELL_M: f64 = 64.0;

impl ObstacleIndex {
    /// Build from closed rings given as `(lat, lon)` sequences (first point
    /// need not be repeated at the end; the closing edge is added). Open
    /// polylines (noise barriers) go through [`Builder::add_polyline`].
    pub fn builder(origin_lat: f64, origin_lon: f64) -> Builder {
        Builder {
            origin_lat,
            origin_lon,
            m_per_deg_lon: m_per_deg_lon(origin_lat.to_radians()),
            edges: Vec::new(),
        }
    }

    #[inline]
    fn to_local(&self, lat: f64, lon: f64) -> (f64, f64) {
        (
            (lon - self.origin_lon) * self.m_per_deg_lon,
            (lat - self.origin_lat) * M_PER_DEG_LAT,
        )
    }

    /// Number of indexed edges (telemetry / memory accounting).
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Exact crossings of the ray `src→rcv`, endpoint-exclusive
    /// (`t ∈ (0, 1)`), appended to `out` (cleared first), sorted by `t` and
    /// deduped to one candidate per (obstacle, chainage). Endpoint
    /// exclusivity drops hits AT the endpoints only; a footprint CONTAINING
    /// an endpoint still reports its entry/exit edge — filtering the
    /// source's own building is the caller's job (`exclusion_radius_m`
    /// semantics live in `path_effects`, not here).
    pub fn crossings(
        &self,
        src_lat: f64,
        src_lon: f64,
        rcv_lat: f64,
        rcv_lon: f64,
        out: &mut Vec<CrossingCandidate>,
    ) {
        out.clear();
        if self.edges.is_empty() {
            return;
        }
        let (sx, sy) = self.to_local(src_lat, src_lon);
        let (rx, ry) = self.to_local(rcv_lat, rcv_lon);
        let (dx, dy) = (rx - sx, ry - sy);

        // DDA over grid cells (Amanatides & Woo), clamped to the grid slab.
        let inv_cell = 1.0 / self.cell_m;
        let mut cx = (((sx - self.min_x) * inv_cell).floor() as i64).clamp(0, self.cols as i64 - 1);
        let mut cy = (((sy - self.min_y) * inv_cell).floor() as i64).clamp(0, self.rows as i64 - 1);
        let end_cx = (((rx - self.min_x) * inv_cell).floor() as i64).clamp(0, self.cols as i64 - 1);
        let end_cy = (((ry - self.min_y) * inv_cell).floor() as i64).clamp(0, self.rows as i64 - 1);

        let step_x: i64 = if dx >= 0.0 { 1 } else { -1 };
        let step_y: i64 = if dy >= 0.0 { 1 } else { -1 };
        // Δt of one cell step per axis (Amanatides & Woo tDelta).
        let t_delta_x = if dx != 0.0 {
            (self.cell_m / dx).abs()
        } else {
            f64::INFINITY
        };
        let t_delta_y = if dy != 0.0 {
            (self.cell_m / dy).abs()
        } else {
            f64::INFINITY
        };
        let next_x_boundary = self.min_x + (cx + i64::from(dx >= 0.0)) as f64 * self.cell_m;
        let next_y_boundary = self.min_y + (cy + i64::from(dy >= 0.0)) as f64 * self.cell_m;
        let mut t_max_x = if dx != 0.0 {
            ((next_x_boundary - sx) / dx).abs()
        } else {
            f64::INFINITY
        };
        let mut t_max_y = if dy != 0.0 {
            ((next_y_boundary - sy) / dy).abs()
        } else {
            f64::INFINITY
        };

        // An edge spans every supercover cell it passes through, so the ray
        // can re-test it in each of them. The ring buffer is only a cheap
        // prune of immediate re-tests; CORRECTNESS comes from the post-sort
        // dedup below (gg review 2026-07-28: the ring alone loses to >8
        // intervening hits, and a ray through a shared ring vertex hits two
        // edges of the same obstacle at one t).
        let mut recent: [u32; 8] = [u32::MAX; 8];
        let mut recent_at = 0usize;

        let mut guard = (self.cols + self.rows) as i64 + 4;
        loop {
            let cell = cy as usize * self.cols + cx as usize;
            let lo = self.cell_starts[cell] as usize;
            let hi = self.cell_starts[cell + 1] as usize;
            'edges: for &eref in &self.edge_refs[lo..hi] {
                if recent.contains(&eref) {
                    continue 'edges;
                }
                let e = self.edges[eref as usize];
                if let Some(t) = segment_intersection_t(
                    sx,
                    sy,
                    dx,
                    dy,
                    e.x0 as f64,
                    e.y0 as f64,
                    e.x1 as f64,
                    e.y1 as f64,
                ) {
                    recent[recent_at % recent.len()] = eref;
                    recent_at += 1;
                    out.push(CrossingCandidate {
                        t,
                        height_m: e.height_m,
                        kind: e.kind,
                        id: e.id,
                    });
                }
            }
            if (cx == end_cx && cy == end_cy) || guard <= 0 {
                break;
            }
            guard -= 1;
            if t_max_x < t_max_y {
                t_max_x += t_delta_x;
                cx += step_x;
            } else {
                t_max_y += t_delta_y;
                cy += step_y;
            }
            if cx < 0 || cy < 0 || cx >= self.cols as i64 || cy >= self.rows as i64 {
                break;
            }
        }
        out.sort_unstable_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
        // One candidate per (obstacle, chainage): kills ring-eviction repeats
        // (same edge ⇒ bit-identical t) and vertex double-counts (two edges of
        // one ring meeting at the hit point; tolerance covers their last-ulp
        // difference). A tangent ray thus yields ONE conservative candidate.
        out.dedup_by(|a, b| a.id == b.id && (a.t - b.t).abs() < 1e-9);
    }
}

/// A query-scoped set of per-cell [`ObstacleIndex`]es (Arc-shared from a
/// process cache). The ingest's half-open centroid ownership guarantees a
/// footprint lives in exactly ONE cell index, so per-index results concat
/// without cross-index dedupe; one final sort restores chainage order.
pub struct ObstacleSet {
    pub indexes: Vec<std::sync::Arc<ObstacleIndex>>,
}

impl ObstacleSet {
    /// Total indexed edges across the set (telemetry / emptiness check).
    pub fn edge_count(&self) -> usize {
        self.indexes.iter().map(|i| i.edge_count()).sum()
    }

    /// Exact crossings of the ray across every cell index, t-sorted.
    pub fn crossings(
        &self,
        src_lat: f64,
        src_lon: f64,
        rcv_lat: f64,
        rcv_lon: f64,
        out: &mut Vec<CrossingCandidate>,
    ) {
        out.clear();
        let mut scratch = Vec::new();
        for idx in &self.indexes {
            idx.crossings(src_lat, src_lon, rcv_lat, rcv_lon, &mut scratch);
            out.extend_from_slice(&scratch);
        }
        out.sort_unstable_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    }
}

/// Read `QM_VECTOR_BUILDINGS` once per process. Loaders (tile-painter,
/// source-reader) call this at init and thread the bool — kernels never read
/// the environment. OFF is the production default until the Wave-1 cutover.
pub fn vector_buildings_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("QM_VECTOR_BUILDINGS").is_ok_and(|v| v == "1"))
}

/// Chainage of the intersection of ray `(sx,sy)+t·(dx,dy)` with segment
/// `(x0,y0)–(x1,y1)`, if any, with `t` strictly inside `(0, 1)` and the hit
/// strictly inside the segment (`u ∈ [0, 1]`). Standard 2D cross-product
/// parametric form; collinear overlap returns `None` (a ray sliding along a
/// wall face grazes it, it does not cross it).
#[inline]
fn segment_intersection_t(
    sx: f64,
    sy: f64,
    dx: f64,
    dy: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
) -> Option<f64> {
    let ex = x1 - x0;
    let ey = y1 - y0;
    let denom = dx * ey - dy * ex;
    if denom == 0.0 {
        return None;
    }
    let wx = x0 - sx;
    let wy = y0 - sy;
    let t = (wx * ey - wy * ex) / denom;
    let u = (wx * dy - wy * dx) / denom;
    if t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

/// Accumulates edges, then freezes them into the CSR grid.
pub struct Builder {
    origin_lat: f64,
    origin_lon: f64,
    m_per_deg_lon: f64,
    edges: Vec<ObstacleEdge>,
}

impl Builder {
    #[inline]
    fn to_local(&self, lat: f64, lon: f64) -> (f64, f64) {
        (
            (lon - self.origin_lon) * self.m_per_deg_lon,
            (lat - self.origin_lat) * M_PER_DEG_LAT,
        )
    }

    /// Add a closed ring (footprint outer ring or hole — holes screen too:
    /// a courtyard wall is a wall). The closing edge back to the first
    /// point is added automatically.
    pub fn add_ring(&mut self, ring: &[(f64, f64)], height_m: f32, kind: ObstacleKind, id: u32) {
        // `is_finite` + `<= 0` together reject NaN heights; non-finite
        // coordinates would otherwise bin into cell (0,0) and panic the
        // t-sort downstream.
        if ring.len() < 3
            || !height_m.is_finite()
            || height_m <= 0.0
            || ring.iter().any(|(a, o)| !a.is_finite() || !o.is_finite())
        {
            return;
        }
        for i in 0..ring.len() {
            let (lat0, lon0) = ring[i];
            let (lat1, lon1) = ring[(i + 1) % ring.len()];
            if lat0 == lat1 && lon0 == lon1 {
                continue; // explicit closing repeat in the source data
            }
            let (x0, y0) = self.to_local(lat0, lon0);
            let (x1, y1) = self.to_local(lat1, lon1);
            self.edges.push(ObstacleEdge {
                x0: x0 as f32,
                y0: y0 as f32,
                x1: x1 as f32,
                y1: y1 as f32,
                height_m,
                kind,
                id,
            });
        }
    }

    /// Add every ring of a raw-WKB Polygon/MultiPolygon footprint (outer
    /// rings AND holes — a courtyard wall is a wall). Invalid or non-areal
    /// WKB adds nothing. This is the obstacle-store ingestion entry: the
    /// per-cell arrows carry Overture WKB bytes unencoded.
    pub fn add_polygon_wkb(&mut self, wkb: &[u8], height_m: f32, kind: ObstacleKind, id: u32) {
        for (outer, holes) in crate::wkb::parse_wkb_polygons_bytes(wkb) {
            self.add_ring(&outer, height_m, kind, id);
            for hole in &holes {
                self.add_ring(hole, height_m, kind, id);
            }
        }
    }

    /// Add an open polyline (noise barrier segment chain).
    pub fn add_polyline(&mut self, pts: &[(f64, f64)], height_m: f32, kind: ObstacleKind, id: u32) {
        if pts.len() < 2
            || !height_m.is_finite()
            || height_m <= 0.0
            || pts.iter().any(|(a, o)| !a.is_finite() || !o.is_finite())
        {
            return;
        }
        for w in pts.windows(2) {
            let (x0, y0) = self.to_local(w[0].0, w[0].1);
            let (x1, y1) = self.to_local(w[1].0, w[1].1);
            self.edges.push(ObstacleEdge {
                x0: x0 as f32,
                y0: y0 as f32,
                x1: x1 as f32,
                y1: y1 as f32,
                height_m,
                kind,
                id,
            });
        }
    }

    /// Freeze into the CSR grid index. Empty builder yields an index whose
    /// `crossings` is a no-op (the rural fast path).
    pub fn build(self) -> ObstacleIndex {
        let cell_m = OBSTACLE_GRID_CELL_M;
        let (mut min_x, mut min_y) = (f64::MAX, f64::MAX);
        let (mut max_x, mut max_y) = (f64::MIN, f64::MIN);
        for e in &self.edges {
            min_x = min_x.min(e.x0 as f64).min(e.x1 as f64);
            min_y = min_y.min(e.y0 as f64).min(e.y1 as f64);
            max_x = max_x.max(e.x0 as f64).max(e.x1 as f64);
            max_y = max_y.max(e.y0 as f64).max(e.y1 as f64);
        }
        if self.edges.is_empty() {
            return ObstacleIndex {
                origin_lat: self.origin_lat,
                origin_lon: self.origin_lon,
                m_per_deg_lon: self.m_per_deg_lon,
                cell_m,
                min_x: 0.0,
                min_y: 0.0,
                cols: 1,
                rows: 1,
                cell_starts: vec![0, 0],
                edge_refs: Vec::new(),
                edges: Vec::new(),
            };
        }
        let cols = (((max_x - min_x) / cell_m).floor() as usize + 1).max(1);
        let rows = (((max_y - min_y) / cell_m).floor() as usize + 1).max(1);

        // Two-pass CSR fill: count per-cell refs, prefix-sum, then place.
        // Edges are binned by SUPERCOVER (the cells the segment actually
        // passes through, Amanatides & Woo — same traversal the query ray
        // uses), not by bbox: a 10 km diagonal barrier touches ~313 cells,
        // its bbox ~25k (gg review 2026-07-28).
        let mut counts = vec![0u32; cols * rows + 1];
        for e in &self.edges {
            for_each_segment_cell(e, min_x, min_y, cell_m, cols, rows, |c| {
                counts[c + 1] += 1;
            });
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let total = *counts.last().unwrap() as usize;
        assert!(
            u32::try_from(total).is_ok() && total < u32::MAX as usize,
            "obstacle CSR overflow: {total} refs"
        );
        let cell_starts = counts.clone();
        let mut cursor: Vec<u32> = cell_starts[..cols * rows].to_vec();
        let mut edge_refs = vec![0u32; total];
        for (i, e) in self.edges.iter().enumerate() {
            for_each_segment_cell(e, min_x, min_y, cell_m, cols, rows, |c| {
                edge_refs[cursor[c] as usize] = i as u32;
                cursor[c] += 1;
            });
        }

        ObstacleIndex {
            origin_lat: self.origin_lat,
            origin_lon: self.origin_lon,
            m_per_deg_lon: self.m_per_deg_lon,
            cell_m,
            min_x,
            min_y,
            cols,
            rows,
            cell_starts,
            edge_refs,
            edges: self.edges,
        }
    }
}

/// Visit every grid cell the segment passes through (4-connected supercover,
/// Amanatides & Woo), clamped to the grid. Shared shape with the query-ray
/// walk in [`ObstacleIndex::crossings`] so binning and querying agree on
/// which cells a segment can be found in.
fn for_each_segment_cell(
    e: &ObstacleEdge,
    min_x: f64,
    min_y: f64,
    cell_m: f64,
    cols: usize,
    rows: usize,
    mut visit: impl FnMut(usize),
) {
    let (x0, y0, x1, y1) = (e.x0 as f64, e.y0 as f64, e.x1 as f64, e.y1 as f64);
    let inv_cell = 1.0 / cell_m;
    let mut cx = (((x0 - min_x) * inv_cell).floor() as i64).clamp(0, cols as i64 - 1);
    let mut cy = (((y0 - min_y) * inv_cell).floor() as i64).clamp(0, rows as i64 - 1);
    let end_cx = (((x1 - min_x) * inv_cell).floor() as i64).clamp(0, cols as i64 - 1);
    let end_cy = (((y1 - min_y) * inv_cell).floor() as i64).clamp(0, rows as i64 - 1);
    let (dx, dy) = (x1 - x0, y1 - y0);
    let step_x: i64 = if dx >= 0.0 { 1 } else { -1 };
    let step_y: i64 = if dy >= 0.0 { 1 } else { -1 };
    let t_delta_x = if dx != 0.0 {
        (cell_m / dx).abs()
    } else {
        f64::INFINITY
    };
    let t_delta_y = if dy != 0.0 {
        (cell_m / dy).abs()
    } else {
        f64::INFINITY
    };
    let next_x_boundary = min_x + (cx + i64::from(dx >= 0.0)) as f64 * cell_m;
    let next_y_boundary = min_y + (cy + i64::from(dy >= 0.0)) as f64 * cell_m;
    let mut t_max_x = if dx != 0.0 {
        ((next_x_boundary - x0) / dx).abs()
    } else {
        f64::INFINITY
    };
    let mut t_max_y = if dy != 0.0 {
        ((next_y_boundary - y0) / dy).abs()
    } else {
        f64::INFINITY
    };
    let mut guard = (cols + rows) as i64 + 4;
    loop {
        visit(cy as usize * cols + cx as usize);
        if (cx == end_cx && cy == end_cy) || guard <= 0 {
            return;
        }
        guard -= 1;
        if t_max_x < t_max_y {
            t_max_x += t_delta_x;
            cx += step_x;
        } else {
            t_max_y += t_delta_y;
            cy += step_y;
        }
        if cx < 0 || cy < 0 || cx >= cols as i64 || cy >= rows as i64 {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLAT: f64 = 50.0;
    const OLON: f64 = 14.0;

    /// Metric offsets (m east, m north of the origin) → (lat, lon).
    fn ll(x_m: f64, y_m: f64) -> (f64, f64) {
        (
            OLAT + y_m / M_PER_DEG_LAT,
            OLON + x_m / m_per_deg_lon(OLAT.to_radians()),
        )
    }

    fn square(cx: f64, cy: f64, half: f64) -> Vec<(f64, f64)> {
        vec![
            ll(cx - half, cy - half),
            ll(cx + half, cy - half),
            ll(cx + half, cy + half),
            ll(cx - half, cy + half),
        ]
    }

    fn run(idx: &ObstacleIndex, from: (f64, f64), to: (f64, f64)) -> Vec<CrossingCandidate> {
        let mut out = Vec::new();
        idx.crossings(from.0, from.1, to.0, to.1, &mut out);
        out
    }

    #[test]
    fn empty_index_yields_no_crossings() {
        let idx = ObstacleIndex::builder(OLAT, OLON).build();
        assert_eq!(idx.edge_count(), 0);
        assert!(run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0)).is_empty());
    }

    /// A ray straight through a square building enters and exits: exactly two
    /// crossings, ordered by t, at the expected chainages.
    #[test]
    fn ray_through_square_crosses_twice() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(500.0, 0.0, 10.0), 12.0, ObstacleKind::Building, 7);
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        assert_eq!(c.len(), 2, "enter + exit");
        assert!(c[0].t < c[1].t);
        assert!(
            (c[0].t - 0.49).abs() < 0.005,
            "entry at ~490 m, got {}",
            c[0].t
        );
        assert!(
            (c[1].t - 0.51).abs() < 0.005,
            "exit at ~510 m, got {}",
            c[1].t
        );
        assert!(c
            .iter()
            .all(|x| x.height_m == 12.0 && x.kind == ObstacleKind::Building && x.id == 7));
    }

    #[test]
    fn ray_beside_square_misses() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(500.0, 100.0, 10.0), 12.0, ObstacleKind::Building, 1);
        let idx = b.build();
        assert!(run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0)).is_empty());
    }

    /// Receiver inside the footprint: entry edge only — and endpoint
    /// exclusivity keeps t strictly below 1.
    #[test]
    fn receiver_inside_footprint_sees_entry_only() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(1000.0, 0.0, 15.0), 20.0, ObstacleKind::Building, 3);
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        assert_eq!(c.len(), 1, "only the entry edge crosses");
        assert!(c[0].t > 0.0 && c[0].t < 1.0);
    }

    /// A barrier polyline whose single long edge spans many grid cells is
    /// reported ONCE (dedupe across DDA cells).
    #[test]
    fn long_wall_crossing_reported_once() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_polyline(
            &[ll(500.0, -400.0), ll(500.0, 400.0)],
            4.0,
            ObstacleKind::Barrier,
            9,
        );
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        assert_eq!(c.len(), 1, "one wall, one crossing");
        assert_eq!(c[0].kind, ObstacleKind::Barrier);
        assert!((c[0].t - 0.5).abs() < 0.005);
    }

    /// Two buildings along the ray: four crossings, strictly t-sorted.
    #[test]
    fn two_buildings_sorted_by_chainage() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(300.0, 0.0, 10.0), 6.0, ObstacleKind::Building, 1);
        b.add_ring(&square(700.0, 0.0, 10.0), 9.0, ObstacleKind::Building, 2);
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        assert_eq!(c.len(), 4);
        assert!(c.windows(2).all(|w| w[0].t < w[1].t));
        assert_eq!(
            c.iter().map(|x| x.id).collect::<Vec<_>>(),
            vec![1, 1, 2, 2],
            "near building's two edges first"
        );
    }

    /// Degenerate inputs are ignored: sub-3-point rings, non-positive heights.
    #[test]
    fn degenerate_inputs_are_ignored() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(
            &[ll(0.0, 0.0), ll(10.0, 0.0)],
            5.0,
            ObstacleKind::Building,
            1,
        );
        b.add_ring(&square(500.0, 0.0, 10.0), 0.0, ObstacleKind::Building, 2);
        b.add_polyline(&[ll(0.0, 0.0)], 3.0, ObstacleKind::Barrier, 3);
        let idx = b.build();
        assert_eq!(idx.edge_count(), 0);
    }

    /// A diagonal ray against a diagonal-ish wall — the DDA must not step
    /// past a crossing that sits exactly on a cell boundary region.
    #[test]
    fn diagonal_ray_hits_offset_wall() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_polyline(
            &[ll(400.0, 260.0), ll(640.0, 100.0)],
            5.0,
            ObstacleKind::Barrier,
            4,
        );
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 500.0));
        assert_eq!(c.len(), 1, "diagonal wall must be hit exactly once");
    }

    /// gg stress case: a long shallow-diagonal wall is binned into many cells;
    /// with >8 building crossings after the wall hit, the ring buffer evicts
    /// the wall's edge and the DDA re-tests it — the post-sort dedup must
    /// still report it exactly once.
    #[test]
    fn shallow_wall_with_many_intervening_hits_reported_once() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        // Wall from (100, -40) to (2000, 80): shallow diagonal, crossed early.
        b.add_polyline(
            &[ll(100.0, -40.0), ll(2000.0, 80.0)],
            4.0,
            ObstacleKind::Barrier,
            99,
        );
        // Ten small buildings straight along the ray after the wall crossing.
        for i in 0..10 {
            let cx = 500.0 + 120.0 * i as f64;
            b.add_ring(&square(cx, 0.0, 8.0), 6.0, ObstacleKind::Building, i);
        }
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(2000.0, 0.0));
        let walls = c.iter().filter(|x| x.id == 99).count();
        assert_eq!(walls, 1, "wall must appear exactly once, got {walls}");
        assert_eq!(c.len(), 21, "1 wall + 10 buildings x 2 edges");
    }

    /// A ray through a ring VERTEX touches two edges of the same obstacle at
    /// one chainage — dedup must collapse it to a single candidate.
    #[test]
    fn ring_vertex_hit_is_single_candidate() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(
            &square(500.0, 100.0, 100.0),
            10.0,
            ObstacleKind::Building,
            5,
        );
        let idx = b.build();
        // Diagonal ray through the square's bottom-left corner (400, 0):
        // from (300, -100) toward (500, 100) direction — corner at t=0.5 of
        // a (300,-100)->(700,300) ray. It then EXITS through the top edge.
        let c = run(&idx, ll(300.0, -100.0), ll(700.0, 300.0));
        let at_corner: Vec<_> = c.iter().filter(|x| (x.t - 0.25).abs() < 0.01).collect();
        assert!(
            at_corner.len() <= 1,
            "corner hit must dedup to one candidate, got {}",
            at_corner.len()
        );
        assert!(!c.is_empty());
    }

    /// A due-north ray (dx == 0) exercises the INFINITY t_delta branch.
    #[test]
    fn vertical_ray_crosses_horizontal_wall() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_polyline(
            &[ll(-50.0, 300.0), ll(50.0, 300.0)],
            3.0,
            ObstacleKind::Barrier,
            1,
        );
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(0.0, 600.0));
        assert_eq!(c.len(), 1);
        assert!((c[0].t - 0.5).abs() < 0.005);
    }

    /// Endpoints outside the indexed slab still collect the crossings the
    /// clipped path covers.
    #[test]
    fn ray_from_outside_slab_still_hits() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 20.0), 9.0, ObstacleKind::Building, 2);
        let idx = b.build();
        let c = run(&idx, ll(-5000.0, 0.0), ll(5000.0, 0.0));
        assert_eq!(c.len(), 2, "enter + exit despite far-outside endpoints");
    }

    /// Reversed ray sees the same crossings mirrored in t.
    #[test]
    fn reversed_ray_is_symmetric() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(300.0, 0.0, 10.0), 6.0, ObstacleKind::Building, 1);
        let idx = b.build();
        let fwd = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        let rev = run(&idx, ll(1000.0, 0.0), ll(0.0, 0.0));
        assert_eq!(fwd.len(), 2);
        assert_eq!(rev.len(), 2);
        assert!((fwd[0].t - (1.0 - rev[1].t)).abs() < 1e-9);
        assert!((fwd[1].t - (1.0 - rev[0].t)).abs() < 1e-9);
    }

    /// Two polyline segments sharing a vertex: a ray through the shared point
    /// dedups to one candidate (same obstacle id).
    #[test]
    fn shared_polyline_vertex_dedups() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_polyline(
            &[ll(500.0, -100.0), ll(500.0, 0.0), ll(500.0, 100.0)],
            4.0,
            ObstacleKind::Barrier,
            8,
        );
        let idx = b.build();
        let c = run(&idx, ll(0.0, 0.0), ll(1000.0, 0.0));
        assert_eq!(c.len(), 1, "shared vertex must not double-count");
    }

    /// Non-finite inputs are rejected wholesale.
    #[test]
    fn non_finite_inputs_are_rejected() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(
            &[ll(0.0, 0.0), (f64::NAN, 14.0), ll(10.0, 10.0)],
            5.0,
            ObstacleKind::Building,
            1,
        );
        b.add_ring(
            &square(500.0, 0.0, 10.0),
            f32::NAN,
            ObstacleKind::Building,
            2,
        );
        b.add_polyline(
            &[ll(0.0, 0.0), (50.0, f64::INFINITY)],
            3.0,
            ObstacleKind::Barrier,
            3,
        );
        let idx = b.build();
        assert_eq!(idx.edge_count(), 0);
    }
}
