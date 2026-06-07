// Surface scatter GPU kernels (grows into the full rail kernel per
// docs/dev/gpu-ground-hybrid-plan.md). Ports of the noise-compute CPU path,
// each validated GPU-vs-CPU before the next piece is added. Everything fp64 here
// to isolate the port from precision; fp32 + stable-δ comes with the DDA pass.
// Args are packed into a few buffers (cudarc's tuple launch caps at ~12 args).

#define NB 8
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
#define CELL_M (110540.0/3600.0) // raster cell ≈30.7m (1 arc-sec)
#define NEAR_OFFSET_M 10.0       // near-endpoint probe
#define MAXT 80                  // per-thread profile capacity (fill_t ≤~58 @10km)

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

// Standalone bilinear kernel (validated GPU-vs-CPU in e2-gpu).
extern "C" __global__ void bilinear_elev(
    const float* __restrict__ elev, int rows, int cols,
    double lat_min, double lon_min, double inv_cell_deg,
    const double* __restrict__ qlat, const double* __restrict__ qlon, int nq,
    float* __restrict__ out)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= nq) return;
    out[i] = (float)bilinear_elev_d(elev, rows, cols, lat_min, lon_min, inv_cell_deg, qlat[i], qlon[i]);
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
// at the 256×256 pixel centres). Outside: halo bilinear. scatter_band reads the
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
        int py = (int)fmin(fmax(floor(latf * 256.0), 0.0), 255.0);
        int px = (int)fmin(fmax(floor(lonf * 256.0), 0.0), 255.0);
        return inner[py * 256 + px];
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
        t[m++] = 0.0;
        if (near) t[m++] = near_t;
        double levels[4] = {CELL_M, CELL_M * 2.0, CELL_M * 4.0, CELL_M * 8.0};
        double pos = near ? NEAR_OFFSET_M : 0.0;
        for (int L = 0; L < 4; L++) {
            for (int r = 0; r < 3; r++) {
                pos += levels[L];
                if (pos >= dist * 0.5) break;
                t[m++] = pos / dist;
            }
            if (pos >= dist * 0.5) break;
        }
        double fwd_end = fmin(pos, dist * 0.5) / dist;
        double coarse = fmin(levels[3], dist * 0.25);
        double mid = fwd_end, bwd_start = 1.0 - fwd_end;
        // The only dist-unbounded loop: reserve room for the ≤14 remaining
        // backward-ramp + endpoint pushes so a pathological dist can't overflow
        // t[MAXT]. Never triggers for the ≤10 km reach the cadence sees (≤57).
        while (mid < bwd_start - 0.0001 && m < MAXT - 16) { mid += coarse / dist; if (mid < bwd_start) t[m++] = mid; }
        int bstart = m, bcount = 0;
        pos = near ? NEAR_OFFSET_M : 0.0;
        for (int L = 0; L < 4; L++) {
            for (int r = 0; r < 3; r++) {
                pos += levels[L];
                if (pos >= dist * 0.5) break;
                t[m++] = 1.0 - pos / dist; bcount++;
            }
            if (pos >= dist * 0.5) break;
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

// ---- diffraction::maekawa_bands (single edge: is_double=false ⇒ c3=1, cap 20). fp32.
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

// ---- horizon::single_edge_atten — the shared single-δ primitive. δ geometry +
// max-δ edge run on `top`; the §2.5.6(c) Rayleigh δ* OLS always on `bare`. Heights
// above bare earth (0.05 / 0.5 floors). Writes 8 bands. Terrain calls it with
// top==bare; screening with top==composite, bare==elevation.
__device__ void single_edge_bands(const double* t, const double* top, const double* bare,
                                  int n, double dist, double src_alt, double rcv_alt, float* out) {
    for (int i = 0; i < NB; i++) out[i] = 0.0f;
    double src_h = fmax(src_alt - bare[0], 0.05);
    double rcv_h = fmax(rcv_alt - bare[n - 1], 0.5);
    double se = bare[0] + src_h, re = bare[n - 1] + rcv_h;
    double dsr = sqrt(dist * dist + (re - se) * (re - se));
    int idx = mdidx(t, top, n, dist, se, re, dsr);
    if (idx < 0) return;
    if (top[idx] <= se + (re - se) * t[idx]) return;
    // stable-δ in fp32 (same reformulation as mdidx); δ* stays f64 (1× per edge).
    float distf = (float)dist, ti = (float)t[idx];
    float dsg = ti * distf, drg = distf - dsg;
    float dzsb = (float)(top[idx] - se), dzbr = (float)(top[idx] - re), dzsr = (float)(re - se);
    float dsb = sqrtf(dsg * dsg + dzsb * dzsb), dbr = sqrtf(drg * drg + dzbr * dzbr);
    float delta = dzsb * dzsb / (dsb + dsg) + dzbr * dzbr / (dbr + drg) - dzsr * dzsr / (float)(dsr + dist);
    maek_single(delta, (float)dstar(t, bare, n, idx, dist, src_h, rcv_h), out);
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

// ---- path_profile::vegetation_run_length — cumulative forest run (≥10 m runs). fp32.
__device__ float veg_run_length(const double* t, const unsigned char* forest, int n, float dist) {
    if (n < 2) return 0.0f;
    float total = 0.0f, run = 0.0f;
    for (int i = 1; i < n; i++) {
        float len = (float)(t[i] - t[i - 1]) * dist;
        if (forest[i] > 0) run += len;
        else { if (run >= 10.0f) total += run; run = 0.0f; }
    }
    if (run >= 10.0f) total += run;
    return total;
}

// ---- vegetation::vegetation_attenuation (per-band, capped). fp32.
__device__ void veg_bands(float depth, float* out) {
    for (int i = 0; i < NB; i++)
        out[i] = (depth <= 0.0f) ? 0.0f : fminf((float)ALPHA_VEG[i] * depth, (float)MAX_VEG[i]);
}

// FREE-FIELD rail scatter: geometry + cylindrical divergence + FLC + air + 8-band
// emission; NO terrain/screening/ground/veg and NO budget skip (every source
// evaluated). One thread per receiver pixel; 3-period energy out. Matches the CPU
// free-field exactly to isolate the geometry+physics port from the coming DDA.
//   meta = [rows, cols, lat_min, lon_min, inv_cell_deg]
//   seg  = nsrc×4  {alat, alon, blat, blon}
//   sp   = nsrc×3  {length_m, max_distance_m, source_height_m}
//   semis= nsrc×24 {day[8], evening[8], night[8]} linear band energy
//   rxll = 256 rx_lat ++ 256 rx_lon ;  rxar = npix×2 {rx_alt, rx_refl}
extern "C" __global__ void freefield_rail(
    const float*  __restrict__ elev,
    const double* __restrict__ meta,
    const double* __restrict__ seg,
    const double* __restrict__ sp,
    const float*  __restrict__ semis,
    const double* __restrict__ rxll,
    const float*  __restrict__ rxar,
    int nsrc, float* __restrict__ out)
{
    int pix = blockIdx.x * blockDim.x + threadIdx.x;
    if (pix >= 256 * 256) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    int py = pix >> 8, pxi = pix & 255;
    double rlat = rxll[py], rlon = rxll[256 + pxi];
    double ralt = rxar[pix * 2], refl = rxar[pix * 2 + 1];
    double e0 = 0.0, e1 = 0.0, e2 = 0.0;

    for (int s = 0; s < nsrc; s++) {
        double dend, cplat, cplon, frac;
        p2s(rlat, rlon, seg[s*4], seg[s*4+1], seg[s*4+2], seg[s*4+3], &dend, &cplat, &cplon, &frac);
        if (dend > sp[s*3+1]) continue;
        double salt = bilinear_elev_d(elev, rows, cols, lat_min, lon_min, inv, cplat, cplon) + sp[s*3+2];
        double dz = salt - ralt;
        double dslant = fmax(sqrt(dend * dend + dz * dz), 1.0);
        float fc = flc((float)sp[s*3], (float)dend, (float)fmin(fmax(frac, 0.0), 1.0));
        double base = refl + (double)fc - 10.0 * log10(2.0 * PI_D * dslant);
        double atm_km = dslant / 1000.0;
        const float* em = &semis[s * 24];
        for (int i = 0; i < NB; i++) {
            double pf = fexp((base - ALPHA_ATM[i] * atm_km + A_W[i]) * LN10 * 0.1);
            e0 += (double)em[i]      * pf;
            e1 += (double)em[8 + i]  * pf;
            e2 += (double)em[16 + i] * pf;
        }
    }
    out[pix * 3 + 0] = (float)e0;
    out[pix * 3 + 1] = (float)e1;
    out[pix * 3 + 2] = (float)e2;
}

#define BIN_W 8                  // pixel-bin edge (8×8 patch = one CUDA block)
#define BIN_TILES (256 / BIN_W)  // 32 bins per axis, 1024 bins per tile

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

    // energy-budget skip (kept/skipped/ub f64 — the ratio needs the precision)
    double ub = 0.0;
    for (int i = 0; i < NB; i++) {
        float gg_ub = fmaxf(-(float)GROUND_CF[i], 0.0f);
        double em_lden = LDEN_W[0]*(double)em[i] + LDEN_W[1]*(double)em[8+i] + LDEN_W[2]*(double)em[16+i];
        float pdb = (base - (float)ALPHA_ATM[i] * atm_km + gg_ub + (float)A_W[i]) * (float)LN10 * 0.1f;
        ub += em_lden * fexp((double)pdb);
    }
    ub *= UB_SAFETY;
    if (skipped + ub <= eta * kept) { skipped += ub; return; }

    // ray-march the cadence: bare elevation + building/forest/imd, in halo-RELATIVE
    // raster coords. The per-sample ray delta `d_rf` is ≲326 cells/10 km; the
    // absolute `src_rf` is ≤~8000 cells even for a 4×4-tile + 10 km batch, where fp32
    // ULP is ~1.5 cm ≪ the 30 m cell — so the lerp runs in fp32 directly (mm–cm
    // accurate; NOT incremental: `+=` would drift + break the sample↔t[i] tie). The
    // f64 ORIGIN subtractions (cplat−lat_min, absolute lat/lon) stay f64, cast once.
    float src_rf = (float)((cplat - lat_min) * inv), src_cf = (float)((cplon - lon_min) * inv);
    float d_rf = (float)((rlat - cplat) * inv), d_cf = (float)((rlon - cplon) * inv);
    int n = fill_t(dend, tprof);
    for (int i = 0; i < n; i++) {
        float rf = src_rf + (float)tprof[i] * d_rf, cf = src_cf + (float)tprof[i] * d_cf;
        ed[i] = (double)bilinear_elev_rc(elev, rows, cols, rf, cf);
        cover_rc(cover, rows, cols, rf, cf, &bld[i], &forr[i], &imdp[i]);
    }

    // path effects (bands in fp32)
    float terr[NB], screen[NB], veg[NB];
    terrain_bands(tprof, ed, n, dend, salt, ralt, terr);
    for (int i = 0; i < NB; i++) screen[i] = 0.0f;
    bool anyb = false;
    for (int i = 0; i < n; i++) if (bld[i] > 0) { anyb = true; break; }
    if (anyb && n >= 3 && dend >= 30.0) {
        for (int i = 0; i < n; i++)
            comp[i] = ed[i] + ((tprof[i] > 0.0 && tprof[i] < 1.0) ? (double)bld[i] : 0.0);
        float comb[NB];
        single_edge_bands(tprof, comp, ed, n, dend, salt, ralt, comb);
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
//   meta = [rows, cols, lat_min, lon_min, inv, north, south, west, east, eta, tile_width]
//   inner = 256×256 tile DEM; cover = halo [building,forest,imd] u8; sp = nsrc×4.
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
    int nsrc, float* __restrict__ out)
{
    int pix = blockIdx.x * blockDim.x + threadIdx.x;
    if (pix >= 256 * 256) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    const double* bb = &meta[5];   // north_lat, south_lat, west_lon, east_lon
    double eta = meta[9];
    // Tiled (swizzled) pixel mapping: consecutive threads fill a 16×16 pixel tile
    // before the next, so each warp/block covers a COMPACT 2D region — its rays to a
    // given source overlap, keeping the terrain halo L2-hot. Row-major (pix>>8,
    // pix&255) gave each warp a 32-wide stripe whose rays fanned out. Output is
    // identical; only the memory access pattern changes.
    int TW = (int)meta[10], TPR = 256 / TW;   // tile width (swept; must divide 256)
    int tl = pix / (TW * TW), it = pix % (TW * TW);
    int py = (tl / TPR) * TW + it / TW;
    int pxi = (tl % TPR) * TW + it % TW;
    int opix = py * 256 + pxi;   // actual pixel index (rxar/out are pixel-indexed)
    double rlat = rxll[py], rlon = rxll[256 + pxi];
    double ralt = rxar[opix * 2], refl = rxar[opix * 2 + 1];
    float e0 = 0.0f, e1 = 0.0f, e2 = 0.0f;
    double kept = 0.0, skipped = 0.0;
    double tprof[MAXT], ed[MAXT], comp[MAXT];
    unsigned char bld[MAXT], forr[MAXT], imdp[MAXT];

    for (int s = 0; s < nsrc; s++)
        line_source(elev, inner, cover, rows, cols, lat_min, lon_min, inv, bb,
                    rlat, rlon, ralt, refl, eta, &seg[s * 4], &sp[s * 4], &semis[s * 24],
                    tprof, ed, comp, bld, forr, imdp, e0, e1, e2, kept, skipped);
    out[opix * 3 + 0] = e0;
    out[opix * 3 + 1] = e1;
    out[opix * 3 + 2] = e2;
}

// RAIL scatter with CPU-precomputed 8×8 pixel source bins — the big lever on the
// pixel-major GPU: don't scan all sources per pixel (the CPU's source-major
// reach-box already avoids that). One CUDA block owns one 8×8 receiver patch (64
// threads = 64 pixels) and iterates only bin_indices[bin_offsets[bid] .. bid+1] —
// the conservative source list whose reach can intersect the patch. The bin is a
// conservative superset in ORIGINAL source order, and the exact per-pixel cull in
// line_source still runs, so each pixel sees exactly its reachable sources in the
// same order ⇒ kept/skipped parity ⇒ identical output to `rail`.
// __launch_bounds__(64 threads/block, 8 blocks/SM) caps registers at 128 (65536/SM
// ÷ 512 threads), lifting occupancy from ~12 to 16 warps/SM with zero spill (verified
// ptxas -v). The kernel is f64-ALU/SFU bound, so this only helps where latency hiding
// matters — measured, not assumed.
extern "C" __global__ void __launch_bounds__(BIN_W * BIN_W, 8) line_binned(
    const float*  __restrict__ elev,
    const float*  __restrict__ inner,
    const unsigned char* __restrict__ cover,
    const double* __restrict__ meta,
    const double* __restrict__ seg,
    const double* __restrict__ sp,
    const float*  __restrict__ semis,
    const double* __restrict__ rxll,
    const float*  __restrict__ rxar,
    const int* __restrict__ bin_offsets,
    const int* __restrict__ bin_indices,
    float* __restrict__ out)
{
    int bid = blockIdx.x, lane = threadIdx.x;
    if (bid >= BIN_TILES * BIN_TILES || lane >= BIN_W * BIN_W) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    const double* bb = &meta[5];
    double eta = meta[9];
    int by = bid / BIN_TILES, bx = bid % BIN_TILES;
    int py = by * BIN_W + lane / BIN_W, pxi = bx * BIN_W + lane % BIN_W;
    int opix = py * 256 + pxi;
    double rlat = rxll[py], rlon = rxll[256 + pxi];
    double ralt = rxar[opix * 2], refl = rxar[opix * 2 + 1];
    float e0 = 0.0f, e1 = 0.0f, e2 = 0.0f;
    double kept = 0.0, skipped = 0.0;
    double tprof[MAXT], ed[MAXT], comp[MAXT];
    unsigned char bld[MAXT], forr[MAXT], imdp[MAXT];
    int s0 = bin_offsets[bid], s1 = bin_offsets[bid + 1];
    for (int si = s0; si < s1; si++) {
        int s = bin_indices[si];
        line_source(elev, inner, cover, rows, cols, lat_min, lon_min, inv, bb,
                    rlat, rlon, ralt, refl, eta, &seg[s * 4], &sp[s * 4], &semis[s * 24],
                    tprof, ed, comp, bld, forr, imdp, e0, e1, e2, kept, skipped);
    }
    out[opix * 3 + 0] = e0;
    out[opix * 3 + 1] = e1;
    out[opix * 3 + 2] = e2;
}

// FUSED variant — bins ON the GPU (deletes the CPU build_pixel_bins prep, the
// gpu-surface bottleneck). Same 8×8-block / 64-thread mapping as line_binned, but
// instead of a CPU CSR bin it scans all nsrc sources in 64-source CHUNKS: the 64
// lanes cull one chunk cooperatively (one source per lane) into shared keep[64],
// then REPLAY that chunk in source order, each thread (= its own pixel) calling
// line_source only on survivors. cos=1 block radius (block_reach_ub) is a universal
// upper bound on the p2s block-corner distance ⇒ conservative superset at every
// latitude; the per-pixel cull in line_source stays authoritative; the 0..nsrc
// ordered replay preserves the order-dependent energy-budget skip ⇒ byte-identical
// to `line`. One cull per source (not 64×), fixed 64-byte shared, no atomics.
// See docs/dev/gpu-binning-plan.md.
extern "C" __global__ void __launch_bounds__(BIN_W * BIN_W, 8) line_binned_fused(
    const float*  __restrict__ elev,
    const float*  __restrict__ inner,
    const unsigned char* __restrict__ cover,
    const double* __restrict__ meta,
    const double* __restrict__ seg,
    const double* __restrict__ sp,
    const float*  __restrict__ semis,
    const double* __restrict__ rxll,
    const float*  __restrict__ rxar,
    int nsrc, float* __restrict__ out)
{
    int bid = blockIdx.x, lane = threadIdx.x;
    if (bid >= BIN_TILES * BIN_TILES || lane >= BIN_W * BIN_W) return;
    int rows = (int)meta[0], cols = (int)meta[1];
    double lat_min = meta[2], lon_min = meta[3], inv = meta[4];
    const double* bb = &meta[5];
    double eta = meta[9];
    int by = bid / BIN_TILES, bx = bid % BIN_TILES;
    int py0 = by * BIN_W, py1 = by * BIN_W + BIN_W - 1;
    int px0 = bx * BIN_W, px1 = bx * BIN_W + BIN_W - 1;
    int py = py0 + lane / BIN_W, pxi = px0 + lane % BIN_W;
    int opix = py * 256 + pxi;
    double rlat = rxll[py], rlon = rxll[256 + pxi];
    double ralt = rxar[opix * 2], refl = rxar[opix * 2 + 1];
    float e0 = 0.0f, e1 = 0.0f, e2 = 0.0f;
    double kept = 0.0, skipped = 0.0;
    double tprof[MAXT], ed[MAXT], comp[MAXT];
    unsigned char bld[MAXT], forr[MAXT], imdp[MAXT];

    // Block centre + cos=1 radius UB — once per thread (all lanes agree, no divergence).
    double clat = 0.5 * (rxll[py0] + rxll[py1]);
    double clon = 0.5 * (rxll[256 + px0] + rxll[256 + px1]);
    double reach = block_reach_ub(0.5 * fabs(rxll[py1] - rxll[py0]) * M_LAT,
                                  0.5 * fabs(rxll[256 + px1] - rxll[256 + px0]));
    __shared__ unsigned char keep[BIN_W * BIN_W];
    for (int base = 0; base < nsrc; base += BIN_W * BIN_W) {
        int s = base + lane;
        keep[lane] = 0;
        if (s < nsrc) {
            double de, cpa, cpo, fr;
            p2s(clat, clon, seg[s * 4], seg[s * 4 + 1], seg[s * 4 + 2], seg[s * 4 + 3],
                &de, &cpa, &cpo, &fr);
            keep[lane] = (de <= sp[s * 4 + 1] + reach) ? 1 : 0;
        }
        __syncthreads();
        int chunk_n = min(BIN_W * BIN_W, nsrc - base);
        for (int j = 0; j < chunk_n; ++j)
            if (keep[j])
                line_source(elev, inner, cover, rows, cols, lat_min, lon_min, inv, bb,
                            rlat, rlon, ralt, refl, eta, &seg[(base + j) * 4],
                            &sp[(base + j) * 4], &semis[(base + j) * 24],
                            tprof, ed, comp, bld, forr, imdp, e0, e1, e2, kept, skipped);
        __syncthreads();
    }
    out[opix * 3 + 0] = e0;
    out[opix * 3 + 1] = e1;
    out[opix * 3 + 2] = e2;
}
