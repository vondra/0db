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
    /// Per-footprint (id-indexed) min local x over all its rings — the
    /// containment walk skips footprints whose bbox lies strictly east of the
    /// probe. Requires DENSE ids (the loaders' sequential ordinals).
    footprint_xmin: Vec<f32>,
    /// Max per-footprint bbox width (m) — bounds the containment walk: a
    /// footprint straddling the probe cannot extend further east than this.
    max_footprint_w: f64,
}

/// Default grid pitch (m) — coarse enough that a 10 km ray walks ~160 cells.
pub const OBSTACLE_GRID_CELL_M: f64 = 64.0;

/// Flat per-index CSR view for GPU upload — see [`ObstacleIndex::gpu_view`].
pub struct GpuGridView<'a> {
    pub origin_lat: f64,
    pub origin_lon: f64,
    pub m_per_deg_lon: f64,
    pub cell_m: f64,
    pub min_x: f64,
    pub min_y: f64,
    pub cols: usize,
    pub rows: usize,
    pub cell_starts: &'a [u32],
    pub edge_refs: &'a [u32],
    /// `(x0, y0, x1, y1, height_m)` per edge, stride 5.
    pub edges_xyxyh: Vec<f32>,
}

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

    /// Flat CSR view for the CUDA lane (geodata-v2 1.6): grid frame constants
    /// plus borrowed CSR arrays and a materialised `(x0,y0,x1,y1,height)`
    /// edge array (kind/id are host-only concerns — the kernel keeps a
    /// running max-δ, never an identity). The kernel walk must mirror
    /// [`Self::crossings`] cell-for-cell; e2-full is the parity gate.
    pub fn gpu_view(&self) -> GpuGridView<'_> {
        let mut edges_xyxyh = Vec::with_capacity(self.edges.len() * 5);
        for e in &self.edges {
            edges_xyxyh.extend_from_slice(&[e.x0, e.y0, e.x1, e.y1, e.height_m]);
        }
        GpuGridView {
            origin_lat: self.origin_lat,
            origin_lon: self.origin_lon,
            m_per_deg_lon: self.m_per_deg_lon,
            cell_m: self.cell_m,
            min_x: self.min_x,
            min_y: self.min_y,
            cols: self.cols,
            rows: self.rows,
            cell_starts: &self.cell_starts,
            edge_refs: &self.edge_refs,
            edges_xyxyh,
        }
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
        self.append_crossings(src_lat, src_lon, rcv_lat, rcv_lon, out);
    }

    /// [`Self::crossings`] without the clear: appends this index's hits and
    /// sort+dedups ONLY the appended tail, so [`ObstacleSet`] can chain
    /// per-cell indexes into one buffer with zero per-ray allocation (the
    /// hot scatter loop runs this per receiver ray).
    fn append_crossings(
        &self,
        src_lat: f64,
        src_lon: f64,
        rcv_lat: f64,
        rcv_lon: f64,
        out: &mut Vec<CrossingCandidate>,
    ) {
        let start = out.len();
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
        out[start..].sort_unstable_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
        // One candidate per (obstacle, chainage): kills ring-eviction repeats
        // (same edge ⇒ bit-identical t) and vertex double-counts (two edges of
        // one ring meeting at the hit point; tolerance covers their last-ulp
        // difference). A tangent ray thus yields ONE conservative candidate.
        // In-place tail dedup (slices have no `dedup_by`), keep-first.
        let mut w = start;
        for r in start..out.len() {
            if w > start && out[r].id == out[w - 1].id && (out[r].t - out[w - 1].t).abs() < 1e-9 {
                continue;
            }
            out[w] = out[r];
            w += 1;
        }
        out.truncate(w);
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
        for idx in &self.indexes {
            idx.append_crossings(src_lat, src_lon, rcv_lat, rcv_lon, out);
        }
        out.sort_unstable_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    }
}

impl ObstacleIndex {
    /// Point-in-footprint test via PER-FOOTPRINT crossing parity along the
    /// probe's eastward half-line: a point is inside footprint `id` iff that
    /// footprint's boundary crosses the half-line an odd number of times
    /// (holes share the outer ring's id, so courtyards read outside; a
    /// global parity bit would break on overlapping footprints). Only
    /// footprints with `height_m > min_height_m` count.
    ///
    /// Exactness (gg review 2026-07-28, both reviewers):
    /// - Vertices use the classic half-open straddle rule
    ///   `(y0 > y) != (y1 > y)` — the same convention as `wkb.rs`
    ///   point-in-polygon: transit vertices count once, tangent vertices
    ///   twice or zero, horizontal edges never. No epsilon, no dedup.
    /// - An edge is listed in every row cell it passes; only the cell
    ///   CONTAINING the crossing point counts it (owner-cell rule), so
    ///   multi-cell edges cannot double-count.
    /// - The walk is bounded by `max_footprint_w`, the max footprint bbox
    ///   width IN THIS INDEX: any footprint whose bbox straddles the probe
    ///   ends within that distance east, and footprints starting east of the
    ///   probe (`footprint_xmin > x`) cannot contain it and are skipped —
    ///   both false-positive (ray "ending inside" a far footprint) and
    ///   false-negative (footprint wider than a fixed cast) failure modes of
    ///   a constant-length ray are structurally impossible.
    pub fn contains_built(
        &self,
        lat: f64,
        lon: f64,
        min_height_m: f32,
        seen: &mut Vec<(u32, u32)>,
    ) -> bool {
        if self.edges.is_empty() {
            return false;
        }
        let (x, y) = self.to_local(lat, lon);
        // Bbox reject: a point outside this index's edge extent cannot be
        // inside any footprint it owns — kills the ~7x wasted walks when a
        // probe queries every ring cell's index.
        let max_x = self.min_x + self.cols as f64 * self.cell_m;
        let max_y = self.min_y + self.rows as f64 * self.cell_m;
        if x < self.min_x || x > max_x || y < self.min_y || y > max_y {
            return false;
        }
        seen.clear();
        let inv_cell = 1.0 / self.cell_m;
        let cy = (((y - self.min_y) * inv_cell).floor() as i64).clamp(0, self.rows as i64 - 1);
        let mut cx = (((x - self.min_x) * inv_cell).floor() as i64).clamp(0, self.cols as i64 - 1);
        let end_cx = (((x + self.max_footprint_w - self.min_x) * inv_cell).floor() as i64)
            .clamp(0, self.cols as i64 - 1);
        // Horizontal half-line ⇒ the walk stays on one row.
        let row = cy as usize * self.cols;
        while cx <= end_cx {
            let cell_lo = self.min_x + cx as f64 * self.cell_m;
            let cell_hi = cell_lo + self.cell_m;
            let cell = row + cx as usize;
            let lo = self.cell_starts[cell] as usize;
            let hi = self.cell_starts[cell + 1] as usize;
            for &eref in &self.edge_refs[lo..hi] {
                let e = self.edges[eref as usize];
                if e.height_m <= min_height_m {
                    continue;
                }
                let (y0, y1) = (e.y0 as f64, e.y1 as f64);
                if (y0 > y) == (y1 > y) {
                    continue; // no straddle (also skips horizontal edges)
                }
                if (self.footprint_xmin[e.id as usize] as f64) > x {
                    continue; // footprint entirely east of the probe
                }
                let (x0, x1) = (e.x0 as f64, e.x1 as f64);
                let xc = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
                if xc > x && xc >= cell_lo && xc < cell_hi {
                    match seen.iter_mut().find(|(id, _)| *id == e.id) {
                        Some((_, n)) => *n += 1,
                        None => seen.push((e.id, 1)),
                    }
                }
            }
            cx += 1;
        }
        seen.iter().any(|(_, n)| n % 2 == 1)
    }
}

/// Receiver-local enclosure over a set of per-cell indexes — the vector twin
/// of the raster 3×3 probe (`RealRasters::building_enclosure`): fraction of 9
/// probe points at ±`ENCLOSURE`-metre offsets that sit inside a footprint
/// taller than 5 m → 0 / 1.5 / 3 dB. Same thresholds, same footprint metric
/// (a parcel split into several footprints cannot inflate it).
pub fn enclosure_db(set: &ObstacleSet, lat: f64, lon: f64, radius_m: f64) -> f64 {
    let step_lat = radius_m / M_PER_DEG_LAT;
    let step_lon = radius_m / m_per_deg_lon(lat.to_radians());
    let mut built = 0u32;
    let mut scratch: Vec<(u32, u32)> = Vec::new();
    for dr in [-1.0, 0.0, 1.0] {
        for dc in [-1.0_f64, 0.0, 1.0] {
            let plat = lat + dr * step_lat;
            let plon = ((lon + dc * step_lon + 180.0).rem_euclid(360.0)) - 180.0;
            if set
                .indexes
                .iter()
                .any(|i| i.contains_built(plat, plon, 5.0, &mut scratch))
            {
                built += 1;
            }
        }
    }
    let density = built as f64 / 9.0;
    if density > 0.5 {
        3.0
    } else if density > 0.2 {
        1.5
    } else {
        0.0
    }
}

/// Read `QM_VECTOR_BUILDINGS` once per process. Loaders (tile-painter,
/// source-reader) call this at init and thread the bool — kernels never read
/// the environment. OFF is the production default until the Wave-1 cutover.
pub fn vector_buildings_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("QM_VECTOR_BUILDINGS").is_ok_and(|v| v == "1"))
}

/// [`RasterSampler`] wrapper that swaps ONLY the receiver reflection probe
/// for the vector enclosure (plan 1.4b — the popup twin of the pipeline's
/// `rx_refl` pre-bake): `building_enclosure` answers from exact footprints
/// via [`enclosure_db`], every other lookup delegates to the raster sampler
/// unchanged. Wrapping at the sampler keeps ALL popup kernels (roads, rail,
/// points, airport ground) on one reflection source with zero signature
/// churn — SPEC §3.8 semantics on both paths.
pub struct VectorReflectionSampler<'a> {
    pub inner: &'a dyn crate::types::RasterSampler,
    pub set: &'a ObstacleSet,
}

impl crate::types::RasterSampler for VectorReflectionSampler<'_> {
    fn elevation(&self, lat: f64, lon: f64) -> f64 {
        self.inner.elevation(lat, lon)
    }
    fn building_height(&self, lat: f64, lon: f64) -> f64 {
        self.inner.building_height(lat, lon)
    }
    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        self.inner.ground_g(lat, lon)
    }
    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        enclosure_db(self.set, lat, lon, crate::constants::ENCLOSURE_RADIUS_M)
    }
    fn build_path_profile(
        &self,
        src_lat: f64,
        src_lon: f64,
        rcv_lat: f64,
        rcv_lon: f64,
        dist_m: f64,
        out: &mut crate::propagation::PathProfile,
    ) {
        self.inner
            .build_path_profile(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, out)
    }
    fn max_building_along_path(
        &self,
        src_lat: f64,
        src_lon: f64,
        rcv_lat: f64,
        rcv_lon: f64,
        dist_m: f64,
        excl_start_m: f64,
    ) -> (f64, f64) {
        self.inner
            .max_building_along_path(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, excl_start_m)
    }
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
                footprint_xmin: Vec::new(),
                max_footprint_w: 0.0,
            };
        }
        // Per-footprint bboxes for the containment walk (edges carry every
        // ring vertex, so the per-id min/max over edge endpoints IS the
        // union bbox of that id's rings). Dense-id contract: the loaders
        // assign sequential ordinals; each footprint has ≥ 3 edges, so a
        // sparse id space signals a broken caller, not big data.
        let max_id = self.edges.iter().map(|e| e.id).max().unwrap() as usize;
        assert!(
            max_id < self.edges.len().saturating_mul(4) + 1024,
            "obstacle ids must be dense loader ordinals (max id {max_id}, {} edges)",
            self.edges.len()
        );
        let mut footprint_xmin = vec![f32::INFINITY; max_id + 1];
        let mut footprint_xmax = vec![f32::NEG_INFINITY; max_id + 1];
        for e in &self.edges {
            let i = e.id as usize;
            footprint_xmin[i] = footprint_xmin[i].min(e.x0).min(e.x1);
            footprint_xmax[i] = footprint_xmax[i].max(e.x0).max(e.x1);
        }
        let max_footprint_w = footprint_xmin
            .iter()
            .zip(&footprint_xmax)
            .map(|(lo, hi)| (hi - lo) as f64)
            .fold(0.0, f64::max)
            + cell_m; // one-cell slack so the owner cell of the last crossing is walked
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
            footprint_xmin,
            max_footprint_w,
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

    /// Crossing-parity containment + the 9-probe enclosure thresholds.
    #[test]
    fn contains_and_enclosure_thresholds() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 60.0), 12.0, ObstacleKind::Building, 1);
        let idx = b.build();
        let mut sc = Vec::new();
        assert!(
            idx.contains_built(OLAT, OLON, 5.0, &mut sc),
            "centre is inside"
        );
        let (out_lat, out_lon) = ll(300.0, 0.0);
        assert!(
            !idx.contains_built(out_lat, out_lon, 5.0, &mut sc),
            "outside"
        );
        assert!(
            !idx.contains_built(OLAT, OLON, 20.0, &mut sc),
            "min-height gate must exclude the 12 m footprint"
        );

        let set = ObstacleSet {
            indexes: vec![std::sync::Arc::new(idx)],
        };
        // 60 m half-size square vs 75 m probes: only the centre probe is
        // inside → density 1/9 → 0 dB.
        assert_eq!(enclosure_db(&set, OLAT, OLON, 75.0), 0.0);

        // A 200 m half-size block swallows all 9 probes → 3 dB.
        let mut b2 = ObstacleIndex::builder(OLAT, OLON);
        b2.add_ring(&square(0.0, 0.0, 200.0), 12.0, ObstacleKind::Building, 1);
        let set2 = ObstacleSet {
            indexes: vec![std::sync::Arc::new(b2.build())],
        };
        assert_eq!(enclosure_db(&set2, OLAT, OLON, 75.0), 3.0);
    }

    /// gg case: a point inside TWO overlapping tall footprints must read
    /// inside (per-footprint parity — the old global bit XORed to false).
    #[test]
    fn overlapping_footprints_contain_correctly() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 50.0), 12.0, ObstacleKind::Building, 1);
        b.add_ring(&square(20.0, 0.0, 50.0), 15.0, ObstacleKind::Building, 2);
        let idx = b.build();
        let mut sc = Vec::new();
        assert!(idx.contains_built(OLAT, OLON, 5.0, &mut sc), "inside both");
        let (lat_e, lon_e) = ll(60.0, 0.0);
        assert!(
            idx.contains_built(lat_e, lon_e, 5.0, &mut sc),
            "inside #2 only"
        );
        let (lat_o, lon_o) = ll(200.0, 0.0);
        assert!(
            !idx.contains_built(lat_o, lon_o, 5.0, &mut sc),
            "outside both"
        );
    }

    /// A probe exactly at a footprint's south-west corner latitude (the
    /// horizontal parity ray grazes vertices) stays consistent: the
    /// half-open vertex rule counts a transit vertex once.
    #[test]
    fn parity_ray_through_vertices_is_consistent() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(100.0, 0.0, 40.0), 10.0, ObstacleKind::Building, 1);
        let idx = b.build();
        let mut sc = Vec::new();
        // Probe WEST of the square at exactly the corner row (y = -40 m is a
        // vertex latitude): the horizontal parity ray grazes both corners.
        // OUTSIDE must stay outside despite the graze; a mid-edge-row probe
        // west of the square is outside too; INSIDE stays inside.
        let (corner_lat, west_lon) = (ll(0.0, -40.0).0, ll(-200.0, 0.0).1);
        assert!(!idx.contains_built(corner_lat, west_lon, 5.0, &mut sc));
        let (mid_lat, _unused) = ll(0.0, 0.0);
        assert!(!idx.contains_built(mid_lat, west_lon, 5.0, &mut sc));
        let (in_lat, in_lon) = (ll(100.0, -39.9).0, ll(100.0, 0.0).1);
        assert!(idx.contains_built(in_lat, in_lon, 5.0, &mut sc));
    }

    /// gg case (Codex): a fixed-length cast could END inside a far footprint
    /// and report a phantom "inside". The `footprint_xmin` skip makes a
    /// footprint entirely east of the probe uncountable by construction.
    #[test]
    fn far_footprint_does_not_phantom_capture() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 20.0), 10.0, ObstacleKind::Building, 0);
        // 800 m wide block whose interior would swallow a 2 km ray end.
        b.add_ring(&square(1800.0, 0.0, 400.0), 10.0, ObstacleKind::Building, 1);
        let idx = b.build();
        let mut sc = Vec::new();
        let (plat, plon) = ll(100.0, 0.0); // between the two, inside neither
        assert!(!idx.contains_built(plat, plon, 5.0, &mut sc));
        let (ilat, ilon) = ll(1800.0, 0.0);
        assert!(idx.contains_built(ilat, ilon, 5.0, &mut sc));
    }

    /// gg case (Codex): a footprint WIDER than any fixed cast length must
    /// still read inside near its west wall — the walk bound is derived
    /// from the data (max footprint bbox width), not a constant.
    #[test]
    fn oversized_footprint_still_contained() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 1500.0), 10.0, ObstacleKind::Building, 0);
        let idx = b.build();
        let mut sc = Vec::new();
        let (plat, plon) = ll(-1400.0, 0.0); // 2.9 km from the east wall
        assert!(idx.contains_built(plat, plon, 5.0, &mut sc));
        let (olat, olon) = ll(-1600.0, 0.0);
        assert!(!idx.contains_built(olat, olon, 5.0, &mut sc));
    }

    /// Holes share the outer ring's id: a courtyard probe crosses hole+outer
    /// east walls (even ⇒ outside), a probe between them only the outer wall
    /// (odd ⇒ inside).
    #[test]
    fn courtyard_reads_outside_annulus_inside() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 50.0), 12.0, ObstacleKind::Building, 0);
        b.add_ring(&square(0.0, 0.0, 20.0), 12.0, ObstacleKind::Building, 0);
        let idx = b.build();
        let mut sc = Vec::new();
        assert!(
            !idx.contains_built(OLAT, OLON, 5.0, &mut sc),
            "courtyard centre"
        );
        let (alat, alon) = ll(35.0, 0.0);
        assert!(
            idx.contains_built(alat, alon, 5.0, &mut sc),
            "annulus between hole and outer wall"
        );
    }

    /// gg case (Codex): a TANGENT vertex (both adjacent edges on the same
    /// side of the probe row) must contribute even parity. The half-open
    /// u-rule counted it once; the straddle rule counts both edges or
    /// neither. Apex-down triangle, probe row through the apex.
    #[test]
    fn tangent_vertex_keeps_parity() {
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        let tri = vec![ll(0.0, 0.0), ll(30.0, 40.0), ll(-30.0, 40.0)];
        b.add_ring(&tri, 10.0, ObstacleKind::Building, 0);
        let idx = b.build();
        let mut sc = Vec::new();
        // Probe west of the apex, ON the apex row: both slanted edges cross
        // the row AT the apex — two counts (even), outside. One count would
        // report phantom containment all the way west.
        let (alat, wlon) = (ll(0.0, 0.0).0, ll(-200.0, 0.0).1);
        assert!(!idx.contains_built(alat, wlon, 5.0, &mut sc));
        let (ilat, ilon) = ll(0.0, 20.0);
        assert!(idx.contains_built(ilat, ilon, 5.0, &mut sc), "interior");
    }

    /// 1.4b wrapper: `building_enclosure` answers from the store, every
    /// other lookup delegates to the wrapped sampler unchanged.
    #[test]
    fn vector_reflection_sampler_overrides_only_enclosure() {
        use crate::types::RasterSampler;
        struct Flat;
        impl RasterSampler for Flat {
            fn elevation(&self, _: f64, _: f64) -> f64 {
                123.0
            }
            fn building_height(&self, _: f64, _: f64) -> f64 {
                7.0
            }
            fn ground_g(&self, _: f64, _: f64) -> f64 {
                0.25
            }
            fn building_enclosure(&self, _: f64, _: f64) -> f64 {
                99.0 // sentinel: must never surface through the wrapper
            }
            fn build_path_profile(
                &self,
                _: f64,
                _: f64,
                _: f64,
                _: f64,
                dist_m: f64,
                out: &mut crate::propagation::PathProfile,
            ) {
                // sentinel override: dist_m must round-trip through the
                // wrapper's forwarder (a dropped forwarder would fall back
                // to the trait default and lose the inner override).
                out.dist_m = dist_m * 2.0;
            }
            fn max_building_along_path(
                &self,
                _: f64,
                _: f64,
                _: f64,
                _: f64,
                _: f64,
                _: f64,
            ) -> (f64, f64) {
                (42.0, 0.5)
            }
        }
        // Dense block around the origin ⇒ all nine probes inside ⇒ 3 dB.
        let mut b = ObstacleIndex::builder(OLAT, OLON);
        b.add_ring(&square(0.0, 0.0, 200.0), 12.0, ObstacleKind::Building, 0);
        let set = ObstacleSet {
            indexes: vec![std::sync::Arc::new(b.build())],
        };
        let w = VectorReflectionSampler {
            inner: &Flat,
            set: &set,
        };
        assert_eq!(w.elevation(OLAT, OLON), 123.0);
        assert_eq!(w.building_height(OLAT, OLON), 7.0);
        assert_eq!(w.ground_g(OLAT, OLON), 0.25);
        assert_eq!(w.building_enclosure(OLAT, OLON), 3.0);
        let (far_lat, far_lon) = ll(5_000.0, 5_000.0);
        assert_eq!(w.building_enclosure(far_lat, far_lon), 0.0);
        // The two defaultable methods must forward to the INNER override,
        // not fall back to the trait default (gg review 1.4b #1).
        let mut prof = crate::propagation::PathProfile::new();
        w.build_path_profile(OLAT, OLON, OLAT, OLON, 100.0, &mut prof);
        assert_eq!(prof.dist_m, 200.0);
        assert_eq!(
            w.max_building_along_path(OLAT, OLON, OLAT, OLON, 100.0, 0.0),
            (42.0, 0.5)
        );
    }
}
