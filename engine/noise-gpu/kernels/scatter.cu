// Surface scatter GPU kernels (grows into the full rail kernel per
// docs/dev/gpu-ground-hybrid-plan.md). Ports of the noise-compute CPU path,
// each validated GPU-vs-CPU before the next piece is added. The hot path is already
// fp32 — ray-march rc lerp, bilinear_elev_rc, flc, base/atm_km, fexp; the remaining
// f64 is precision-critical and STAYS (fp32 there flips the LoS gate / reach cull or
// regresses speed — two measured NO-GOs, docs/dev/road-rail-gpu-ledger.md): the reach
// cull, LoS diffraction gate + δ*/fit_plane cancellation, profiles, cadence, budgets.
// Args are packed into a few buffers (cudarc's tuple launch caps at ~12 args).

#define NB 8
#define TPX 512                 // tile side in receiver px — lockstep with
                                // raster-reader/tile-painter TILE_PX (512@z12 shift)
#define M_LAT 110540.0          // M_PER_DEG_LAT
#define M_LON_EQ 111320.0       // M_PER_DEG_LON_EQ
#define LN10 2.302585092994046
#define PI_D 3.141592653589793

__constant__ double A_W[NB]       = {-26.2,-16.1,-8.6,-3.2,0.0,1.2,1.0,-1.1};
__constant__ double ALPHA_ATM[NB] = {0.1,0.4,1.0,1.9,3.7,8.7,22.0,58.4};
__constant__ double BAND_FREQ[NB] = {63.0,125.0,250.0,500.0,1000.0,2000.0,4000.0,8000.0};
__constant__ double GROUND_CF[NB] = {-1.5,-0.7,1.5,2.5,2.0,1.3,0.7,0.2};
__constant__ double ALPHA_VEG[NB] = {0.01,0.015,0.02,0.025,0.03,0.04,0.045,0.06};
__constant__ double MAX_VEG[NB]   = {2.0,3.0,4.0,5.0,6.0,8.0,9.0,12.0};
// Lden period weights = 12/4/8-hour × 0/5/10-dB penalty (10^(p/10)); the shared
// /24 cancels in the skip ratio (scatter_line::LDEN_WEIGHTS).
__constant__ double LDEN_W[3]     = {12.0, 12.649110640673518, 80.0};  // 4·√10
#define UB_SAFETY 1.0001         // inflate UB past fast_exp non-monotonicity
#define SOS 340.0                // SPEED_OF_SOUND
#define SINGLE_DIFF_CAP 20.0     // ISO 9613-2 §7.3 single-edge cap
// CNOSSOS favourable/homogeneous mixing — compile-time mirrors of constants.rs
// (P_FAV, FAVOURABLE_MIXING, FAV_RAY_CURVATURE_*). Flip FAVOURABLE_MIXING to 1
// IN THE SAME commit as the CPU const + rebuild the PTX + re-run e2-full
// CPU≡GPU parity (the plan's G6 gate) — a one-sided flip silently forks the
// physics between lanes.
#define P_FAV 0.5
#define FAVOURABLE_MIXING 1
#define FAV_GAMMA_MIN 1000.0
#define FAV_GAMMA_PER_DSR 8.0
#define CELL_M (110540.0/3600.0) // mirror of path_profile::CELL_M (M_PER_DEG_LAT/3600)
#define NEAR_OFFSET_M 10.0       // near-endpoint probe
#define MAXT 80                  // per-thread profile capacity (fill_t ≤~58 @10km)
// SURFACE-HEATMAP coarse-middle cadence — MUST match the CPU defaults in
// scatter_line.rs (SHADOW_MID_STRIDE / SHADOW_SRC_ZONE_M / SHADOW_RX_ZONE_M) so
// the GPU line lane stays bit-parity with the CPU scatter. The dense 10/30/60/120
// m ramp is kept only within the near-end zone; the far field is coarse-stepped.
// Set stride 1 = exact. NOTE: the GPU has no env knobs — these are the
// compile-time mirror of the CPU env DEFAULTS. If the CPU knobs are tuned,
// re-sync here + rebuild the PTX (then re-check CPU≡GPU parity).
#define SHADOW_MID_STRIDE 3
#define SHADOW_SRC_ZONE_M 600.0
#define SHADOW_RX_ZONE_M 600.0

// ---- raster_reader::FusedGrid::lookup_fused_rc (elevation bilinear) ----
__device__ __forceinline__ double bilinear_elev_d(
    const float* elev, int rows, int cols,
    double lat_min, double lon_min, double inv_cell_deg, double lat, double lon)
{
    double rf = (lat - lat_min) * inv_cell_deg;
    double cf = (lon - lon_min) * inv_cell_deg;
    rf = fmin(fmax(rf, 0.0), (double)(rows - 1));
    cf = fmin(fmax(cf, 0.0), (double)(cols - 1));
    int r0 = min((int)floor(rf), rows - 2);
    int c0 = min((int)floor(cf), cols - 2);
    double fr = rf - (double)r0, fc = cf - (double)c0;
    long base = (long)r0 * cols + c0;
    double e00 = elev[base], e01 = elev[base + 1];
    double e10 = elev[base + cols], e11 = elev[base + cols + 1];
    double v0 = e00 + fc * (e01 - e00);
    double v1 = e10 + fc * (e11 - e10);
    return v0 + fr * (v1 - v0);
}

// ---- noise_compute fast_exp_f64, fp32 internals (exp2f/poly on the SFU; f64
// emulation of exp is the dominant per-source cost on consumer Ada). Arg widened
// in; ~1e-6 drift vs the f64 form, validated against the baseline tile.
__device__ __forceinline__ double fexp(double xd) {
    float x = (float)fmin(fmax(xd, -87.0), 88.0);
    float n = roundf(x * 1.4426950408889634f);   // 1/ln2
    float r = x - n * 0.6931471805599453f;        // ln2
    float r2 = r * r;
    float poly = 1.0f + r + r2 * (0.5f + r * (1.0f/6.0f + r * (1.0f/24.0f + r * (1.0f/120.0f))));
    return (double)(poly * exp2f(n));             // 2^n exact for integer n
}

// ---- geo::point_to_segment_full (the fields the line scatter needs) ----
// Lon-scale `cos` → SFU `__cosf` (1 val/source; ~1e-6 rel err ≪0.5 dB). The
// projection/dot/sqrt stay f64: bisected on the box, an fp32 projection put
// `d_end` within fp32-ε of the per-source reach cull at a handful of cells →
// presence flip → 2.0 dB (>1.5 dB gate). The f64 dot-products are also where
// the only measurable p2s f64 cost lives, so fp32 there bought <1% anyway.
__device__ __forceinline__ void p2s(
    double plat, double plon, double alat, double alon, double blat, double blon,
    double* d_end, double* cplat, double* cplon, double* frac)
{
    double mid = ((alat + blat) * 0.5) * (PI_D / 180.0);
    double mlon = M_LON_EQ * fmax(__cosf((float)mid), 0.01f);
    double bx = (blon - alon) * mlon, by = (blat - alat) * M_LAT;
    double px = (plon - alon) * mlon, py = (plat - alat) * M_LAT;
    double ab = bx * bx + by * by;
    double tu = (ab < 1e-10) ? 0.0 : (px * bx + py * by) / ab;
    double tc = fmin(fmax(tu, 0.0), 1.0);
    double cpx = tc * bx, cpy = tc * by;
    *d_end = sqrt((px - cpx) * (px - cpx) + (py - cpy) * (py - cpy));
    *cplat = alat + tc * (blat - alat);
    *cplon = alon + tc * (blon - alon);
    *frac = tu;
}

// Block-corner radius UPPER BOUND in the p2s metric, for ANY source latitude: the
// longitude leg uses M_LON_EQ (equatorial, cos=1) which is >= every p2s mlon
// (M_LON_EQ·cos(seg_mid)), so reach >= |centre−corner| in the per-pixel cull's OWN
// metric at all latitudes ⇒ the GPU block-bin is a conservative superset everywhere
// (no floor, no per-source recompute). +1 m guards fp ULP. Provenance: path_dist_m
// geometry with cos→1 (docs/dev/gpu-binning-plan.md). dlat in meters, dlon in degrees.
__device__ __forceinline__ double block_reach_ub(double dlat_half_m, double dlon_half_deg) {
    double dlon_m = dlon_half_deg * M_LON_EQ;
    return sqrt(dlat_half_m * dlat_half_m + dlon_m * dlon_m) + 1.0;
}

// ---- geo::finite_line_correction (fp32: ratios + atan, scale-free; logf already f32) ----
__device__ __forceinline__ float flc(float len, float dperp, float frac) {
    if (len < 0.1f || dperp < 0.1f) return 0.0f;
    float d1 = frac * len, d2 = (1.0f - frac) * len, invd = 1.0f / dperp;
    float a1 = d1 * invd, a2 = d2 * invd, prod = a1 * a2;
    float theta = (prod < 0.98f) ? atanf((a1 + a2) / (1.0f - prod)) : (atanf(a1) + atanf(a2));
    float corr = 4.342944819032518f * logf(theta / (float)PI_D);
    return fminf(corr, 0.0f);
}

// ---- raster_reader::lookup_fused_rc (elevation bilinear from row/col coords) ----
// The profile walk lerps (rf,cf) directly (build_path_profile), so this is the
// rc-form of bilinear_elev_d; returns the f32 the CPU profile stores.
__device__ __forceinline__ float bilinear_elev_rc(
    const float* elev, int rows, int cols, float rf, float cf)
{
    rf = fminf(fmaxf(rf, 0.0f), (float)(rows - 1));
    cf = fminf(fmaxf(cf, 0.0f), (float)(cols - 1));
    int r0 = min((int)floorf(rf), rows - 2);
    int c0 = min((int)floorf(cf), cols - 2);
    float fr = rf - (float)r0, fc = cf - (float)c0;
    long base = (long)r0 * cols + c0;
    float v0 = elev[base]        + fc * (elev[base + 1]        - elev[base]);
    float v1 = elev[base + cols] + fc * (elev[base + cols + 1] - elev[base + cols]);
    return v0 + fr * (v1 - v0);
}

// ---- FusedTileZ13::elevation — the production SOURCE-ground lookup. Inside the
// tile bbox: nearest inner-grid cell (latlon_to_inner_idx; DEM bilinear pre-baked
// at the TPX×TPX pixel centres). Outside: halo bilinear. scatter_band reads the
// source ground this way (NOT halo.lookup_fused), so the kernel must too.
//   bb = [north_lat, south_lat, west_lon, east_lon]
__device__ __forceinline__ double tile_elev(
    const float* inner, const float* elev, int rows, int cols,
    double lat_min, double lon_min, double inv, const double* bb,
    double lat, double lon)
{
    if (lat >= bb[1] && lat <= bb[0] && lon >= bb[2] && lon <= bb[3]) {
        double latf = (bb[0] - lat) / (bb[0] - bb[1]);
        double lonf = (lon - bb[2]) / (bb[3] - bb[2]);
        int py = (int)fmin(fmax(floor(latf * (double)TPX), 0.0), (double)(TPX - 1));
        int px = (int)fmin(fmax(floor(lonf * (double)TPX), 0.0), (double)(TPX - 1));
        return inner[py * TPX + px];
    }
    return bilinear_elev_d(elev, rows, cols, lat_min, lon_min, inv, lat, lon);
}

// ---- path_profile::fill_t_values — bilateral adaptive cadence (depends ONLY on
// dist). Fills t[0..n), returns n. Byte-port of the CPU; dedup consecutive <1e-9.
__device__ int fill_t(double dist, double* t) {
    int m = 0;
    bool near = dist >= 3.0 * NEAR_OFFSET_M;
    double near_t = NEAR_OFFSET_M / dist;
    if (dist <= CELL_M * 10.0) {
        int n = (int)ceil(dist / CELL_M); if (n < 3) n = 3;
        t[m++] = 0.0;
        if (near) t[m++] = near_t;
        for (int i = 1; i < n - 1; i++) {
            double tt = (double)i / (double)(n - 1);
            if (near && (fabs(tt - near_t) * dist < 3.0 ||
                         fabs((1.0 - tt) - near_t) * dist < 3.0)) continue;
            t[m++] = tt;
        }
        if (near) t[m++] = 1.0 - near_t;
        t[m++] = 1.0;
    } else {
        // SURFACE coarse-middle (matches CPU fill_t_values_coarse_mid): the dense
        // 10/30/60/120 m ramp is TRUNCATED at the near-end zone and the far field
        // is coarse-stepped at mstride×240 m. stride 1 ⇒ ∞ zone = exact cadence.
        double src_zone_m = 1e30, rx_zone_m = 1e30; int mstride = 1;
        if (SHADOW_MID_STRIDE > 1) {
            src_zone_m = SHADOW_SRC_ZONE_M; rx_zone_m = SHADOW_RX_ZONE_M; mstride = SHADOW_MID_STRIDE;
        }
        t[m++] = 0.0;
        if (near) t[m++] = near_t;
        double levels[4] = {CELL_M, CELL_M * 2.0, CELL_M * 4.0, CELL_M * 8.0};
        double pos = near ? NEAR_OFFSET_M : 0.0;
        double last_fwd = pos;  // last COMMITTED ramp sample (bridge origin)
        for (int L = 0; L < 4; L++) {
            int brk = 0;
            for (int r = 0; r < 3; r++) {
                pos += levels[L];
                if (pos >= dist * 0.5 || pos > src_zone_m) { brk = 1; break; }
                t[m++] = pos / dist; last_fwd = pos;
            }
            if (brk) break;
        }
        // Exact (mstride==1): clamp to midpoint; coarse: bridge from last pushed
        // sample (pos over-steps by one increment on the break → a >coarse hole).
        double fwd_end = (mstride > 1) ? (last_fwd / dist) : (fmin(pos, dist * 0.5) / dist);
        double coarse = fmin(levels[3] * (double)mstride, dist * 0.25);
        // Backward ramp start (where the far-field fill stops): mirror of forward.
        double bpos = near ? NEAR_OFFSET_M : 0.0;
        for (int L = 0; L < 4; L++) {
            int brk = 0;
            for (int r = 0; r < 3; r++) {
                double next = bpos + levels[L];
                if (next >= dist * 0.5 || next > rx_zone_m) { brk = 1; break; }
                bpos = next;
            }
            if (brk) break;
        }
        double bwd_start = fmax(1.0 - bpos / dist, 0.5);
        // The only dist-unbounded loop: reserve room for the ≤14 remaining
        // backward-ramp + endpoint pushes so a pathological dist can't overflow
        // t[MAXT]. Never triggers for the ≤10 km reach the cadence sees.
        double mid = fwd_end;
        while (mid < bwd_start - 0.0001 && m < MAXT - 16) {
            mid += coarse / dist;
            if (mid < bwd_start - 1e-9) t[m++] = mid;
        }
        int bstart = m, bcount = 0;
        pos = near ? NEAR_OFFSET_M : 0.0;
        for (int L = 0; L < 4; L++) {
            int brk = 0;
            for (int r = 0; r < 3; r++) {
                pos += levels[L];
                if (pos >= dist * 0.5 || pos > rx_zone_m) { brk = 1; break; }
                t[m++] = 1.0 - pos / dist; bcount++;
            }
            if (brk) break;
        }
        for (int i = 0; i < bcount / 2; i++) {
            double tmp = t[bstart + i];
            t[bstart + i] = t[bstart + bcount - 1 - i];
            t[bstart + bcount - 1 - i] = tmp;
        }
        if (near) t[m++] = 1.0 - near_t;
        t[m++] = 1.0;
    }
    int w = 0;
    for (int i = 0; i < m; i++) if (w == 0 || fabs(t[i] - t[w - 1]) >= 1e-9) t[w++] = t[i];
    return w;
}

// ---- horizon::max_delta_idx — edge of largest path-length difference δ over
// 1..n-1 among samples above the source→receiver LOS; -1 if path clear.
// Stable-δ in fp32: δ = d_sb+d_br−dsr rewritten as Σ dz²/(d+x) so the near-equal
// large distances never cancel (a naive fp32 cast drifted ~1500 cells). dsg+drg
// = dist EXACTLY via drg = dist−dsg; the LoS gate stays f64 (exact candidate
// selection); height diffs widen exactly from the f32 profile.
__device__ int mdidx(const double* t, const double* prof, int n,
                      double dist, double se, double re, double dsr) {
    int best = -1; float bestd = 0.0f;
    float distf = (float)dist;
    float dzsr = (float)(re - se);
    float third = dzsr * dzsr / (float)(dsr + dist);
    for (int i = 1; i < n - 1; i++) {
        double topd = prof[i];
        if (topd <= se + (re - se) * t[i]) continue;
        float ti = (float)t[i];
        float dsg = ti * distf, drg = distf - dsg;
        float dzsb = (float)(topd - se), dzbr = (float)(topd - re);
        float dsb = sqrtf(dsg * dsg + dzsb * dzsb);
        float dbr = sqrtf(drg * drg + dzbr * dzbr);
        float delta = dzsb * dzsb / (dsb + dsg) + dzbr * dzbr / (dbr + drg) - third;
        if (delta > bestd) { bestd = delta; best = i; }
    }
    return best;
}

// ---- diffraction::fit_plane — OLS line over samples [lo,hi] (x = (t−t_off)·dist).
__device__ void fit_plane(const double* t, const double* prof, int lo, int hi,
                          double t_off, double dist, double* a, double* b) {
    double nn = (double)(hi - lo + 1);
    double sx = 0, sz = 0, sxx = 0, sxz = 0;
    for (int i = lo; i <= hi; i++) {
        double x = (t[i] - t_off) * dist, z = prof[i];
        sx += x; sz += z; sxx += x * x; sxz += x * z;
    }
    double denom = nn * sxx - sx * sx;
    if (fabs(denom) < 1e-9) { *a = 0.0; *b = sz / nn; return; }
    *a = (nn * sxz - sx * sz) / denom;
    *b = (sz - (*a) * sx) / nn;
}

// ---- diffraction::fit_plane_with_point — fit_plane + the diffraction point D
// folded into the regression (the explicit-edge δ* fits, SPEC §3.5b: D
// joins BOTH mean planes exactly once).
__device__ void fit_plane_pt(const double* t, const double* prof, int lo, int hi,
                             double extra_t, double extra_z,
                             double t_off, double dist, double* a, double* b) {
    double sx = 0, sz = 0, sxx = 0, sxz = 0;
    double nn = 0.0;
    for (int i = lo; i < hi; i++) {
        double x = (t[i] - t_off) * dist, z = prof[i];
        sx += x; sz += z; sxx += x * x; sxz += x * z; nn += 1.0;
    }
    { // the D point
        double x = (extra_t - t_off) * dist;
        sx += x; sz += extra_z; sxx += x * x; sxz += x * extra_z; nn += 1.0;
    }
    double denom = nn * sxx - sx * sx;
    if (fabs(denom) < 1e-9) { *a = 0.0; *b = sz / nn; return; }
    *a = (nn * sxz - sx * sz) / denom;
    *b = (sz - (*a) * sx) / nn;
}

// ---- diffraction::compute_single_edge_at δ* part — explicit edge (t_e over
// LERPed bare ground), strict partitions (src side t < t_e, rcv side t > t_e),
// D in both fits. Mirrors the CPU in f64 (mod nvcc FMA contraction; the
// e2-full vector run gates the result).
__device__ double dstar_at(const double* t, const double* bare, int n, double t_e,
                           double dist, double src_h, double rcv_h) {
    double d_sg = t_e * dist, d_rg = (1.0 - t_e) * dist;
    // partition points: p_lo = first i with t[i] >= t_e; p_hi = first i with t[i] > t_e
    int p_lo = 0; while (p_lo < n && t[p_lo] < t_e) p_lo++;
    int p_hi = 0; while (p_hi < n && t[p_hi] <= t_e) p_hi++;
    // bare ground under the edge, LERPed between neighbours (i1 = clamp(p_hi,1,n-1))
    int i1 = p_hi < 1 ? 1 : (p_hi > n - 1 ? n - 1 : p_hi);
    double t0 = t[i1 - 1], t1 = t[i1];
    double frac = (t1 > t0) ? fmin(fmax((t_e - t0) / (t1 - t0), 0.0), 1.0) : 0.0;
    double d_top = bare[i1 - 1] + frac * (bare[i1] - bare[i1 - 1]);
    double a_s, b_s; fit_plane_pt(t, bare, 0, p_lo, t_e, d_top, 0.0, dist, &a_s, &b_s);
    double a_r, b_r; fit_plane_pt(t, bare, p_hi, n, t_e, d_top, t_e, dist, &a_r, &b_r);
    double plane_rcv_end = a_r * d_rg + b_r;
    double s_star = 2.0 * b_s - ((double)bare[0] + src_h);
    double r_star = 2.0 * plane_rcv_end - ((double)bare[n - 1] + rcv_h);
    double d_sd = sqrt(d_sg * d_sg + (d_top - s_star) * (d_top - s_star));
    double d_dr = sqrt(d_rg * d_rg + (r_star - d_top) * (r_star - d_top));
    double d_sr = sqrt(dist * dist + (r_star - s_star) * (r_star - s_star));
    double v = d_sd + d_dr - d_sr;
    return v > 0.0 ? v : 0.0;
}

// ---- obstacle_index::segment_intersection_t — chainage of ray×edge, t strictly
// inside (0,1), hit within the segment (u ∈ [0,1] inclusive), collinear → none.
__device__ __forceinline__ bool seg_isect_t(
    double sx, double sy, double dx, double dy,
    double x0, double y0, double x1, double y1, double* t_out)
{
    double ex = x1 - x0, ey = y1 - y0;
    double denom = dx * ey - dy * ex;
    if (denom == 0.0) return false;
    double wx = x0 - sx, wy = y0 - sy;
    double tt = (wx * ey - wy * ex) / denom;
    double u = (wx * dy - wy * dx) / denom;
    if (tt > 0.0 && tt < 1.0 && u >= 0.0 && u <= 1.0) { *t_out = tt; return true; }
    return false;
}

// ---- ObstacleSet::crossings + path_effects §5b fused for the GPU: walk every
// per-cell index's grid along the ray (the same Amanatides & Woo shape and
// clamps as the CPU walk), and for each exact crossing evaluate the candidate
// δ ON THE FLY (terrain LERPed between the ray's bare samples, LOS-gated),
// keeping only the max-δ winner — no sort, no dedup (duplicate hits evaluate
// identically, max() is idempotent), no dynamic memory. `obst` is the
// pointer-table {n, metas, starts, refs, edges, cell_max_h} built by
// gpu_surface (slot 5 == 0 ⇒ branch-and-bound pruning disabled).
// Exclusion radius: the GPU lanes are line layers (roads/rail), which pass 0
// on the CPU too — no gate here by construction.
__device__ void obstacle_best_candidate(
    const unsigned long long* obst,
    double src_lat, double src_lon, double rcv_lat, double rcv_lon,
    const double* t, const double* bare, int n,
    double dist, double se, double re, double dsr,
    int* have, double* cand_t, double* cand_top)
{
    *have = 0;
    double best_delta = 0.0;
    int n_idx = (int)obst[0];
    const double* metas = (const double*)obst[1];
    const unsigned int* starts = (const unsigned int*)obst[2];
    const unsigned int* refs = (const unsigned int*)obst[3];
    const float* edges = (const float*)obst[4];
    const float* maxh = (const float*)obst[5];
    // Branch-and-bound prune inputs (z13 plan E2): the best candidate a cell
    // can produce is bounded by the profile's max bare elevation plus the
    // cell's max edge height; δ(t, top) is CONVEX in t for a fixed top, so
    // its max over the cell's chainage interval sits at an endpoint — the
    // bound is exact, never approximate.
    double terr_max = bare[0];
    for (int i = 1; i < n; i++) terr_max = fmax(terr_max, bare[i]);
    for (int gi = 0; gi < n_idx; gi++) {
        const double* m = &metas[gi * 13];
        double mlon = m[2], cell = m[3], minx = m[4], miny = m[5];
        int cols = (int)m[6], rows = (int)m[7];
        size_t soff = (size_t)m[8], roff = (size_t)m[9], eoff = (size_t)m[10];
        size_t hoff = (size_t)m[12];
        double sx = (src_lon - m[1]) * mlon, sy = (src_lat - m[0]) * M_LAT;
        double rx = (rcv_lon - m[1]) * mlon, ry = (rcv_lat - m[0]) * M_LAT;
        double dx = rx - sx, dy = ry - sy;
        // Slab reject (GPU-only perf; results identical — edges only exist
        // inside the grid): a ray whose bbox misses this index's extent
        // cannot cross any of its edges. A typical region holds 7 per-cell
        // indexes and a ray touches 1–3.
        double gx1 = minx + (double)cols * cell, gy1 = miny + (double)rows * cell;
        if (fmax(sx, rx) < minx || fmin(sx, rx) > gx1 ||
            fmax(sy, ry) < miny || fmin(sy, ry) > gy1) continue;
        double inv_cell = 1.0 / cell;
        long cx = (long)floor((sx - minx) * inv_cell); cx = cx < 0 ? 0 : (cx > cols - 1 ? cols - 1 : cx);
        long cy = (long)floor((sy - miny) * inv_cell); cy = cy < 0 ? 0 : (cy > rows - 1 ? rows - 1 : cy);
        long end_cx = (long)floor((rx - minx) * inv_cell); end_cx = end_cx < 0 ? 0 : (end_cx > cols - 1 ? cols - 1 : end_cx);
        long end_cy = (long)floor((ry - miny) * inv_cell); end_cy = end_cy < 0 ? 0 : (end_cy > rows - 1 ? rows - 1 : end_cy);
        long step_x = dx >= 0.0 ? 1 : -1, step_y = dy >= 0.0 ? 1 : -1;
        double t_delta_x = dx != 0.0 ? fabs(cell / dx) : 1e300;
        double t_delta_y = dy != 0.0 ? fabs(cell / dy) : 1e300;
        double next_xb = minx + (double)(cx + (dx >= 0.0 ? 1 : 0)) * cell;
        double next_yb = miny + (double)(cy + (dy >= 0.0 ? 1 : 0)) * cell;
        double t_max_x = dx != 0.0 ? fabs((next_xb - sx) / dx) : 1e300;
        double t_max_y = dy != 0.0 ? fabs((next_yb - sy) / dy) : 1e300;
        long guard = (long)cols + (long)rows + 4;
        double t_enter = 0.0;
        while (1) {
            size_t c = (size_t)cy * (size_t)cols + (size_t)cx;
            unsigned int lo = starts[soff + c], hi = starts[soff + c + 1];
            // Exact cell prune (maxh == NULL ⇒ pruning disabled — the host
            // writes slot 5 as 0 under NOISE_GPU_DISABLE_PRUNE=1, an
            // incident A/B lever that needs no rebuild).
            // top_bound = terr_max + cell max edge height
            // (+1e-9 m outward slack so no f64 rounding chain — e.g. the
            // terrain LERP exceeding terr_max by an ulp — can push a real
            // candidate above the bound). Validity: δ(t, top) as a function
            // of top is strictly convex with its MINIMUM exactly on the LOS
            // (both direction cosines cancel there), so every edge the exact
            // loop admits (top > los) has δ increasing in top ⇒ δ ≤ δ(top_bound).
            // In t, δ(·, top_bound) is convex ⇒ its max over the cell's
            // chainage interval sits at an endpoint. An edge shared with a
            // later cell whose crossing lies outside this interval is listed
            // (supercover) and re-found in the cell that owns the crossing,
            // so skipping here never loses it. Skips: LOS skip mirrors the
            // exact loop's `top <= los` discard; the best-candidate skip is
            // STRICT `<` — a bound that can still TIE must walk the edges,
            // because the winner rule prefers lower t among f64-equal δ.
            if (hi > lo && maxh) {
                double t_exit = fmin(fmin(t_max_x, t_max_y), 1.0);
                double t_a = fmin(fmax(t_enter, 0.0), 1.0);
                double top_bound = terr_max + (double)maxh[hoff + c] + 1e-9;
                double los_min = fmin(se + (re - se) * t_a, se + (re - se) * t_exit);
                if (top_bound <= los_min) { lo = hi; }
                else if (*have) {
                    double d_bound = 0.0;
                    for (int ep = 0; ep < 2; ep++) {
                        double tt = ep == 0 ? t_a : t_exit;
                        double d_sg = tt * dist, d_rg = (1.0 - tt) * dist;
                        double d = sqrt(d_sg * d_sg + (top_bound - se) * (top_bound - se))
                                 + sqrt(d_rg * d_rg + (top_bound - re) * (top_bound - re)) - dsr;
                        d_bound = fmax(d_bound, d);
                    }
                    // DELTA-space slack, not just the height bump above: the
                    // two-sqrt-minus-dsr evaluation cancels near grazing and
                    // its f64 result can land ~1e-12 m BELOW the exact loop's
                    // candidate δ (measured by direct IEEE evaluation — gg
                    // z13 impl review, Codex #4); dδ/dtop ≈ 0 there, so the
                    // 1e-9 m height slack adds ~nothing. 1e-9 m of δ dwarfs
                    // the whole rounding chain (eps·10^5 m ≈ 2e-11) and is
                    // physically nil.
                    if (d_bound + 1e-9 < best_delta) { lo = hi; }
                }
            }
            for (unsigned int k = lo; k < hi; k++) {
                const float* e = &edges[(eoff + (size_t)refs[roff + k]) * 5];
                double tt;
                if (!seg_isect_t(sx, sy, dx, dy,
                                 (double)e[0], (double)e[1], (double)e[2], (double)e[3], &tt))
                    continue;
                // path_effects §5b: terrain LERP between neighbouring bare
                // samples (p = first sample with t > tt, clamped to [1, n-1]).
                int p = 1; while (p < n - 1 && t[p] <= tt) p++;
                double t0 = t[p - 1], t1 = t[p];
                double frac = (t1 > t0) ? (tt - t0) / (t1 - t0) : 0.0;
                double terr = bare[p - 1] + frac * (bare[p] - bare[p - 1]);
                double top = terr + (double)e[4];
                double los = se + (re - se) * tt;
                if (top <= los) continue;
                double d_sg = tt * dist, d_rg = (1.0 - tt) * dist;
                double delta = sqrt(d_sg * d_sg + (top - se) * (top - se))
                             + sqrt(d_rg * d_rg + (top - re) * (top - re)) - dsr;
                // Strict max + lower-t tie-break: the CPU walks candidates
                // t-sorted and keeps the FIRST max (path_effects §5b), i.e.
                // the lowest-t among f64-equal δ; DDA discovery order is not
                // t-sorted across edges, so break ties explicitly. Bounded
                // deviation vs CPU (documented, gg review 2026-07-28 #4): a
                // vertex double-hit (two edges of one ring at the same point)
                // is collapsed to one candidate by the CPU's (id,t) dedup but
                // evaluated twice here — the two δ agree to the last ulp, so
                // only an ulp-level tie can pick the other edge of the SAME
                // geometry; the bands are identical to fp32.
                if (!*have || delta > best_delta ||
                    (delta == best_delta && tt < *cand_t)) {
                    *have = 1; best_delta = delta; *cand_t = tt; *cand_top = top;
                }
            }
            if ((cx == end_cx && cy == end_cy) || guard <= 0) break;
            guard--;
            t_enter = fmin(t_max_x, t_max_y);
            if (t_max_x < t_max_y) { t_max_x += t_delta_x; cx += step_x; }
            else                   { t_max_y += t_delta_y; cy += step_y; }
            if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) break;
        }
    }
}

// ---- diffraction::compute_delta_star — CNOSSOS §2.5.6(c) Rayleigh δ* (mirror
// source/receiver across per-side mean-ground planes; OLS on BARE earth).
__device__ double dstar(const double* t, const double* prof, int n, int d_idx,
                        double dist, double src_h, double rcv_h) {
    double dsg = t[d_idx] * dist, drg = (1.0 - t[d_idx]) * dist;
    double a_s, b_s; fit_plane(t, prof, 0, d_idx, 0.0, dist, &a_s, &b_s);
    double a_r, b_r; fit_plane(t, prof, d_idx, n - 1, t[d_idx], dist, &a_r, &b_r);
    double plane_rcv_end = a_r * drg + b_r;
    double s_star = 2.0 * b_s - ((double)prof[0] + src_h);
    double r_star = 2.0 * plane_rcv_end - ((double)prof[n - 1] + rcv_h);
    double d_top = prof[d_idx];
    double d_sd = sqrt(dsg * dsg + (d_top - s_star) * (d_top - s_star));
    double d_dr = sqrt(drg * drg + (r_star - d_top) * (r_star - d_top));
    double d_sr = sqrt(dist * dist + (r_star - s_star) * (r_star - s_star));
    double v = d_sd + d_dr - d_sr;
    return v > 0.0 ? v : 0.0;
}

// ---- diffraction::maekawa_bands (single edge, cap 20). fp32.
__device__ void maek_single(float delta, float dstar_v, float* bands) {
    for (int i = 0; i < NB; i++) bands[i] = 0.0f;
    if (delta <= 0.0f) return;
    for (int i = 0; i < NB; i++) {
        float lambda = (float)(SOS / BAND_FREQ[i]);
        if (delta <= lambda * 0.25f - dstar_v) continue;
        float a_bar = 10.0f * log10f(3.0f + 20.0f * delta * (float)BAND_FREQ[i] / (float)SOS);
        bands[i] = fminf(a_bar, (float)SINGLE_DIFF_CAP);
    }
}

// ---- diffraction::curved_path_difference + mix_fav_hom shared tail: hom
// bands from (delta, δ*), favourable bands from the curved-ray δ_F over the
// SAME chords, then the P_FAV energy mix ((2.5.24)/(2.5.25)/(2.5.9)). Chords
// + arc difference in f64: the near-equal-kilometres cancellation loses ~4
// digits — fatal in fp32 (the mdidx lesson), comfortable in f64. Mix itself
// is dB-scale fp32.
__device__ void maek_mixed(float delta, float dstar_v,
                           double dsb_d, double dbr_d, double dsr, float* out) {
    maek_single(delta, dstar_v, out);
    if (FAVOURABLE_MIXING) {
        double gamma = fmax(FAV_GAMMA_MIN, FAV_GAMMA_PER_DSR * dsr);
        double delta_f = 2.0 * gamma * (asin(dsb_d / (2.0 * gamma))
            + asin(dbr_d / (2.0 * gamma)) - asin(dsr / (2.0 * gamma)));
        float fav[NB];
        maek_single((float)delta_f, dstar_v, fav);
        for (int i = 0; i < NB; i++) {
            float e = (float)P_FAV * exp10f(-fav[i] * 0.1f)
                + (1.0f - (float)P_FAV) * exp10f(-out[i] * 0.1f);
            out[i] = -10.0f * log10f(e);
        }
    }
}

// ---- horizon::single_edge_atten + path_effects §5b/5c — the shared single-δ
// primitive with VECTOR-candidate competition. δ geometry + max-δ edge run on
// `top`; the §2.5.6(c) Rayleigh δ* OLS always on `bare`. Heights above bare
// earth (0.05 / 0.5 floors). A vector candidate (exact crossing at cand_t,
// absolute top cand_top — from obstacle_best_candidate) competes with the
// cadence sample edge ON δ (the actual selection criterion); the winner's
// bands are emitted. Candidate δ* uses the explicit-edge fits with D in both
// planes (dstar_at). Writes 8 bands. Terrain calls it with top==bare and no
// candidate; screening with top==composite, bare==elevation.
__device__ void single_edge_bands_cand(const double* t, const double* top, const double* bare,
                                       int n, double dist, double src_alt, double rcv_alt,
                                       int have_cand, double cand_t, double cand_top,
                                       float* out) {
    for (int i = 0; i < NB; i++) out[i] = 0.0f;
    double src_h = fmax(src_alt - bare[0], 0.05);
    double rcv_h = fmax(rcv_alt - bare[n - 1], 0.5);
    double se = bare[0] + src_h, re = bare[n - 1] + rcv_h;
    double dsr = sqrt(dist * dist + (re - se) * (re - se));
    int idx = mdidx(t, top, n, dist, se, re, dsr);
    bool sample_ok = idx >= 0 && top[idx] > se + (re - se) * t[idx];
    float delta_samp = 0.0f;
    double s_dsb_d = 0.0, s_dbr_d = 0.0, s_delta_d = 0.0;
    if (sample_ok) {
        // stable-δ in fp32 (same reformulation as mdidx); δ* stays f64 (1× per edge).
        float distf = (float)dist, ti = (float)t[idx];
        float dsg = ti * distf, drg = distf - dsg;
        float dzsb = (float)(top[idx] - se), dzbr = (float)(top[idx] - re), dzsr = (float)(re - se);
        float dsb = sqrtf(dsg * dsg + dzsb * dzsb), dbr = sqrtf(drg * drg + dzbr * dzbr);
        delta_samp = dzsb * dzsb / (dsb + dsg) + dzbr * dzbr / (dbr + drg)
                   - dzsr * dzsr / (float)(dsr + dist);
        // f64 chords: reused by the favourable arc AND the winner compare —
        // the CPU compares two f64 deltas (path_effects §5c), so deciding on
        // the fp32 stable form would flip near-ties (gg review 2026-07-28 #3).
        double dsg_d = t[idx] * dist, drg_d = dist - dsg_d;
        double dzsb_d = top[idx] - se, dzbr_d = top[idx] - re;
        s_dsb_d = sqrt(dsg_d * dsg_d + dzsb_d * dzsb_d);
        s_dbr_d = sqrt(drg_d * drg_d + dzbr_d * dzbr_d);
        s_delta_d = s_dsb_d + s_dbr_d - dsr;
    }
    if (have_cand) {
        // path_effects §5c: candidate vs cadence edge, by δ in f64 (both
        // above-LOS by construction; the candidate was LOS-gated in the DDA).
        double d_sg = cand_t * dist, d_rg = (1.0 - cand_t) * dist;
        double dsb_d = sqrt(d_sg * d_sg + (cand_top - se) * (cand_top - se));
        double dbr_d = sqrt(d_rg * d_rg + (cand_top - re) * (cand_top - re));
        double delta_cand = dsb_d + dbr_d - dsr;
        if (!sample_ok || delta_cand > s_delta_d) {
            float dstar_v = (float)dstar_at(t, bare, n, cand_t, dist, src_h, rcv_h);
            maek_mixed((float)delta_cand, dstar_v, dsb_d, dbr_d, dsr, out);
            return;
        }
    }
    if (!sample_ok) return;
    float dstar_v = (float)dstar(t, bare, n, idx, dist, src_h, rcv_h);
    maek_mixed(delta_samp, dstar_v, s_dsb_d, s_dbr_d, dsr, out);
}

__device__ __forceinline__ void single_edge_bands(const double* t, const double* top,
                                                  const double* bare, int n, double dist,
                                                  double src_alt, double rcv_alt, float* out) {
    single_edge_bands_cand(t, top, bare, n, dist, src_alt, rcv_alt, 0, 0.0, 0.0, out);
}

// ---- path_effects::terrain_attenuation — bare-earth diffraction. Guard (short
// path) + the "any sample above LoS" hill scan, then the single-edge primitive.
__device__ void terrain_bands(const double* t, const double* prof, int n,
                              double dist, double src_alt, double rcv_alt, float* out) {
    for (int i = 0; i < NB; i++) out[i] = 0.0f;
    if (n < 3 || dist < 30.0) return;
    double dz_total = rcv_alt - src_alt;
    bool hill = false;
    for (int i = 0; i < n; i++) if (prof[i] > src_alt + dz_total * t[i]) { hill = true; break; }
    if (!hill) return;
    single_edge_bands(t, prof, prof, n, dist, src_alt, rcv_alt, out);
}

// ---- raster_reader::lookup_fused_rc categoricals: building/forest NEAREST,
// imd BILINEAR (round, clamp). `cover` is the halo packed [build,forest,imd] per cell.
__device__ __forceinline__ void cover_rc(
    const unsigned char* cover, int rows, int cols, float rf, float cf,
    unsigned char* bh, unsigned char* fr_out, unsigned char* imd_out)
{
    rf = fminf(fmaxf(rf, 0.0f), (float)(rows - 1));
    cf = fminf(fmaxf(cf, 0.0f), (float)(cols - 1));
    int r0 = min((int)floorf(rf), rows - 2);
    int c0 = min((int)floorf(cf), cols - 2);
    float fr = rf - (float)r0, fc = cf - (float)c0;
    long base = (long)r0 * cols + c0;
    long b00 = base*3, b01 = (base+1)*3, b10 = (base+cols)*3, b11 = (base+cols+1)*3;
    long near = (fr >= 0.5f) ? ((fc >= 0.5f) ? b11 : b10) : ((fc >= 0.5f) ? b01 : b00);
    *bh = cover[near]; *fr_out = cover[near + 1];
    float v0 = (float)cover[b00+2] + fc * ((float)cover[b01+2] - (float)cover[b00+2]);
    float v1 = (float)cover[b10+2] + fc * ((float)cover[b11+2] - (float)cover[b10+2]);
    float im = fminf(fmaxf(roundf(v0 + fr * (v1 - v0)), 0.0f), 255.0f);
    *imd_out = (unsigned char)im;
}

// ---- path_profile::path_integral_u8 (interval-length-weighted mean of imd).
// `fill_t` guarantees t[0]=0,t[n-1]=1 ⇒ Σ(t[i]−t[i−1])=1 ⇒ the CPU's `sum·dist /
// (total=dist)` collapses to the t-weighted mean Σ mid·(t[i]−t[i−1]); the `dist`
// and the `total` accumulator/division cancel exactly. fp32 (imd∈[0,255]).
__device__ float path_integral_imd(const double* t, const unsigned char* imd, int n) {
    if (n < 2) return 0.0f;
    float sum = 0.0f;
    for (int i = 1; i < n; i++) {
        float mid = 0.5f * ((float)imd[i - 1] + (float)imd[i]);
        sum += mid * (float)(t[i] - t[i - 1]);
    }
    return sum;
}

// ---- path_profile::vegetation_run_length — density-weighted forest depth
// (geodata-v2 2a): the ≥10 m scattered-tree gate stays on the PHYSICAL run
// extent, the accumulated depth is `len × v/100`. On binary rasters
// (v ∈ {0,100}) bit-identical to the old boolean run (100/100.0f = 1.0f
// exactly); output changes only when continuous density tiles land. fp32.
__device__ float veg_run_length(const double* t, const unsigned char* forest, int n, float dist) {
    if (n < 2) return 0.0f;
    float total = 0.0f, run_phys = 0.0f, run_w = 0.0f;
    for (int i = 1; i < n; i++) {
        float len = (float)(t[i] - t[i - 1]) * dist;
        if (forest[i] > 0) {
            run_phys += len;
            // __fmul_rn/__fadd_rn pin plain IEEE mul+add (no FMA
            // contraction): len × 1.0f is exact, so on binary rasters the
            // accumulation is bit-identical to the old `run += len`.
            run_w = __fadd_rn(run_w, __fmul_rn(len, (float)forest[i] / 100.0f));
        } else {
            if (run_phys >= 10.0f) total += run_w;
            run_phys = 0.0f; run_w = 0.0f;
        }
    }
    if (run_phys >= 10.0f) total += run_w;
    return total;
}

// ---- vegetation::vegetation_attenuation (per-band, capped). fp32.
__device__ void veg_bands(float depth, float* out) {
    for (int i = 0; i < NB; i++)
        out[i] = (depth <= 0.0f) ? 0.0f : fminf((float)ALPHA_VEG[i] * depth, (float)MAX_VEG[i]);
}

#define BIN_W 16                 // pixel-bin edge (16×16 patch = one CUDA block)
#define BIN_TILES (TPX / BIN_W)  // 32 bins per axis, 1024 bins per tile

// ── One source's contribution to one receiver pixel: geometry → energy-budget
// skip → cadence ray-march → terrain/screening/ground/veg → max(A_gr,A_bar)
// combine → accumulate 3-period energy (f32) + kept (f64). Shared by `line`
// (scans all sources) and `line_binned` (scans a block's pre-binned list). seg/sp
// point at THIS source's 4-tuple, em at its 24 emission bands; e0..e2/kept/skipped
// are the caller's per-pixel running state. Returns on reach-cull or budget-skip.
__device__ __forceinline__ void line_source(
    const float* elev, const float* inner, const unsigned char* cover,
    int rows, int cols, double lat_min, double lon_min, double inv, const double* bb,
    double rlat, double rlon, double ralt, double refl, double eta,
    const double* seg, const double* sp, const float* em,
    const double* barr, int nbarr, const unsigned long long* obst,
    double* tprof, double* ed, double* comp,
    unsigned char* bld, unsigned char* forr, unsigned char* imdp,
    float& e0, float& e1, float& e2, double& kept, double& skipped)
{
    double dend, cplat, cplon, frac;
    p2s(rlat, rlon, seg[0], seg[1], seg[2], seg[3], &dend, &cplat, &cplon, &frac);
    if (dend > sp[1]) return;   // exact per-pixel reach cull (matches scatter_band)
    double salt = tile_elev(inner, elev, rows, cols, lat_min, lon_min, inv, bb, cplat, cplon) + sp[2];
    double dz = salt - ralt;
    float dslant = fmaxf((float)sqrt(dend * dend + dz * dz), 1.0f);
    float fc = flc((float)sp[0], (float)dend, (float)fmin(fmax(frac, 0.0), 1.0));
    float base = (float)refl + fc - 10.0f * log10f(2.0f * (float)PI_D * dslant);
    float atm_km = dslant / 1000.0f;

    // energy-budget skip (kept/skipped/ub f64 — the ratio needs the precision).
    // The per-band Lden weight Σ_p LDEN_W[p]·em[p·8+i] is host-precomputed into
    // sp[4+i] (pack_sources) — same f64 FMA, hoisted off the per-source×receiver hot
    // path. Byte-identical to the in-kernel `LDEN_W[0]*em[i]+…` form.
    double ub = 0.0;
    for (int i = 0; i < NB; i++) {
        float gg_ub = fmaxf(-(float)GROUND_CF[i], 0.0f);
        float pdb = (base - (float)ALPHA_ATM[i] * atm_km + gg_ub + (float)A_W[i]) * (float)LN10 * 0.1f;
        ub += sp[4 + i] * fexp((double)pdb);
    }
    ub *= UB_SAFETY;
    if (skipped + ub <= eta * kept) { skipped += ub; return; }

    // halo-RELATIVE ray coords (src centroid → receiver). The per-sample ray delta
    // `d_rf` is ≲326 cells/10 km; the absolute `src_rf` is ≤~8000 cells even for a
    // 4×4-tile + 10 km batch, where fp32 ULP is ~1.5 cm ≪ the 30 m cell — so the lerp
    // runs in fp32 directly (mm–cm accurate; NOT incremental: `+=` would drift + break
    // the sample↔t[i] tie). The f64 ORIGIN subtractions (cplat−lat_min, absolute
    // lat/lon) stay f64, cast once.
    float src_rf = (float)((cplat - lat_min) * inv), src_cf = (float)((cplon - lon_min) * inv);
    float d_rf = (float)((rlat - cplat) * inv), d_cf = (float)((rlon - cplon) * inv);

    // ray-march the cadence: bare elevation + building/forest/imd, in halo-RELATIVE
    // raster coords (coords computed above).
    int n = fill_t(dend, tprof);
    for (int i = 0; i < n; i++) {
        float rf = src_rf + (float)tprof[i] * d_rf, cf = src_cf + (float)tprof[i] * d_cf;
        ed[i] = (double)bilinear_elev_rc(elev, rows, cols, rf, cf);
        cover_rc(cover, rows, cols, rf, cf, &bld[i], &forr[i], &imdp[i]);
    }

    // ---- path_effects::screening_attenuation_with_meta §1 — VECTOR barriers.
    // Project each tile barrier midpoint onto THIS propagation ray (closest
    // point cplat/cplon → receiver), snap to the nearest tprof sample, keep the
    // tallest per sample. NEVER a raster read — the building-channel burn
    // under-screens 3.7–13.8 dB because the ray cadence steps over a one-cell
    // wall (decision record: tile-painter tests/barrier_screening.rs).
    // barr = nbarr×4 {lat, lon, height_m, dist_m}: the for_tile() slice, dist_m
    // a conservative lower bound sorted ascending — the same `types::Barrier`
    // early-break contract the CPU loop uses (`dist_m > dend+100` → break).
    // Lon scale = RAY midpoint cosine (CPU: (src_lat+rcv_lat)/2), NOT the p2s
    // road-segment midpoint; __cosf + clamp follow the p2s house style (≤1e-6
    // rel vs the CPU's f64 cos — sub-mm on a 10 km path).
    bool barrier_hit = false;
    float barr_at[MAXT];
    for (int i = 0; i < n; i++) barr_at[i] = 0.0f;
    if (nbarr > 0 && barr[3] <= dend + 100.0) {
        double ray_mid = ((cplat + rlat) * 0.5) * (PI_D / 180.0);
        double ray_mlon = M_LON_EQ * fmax(__cosf((float)ray_mid), 0.01f);
        double pdx = (rlon - cplon) * ray_mlon, pdy = (rlat - cplat) * M_LAT;
        double plen2 = fmax(pdx * pdx + pdy * pdy, 1e-12);
        for (int b = 0; b < nbarr; b++) {
            if (barr[b * 4 + 3] > dend + 100.0) break;
            double bdx = (barr[b * 4 + 1] - cplon) * ray_mlon;
            double bdy = (barr[b * 4 + 0] - cplat) * M_LAT;
            double tpj = (bdx * pdx + bdy * pdy) / plen2;
            if (!(tpj >= 0.01 && tpj <= 0.99)) continue;      // CPU inclusive gate
            double ex = bdx - tpj * pdx, ey = bdy - tpj * pdy;
            if (ex * ex + ey * ey >= 50.0 * 50.0) continue;   // 50 m perp, `>=` rejects
            // Nearest tprof sample (n ≤ ~58, linear scan); strict `<` keeps the
            // LOWER index on ties — matches nearest_t_index's bracket pick.
            int idx = 0; double bestd = fabs(tprof[0] - tpj);
            for (int j = 1; j < n; j++) {
                double dd = fabs(tprof[j] - tpj);
                if (dd < bestd) { bestd = dd; idx = j; }
            }
            float h = (float)barr[b * 4 + 2];
            if (h > barr_at[idx]) barr_at[idx] = h;
            barrier_hit = true;
        }
    }

    // path effects (bands in fp32)
    float terr[NB], screen[NB], veg[NB];
    terrain_bands(tprof, ed, n, dend, salt, ralt, terr);
    for (int i = 0; i < NB; i++) screen[i] = 0.0f;
    // Vector obstacles (geodata-v2, QM_VECTOR_BUILDINGS=1): exact crossings
    // REPLACE the raster building channel (path_effects
    // replace_sample_buildings) — the composite keeps only barriers, and the
    // max-δ candidate from the obstacle grids competes with the cadence edge.
    bool vec_mode = obst[0] != 0ULL;
    int have_cand = 0;
    double cand_t = 0.0, cand_top = 0.0;
    if (vec_mode && n >= 3 && dend >= 30.0) {
        double src_h = fmax(salt - ed[0], 0.05);
        double rcv_h = fmax(ralt - ed[n - 1], 0.5);
        double se = ed[0] + src_h, re = ed[n - 1] + rcv_h;
        double dsr = sqrt(dend * dend + (re - se) * (re - se));
        obstacle_best_candidate(obst, cplat, cplon, rlat, rlon,
                                tprof, ed, n, dend, se, re, dsr,
                                &have_cand, &cand_t, &cand_top);
    }
    // A barrier over open ground has no building cell — it must enable the
    // screening pass too, or walls outside towns are silently ignored.
    bool anyb = barrier_hit || have_cand;
    if (!vec_mode)
        for (int i = 0; i < n; i++) if (bld[i] > 0) { anyb = true; break; }
    if (anyb && n >= 3 && dend >= 30.0) {
        for (int i = 0; i < n; i++) {
            // Endpoint exclusion (tprof ∈ (0,1)) applies to building AND
            // barrier: a wall snapped onto an endpoint sample must not screen
            // (the CPU composite gate, path_effects.rs §3).
            double bh = vec_mode ? 0.0 : (double)bld[i];
            double above = (tprof[i] > 0.0 && tprof[i] < 1.0)
                         ? fmax(bh, (double)barr_at[i]) : 0.0;
            comp[i] = ed[i] + above;
        }
        float comb[NB];
        single_edge_bands_cand(tprof, comp, ed, n, dend, salt, ralt,
                               have_cand, cand_t, cand_top, comb);
        for (int i = 0; i < NB; i++) screen[i] = fmaxf(comb[i] - terr[i], 0.0f);
    }
    float gimd = path_integral_imd(tprof, imdp, n);
    float ground_g = (sp[3] != 0.0) ? 0.0f : fminf(fmaxf(1.0f - gimd / 100.0f, 0.0f), 1.0f);
    veg_bands(veg_run_length(tprof, forr, n, (float)dend), veg);

    float pf[NB];
    for (int i = 0; i < NB; i++) {
        float a_gr = (float)GROUND_CF[i] * ground_g;
        float a_bar = terr[i] + screen[i];
        float gob = (a_bar > 0.0f) ? fmaxf(a_gr, a_bar) : a_gr;   // barrier REPLACES ground
        float pdb = (base - (float)ALPHA_ATM[i] * atm_km - gob - veg[i] + (float)A_W[i]) * (float)LN10 * 0.1f;
        pf[i] = (float)fexp((double)pdb);
    }
    double kept_add = 0.0;   // summed over periods then added once (matches scatter_band)
    for (int p = 0; p < 3; p++) {
        double power = 0.0;
        for (int i = 0; i < NB; i++) power += (double)em[p*8 + i] * pf[i];
        if (isfinite(power) && power > 0.0) {
            float pw = (float)power;
            if (p == 0) e0 += pw; else if (p == 1) e1 += pw; else e2 += pw;
            kept_add += power * LDEN_W[p];
        }
    }
    kept += kept_add;
}

// RAIL scatter: free-field + terrain diffraction + building screening + ground +
// vegetation, combined max(A_ground,A_terrain+A_screen) (ISO 9613-2 §7.3.1), with
// the per-pixel energy-budget skip. Thread-per-pixel; mirrors scatter_band
// (sources in array order, per-thread kept/skipped). Tiled (swizzled) pixel
// mapping (meta[10]=tile width) keeps each block's rays' terrain L2-hot. Scans
// ALL sources (reach cull is inside line_source); `line_binned` is the pre-binned
// variant. Per-period energy in f32 (matching TileAccumulator), kept in f64.
//   meta = [rows, cols, lat_min, lon_min, inv, north, south, west, east, eta,
//           tile_width, nbarr, nsrc]
//   inner = TPX×TPX tile DEM; cover = halo [building,forest,imd] u8; sp = nsrc×4.
//   barr = nbarr×4 {lat, lon, height_m, dist_m} — this tile's sorted for_tile()
//   barrier slice (nbarr in meta[11]). obst = the vector-obstacle pointer
//   table {n, metas, starts, refs, edges} (obst[0]==0 ⇒ raster mode); nsrc
//   rides in meta[12] because cudarc's tuple launch caps at 12 args.
extern "C" __global__ void line(
    const float*  __restrict__ elev,
    const float*  __restrict__ inner,
    const unsigned char* __restrict__ cover,
    const double* __restrict__ meta,
    const double* __restrict__ seg,
    const double* __restrict__ sp,
    const float*  __restrict__ semis,
    const double* __restrict__ rxll,
    const float*  __restrict__ rxar,
    const double* __restrict__ barr,
    const unsigned long long* __restrict__ obst,
    float* __restrict__ out)
{
    int pix = blockIdx.x * blockDim.x + threadIdx.x;
    if (pix >= TPX * TPX) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    const double* bb = &meta[5];   // north_lat, south_lat, west_lon, east_lon
    double eta = meta[9];
    int nsrc = (int)meta[12];
    // Tiled (swizzled) pixel mapping: consecutive threads fill a 16×16 pixel tile
    // before the next, so each warp/block covers a COMPACT 2D region — its rays to a
    // given source overlap, keeping the terrain halo L2-hot. Row-major decomposition
    // gave each warp a 32-wide stripe whose rays fanned out. Output is
    // identical; only the memory access pattern changes.
    int TW = (int)meta[10], TPR = TPX / TW;   // tile width (swept; must divide TPX)
    int tl = pix / (TW * TW), it = pix % (TW * TW);
    int py = (tl / TPR) * TW + it / TW;
    int pxi = (tl % TPR) * TW + it % TW;
    int opix = py * TPX + pxi;   // actual pixel index (rxar/out are pixel-indexed)
    double rlat = rxll[py], rlon = rxll[TPX + pxi];
    double ralt = rxar[opix * 2], refl = rxar[opix * 2 + 1];
    int nbarr = (int)meta[11];
    float e0 = 0.0f, e1 = 0.0f, e2 = 0.0f;
    double kept = 0.0, skipped = 0.0;
    double tprof[MAXT], ed[MAXT], comp[MAXT];
    unsigned char bld[MAXT], forr[MAXT], imdp[MAXT];

    for (int s = 0; s < nsrc; s++)
        line_source(elev, inner, cover, rows, cols, lat_min, lon_min, inv, bb,
                    rlat, rlon, ralt, refl, eta, &seg[s * 4], &sp[s * 12], &semis[s * 24],
                    barr, nbarr, obst,
                    tprof, ed, comp, bld, forr, imdp, e0, e1, e2, kept, skipped);
    out[opix * 3 + 0] = e0;
    out[opix * 3 + 1] = e1;
    out[opix * 3 + 2] = e2;
}

// Binned scatter — bins ON the GPU (deletes the CPU build_pixel_bins prep, the
// gpu-surface bottleneck). Same 16×16-block / 256-thread mapping as line_binned, but
// instead of a CPU CSR bin it scans all nsrc sources in 256-source CHUNKS: the 256
// lanes cull one chunk cooperatively (one source per lane) into shared keep[256],
// then REPLAY that chunk in source order, each thread (= its own pixel) calling
// line_source only on survivors. cos=1 block radius (block_reach_ub) is a universal
// upper bound on the p2s block-corner distance ⇒ conservative superset at every
// latitude; the per-pixel cull in line_source stays authoritative; the 0..nsrc
// ordered replay preserves the order-dependent energy-budget skip ⇒ byte-identical
// to `line`. One cull per source (not once per pixel), fixed BIN_W²-byte shared,
// no atomics.
// See docs/dev/gpu-binning-plan.md.
extern "C" __global__ void __launch_bounds__(BIN_W * BIN_W, 2) line_binned_fused(
    const float*  __restrict__ elev,
    const float*  __restrict__ inner,
    const unsigned char* __restrict__ cover,
    const double* __restrict__ meta,
    const double* __restrict__ seg,
    const double* __restrict__ sp,
    const float*  __restrict__ semis,
    const double* __restrict__ rxll,
    const float*  __restrict__ rxar,
    const double* __restrict__ barr,
    const unsigned long long* __restrict__ obst,
    float* __restrict__ out)
{
    int bid = blockIdx.x, lane = threadIdx.x;
    if (bid >= BIN_TILES * BIN_TILES || lane >= BIN_W * BIN_W) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    const double* bb = &meta[5];
    double eta = meta[9];
    int nsrc = (int)meta[12];
    int by = bid / BIN_TILES, bx = bid % BIN_TILES;
    int py0 = by * BIN_W, py1 = by * BIN_W + BIN_W - 1;
    int px0 = bx * BIN_W, px1 = bx * BIN_W + BIN_W - 1;
    int py = py0 + lane / BIN_W, pxi = px0 + lane % BIN_W;
    int opix = py * TPX + pxi;
    double rlat = rxll[py], rlon = rxll[TPX + pxi];
    double ralt = rxar[opix * 2], refl = rxar[opix * 2 + 1];
    int nbarr = (int)meta[11];
    float e0 = 0.0f, e1 = 0.0f, e2 = 0.0f;
    double kept = 0.0, skipped = 0.0;
    double tprof[MAXT], ed[MAXT], comp[MAXT];
    unsigned char bld[MAXT], forr[MAXT], imdp[MAXT];

    // Block centre + cos=1 radius UB — once per thread (all lanes agree, no divergence).
    double clat = 0.5 * (rxll[py0] + rxll[py1]);
    double clon = 0.5 * (rxll[TPX + px0] + rxll[TPX + px1]);
    double reach = block_reach_ub(0.5 * fabs(rxll[py1] - rxll[py0]) * M_LAT,
                                  0.5 * fabs(rxll[TPX + px1] - rxll[TPX + px0]));
    __shared__ unsigned char keep[BIN_W * BIN_W];
    for (int base = 0; base < nsrc; base += BIN_W * BIN_W) {
        int s = base + lane;
        keep[lane] = 0;
        if (s < nsrc) {
            double de, cpa, cpo, fr;
            p2s(clat, clon, seg[s * 4], seg[s * 4 + 1], seg[s * 4 + 2], seg[s * 4 + 3],
                &de, &cpa, &cpo, &fr);
            keep[lane] = (de <= sp[s * 12 + 1] + reach) ? 1 : 0;
        }
        __syncthreads();
        int chunk_n = min(BIN_W * BIN_W, nsrc - base);
        for (int j = 0; j < chunk_n; ++j)
            if (keep[j])
                line_source(elev, inner, cover, rows, cols, lat_min, lon_min, inv, bb,
                            rlat, rlon, ralt, refl, eta, &seg[(base + j) * 4],
                            &sp[(base + j) * 12], &semis[(base + j) * 24],
                            barr, nbarr, obst,
                            tprof, ed, comp, bld, forr, imdp, e0, e1, e2, kept, skipped);
        __syncthreads();
    }
    out[opix * 3 + 0] = e0;
    out[opix * 3 + 1] = e1;
    out[opix * 3 + 2] = e2;
}
