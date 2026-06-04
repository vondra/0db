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

// ---- noise_compute fast_exp_f64 ----
__device__ __forceinline__ double fexp(double x) {
    x = fmin(fmax(x, -87.0), 88.0);
    double n = round(x * 1.4426950408889634);   // 1/ln2
    double r = x - n * 0.6931471805599453;       // ln2
    double r2 = r * r;
    double poly = 1.0 + r + r2 * (0.5 + r * (1.0/6.0 + r * (1.0/24.0 + r * (1.0/120.0))));
    return poly * exp2(n);                        // 2^n exact for integer n
}

// ---- geo::point_to_segment_full (the fields the line scatter needs) ----
__device__ __forceinline__ void p2s(
    double plat, double plon, double alat, double alon, double blat, double blon,
    double* d_end, double* cplat, double* cplon, double* frac)
{
    double mid = ((alat + blat) * 0.5) * (PI_D / 180.0);
    double mlon = M_LON_EQ * fmax(cos(mid), 0.01);
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

// ---- geo::finite_line_correction ----
__device__ __forceinline__ double flc(double len, double dperp, double frac) {
    if (len < 0.1 || dperp < 0.1) return 0.0;
    double d1 = frac * len, d2 = (1.0 - frac) * len, invd = 1.0 / dperp;
    double a1 = d1 * invd, a2 = d2 * invd, prod = a1 * a2;
    double theta = (prod < 0.98) ? atan((a1 + a2) / (1.0 - prod)) : (atan(a1) + atan(a2));
    double corr = 4.342944819032518 * log(theta / PI_D);
    return fmin(corr, 0.0);
}

// ---- raster_reader::lookup_fused_rc (elevation bilinear from row/col coords) ----
// The profile walk lerps (rf,cf) directly (build_path_profile), so this is the
// rc-form of bilinear_elev_d; returns the f32 the CPU profile stores.
__device__ __forceinline__ float bilinear_elev_rc(
    const float* elev, int rows, int cols, double rf, double cf)
{
    rf = fmin(fmax(rf, 0.0), (double)(rows - 1));
    cf = fmin(fmax(cf, 0.0), (double)(cols - 1));
    int r0 = min((int)floor(rf), rows - 2);
    int c0 = min((int)floor(cf), cols - 2);
    double fr = rf - (double)r0, fc = cf - (double)c0;
    long base = (long)r0 * cols + c0;
    double v0 = elev[base]       + fc * (elev[base + 1]        - elev[base]);
    double v1 = elev[base + cols] + fc * (elev[base + cols + 1] - elev[base + cols]);
    return (float)(v0 + fr * (v1 - v0));
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
__device__ int mdidx(const double* t, const float* prof, int n,
                      double dist, double se, double re, double dsr) {
    int best = -1; double bestd = 0.0;
    for (int i = 1; i < n - 1; i++) {
        double top = prof[i];
        double los = se + (re - se) * t[i];
        if (top <= los) continue;
        double dsg = t[i] * dist, drg = (1.0 - t[i]) * dist;
        double dsb = sqrt(dsg * dsg + (top - se) * (top - se));
        double dbr = sqrt(drg * drg + (top - re) * (top - re));
        double delta = dsb + dbr - dsr;
        if (delta > bestd) { bestd = delta; best = i; }
    }
    return best;
}

// ---- diffraction::fit_plane — OLS line over samples [lo,hi] (x = (t−t_off)·dist).
__device__ void fit_plane(const double* t, const float* prof, int lo, int hi,
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
__device__ double dstar(const double* t, const float* prof, int n, int d_idx,
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

// ---- diffraction::maekawa_bands (single edge: is_double=false ⇒ c3=1, cap 20).
__device__ void maek_single(double delta, double dstar_v, double* bands) {
    for (int i = 0; i < NB; i++) bands[i] = 0.0;
    if (delta <= 0.0) return;
    for (int i = 0; i < NB; i++) {
        double lambda = SOS / BAND_FREQ[i];
        if (delta <= lambda * 0.25 - dstar_v) continue;
        double a_bar = 10.0 * log10(3.0 + 20.0 * delta * BAND_FREQ[i] / SOS);
        bands[i] = fmin(a_bar, SINGLE_DIFF_CAP);
    }
}

// ---- path_effects::terrain_attenuation over a bare-earth profile (the heatmap
// band-only variant: no trace metadata). Writes 8 bands into out.
__device__ void terrain_bands(const double* t, const float* prof, int n,
                              double dist, double src_alt, double rcv_alt, double* out) {
    for (int i = 0; i < NB; i++) out[i] = 0.0;
    if (n < 3 || dist < 30.0) return;
    double dz_total = rcv_alt - src_alt;
    bool hill = false;
    for (int i = 0; i < n; i++) if ((double)prof[i] > src_alt + dz_total * t[i]) { hill = true; break; }
    if (!hill) return;
    double src_h = fmax(src_alt - (double)prof[0], 0.05);
    double rcv_h = fmax(rcv_alt - (double)prof[n - 1], 0.5);
    double se = (double)prof[0] + src_h;
    double re = (double)prof[n - 1] + rcv_h;
    double dsr = sqrt(dist * dist + (re - se) * (re - se));
    int idx = mdidx(t, prof, n, dist, se, re, dsr);
    if (idx < 0) return;
    double los = se + (re - se) * t[idx];
    if ((double)prof[idx] <= los) return;
    double dsg = t[idx] * dist, drg = (1.0 - t[idx]) * dist, top = prof[idx];
    double d_sb = sqrt(dsg * dsg + (top - se) * (top - se));
    double d_br = sqrt(drg * drg + (top - re) * (top - re));
    double delta = d_sb + d_br - dsr;
    maek_single(delta, dstar(t, prof, n, idx, dist, src_h, rcv_h), out);
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
        double fc = flc(sp[s*3], dend, fmin(fmax(frac, 0.0), 1.0));
        double base = refl + fc - 10.0 * log10(2.0 * PI_D * dslant);
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

// RAIL scatter: free-field (as above) + bare-earth TERRAIN diffraction per source
// (DDA cadence ray-march + single-edge δ + δ* Rayleigh gate + Maekawa). NO
// ground/screening/veg, NO budget skip yet — isolates the diffraction port. One
// thread per pixel walks the same per-source profile the CPU builds. Matches the
// CPU free-field+terrain reference exactly (f64). Source ground via tile_elev
// (inner grid in-tile, like scatter_band), not the halo bilinear.
//   meta = [rows, cols, lat_min, lon_min, inv, north_lat, south_lat, west_lon, east_lon]
//   inner = 256×256 row-major tile DEM (pixel-centre elevation)
extern "C" __global__ void rail(
    const float*  __restrict__ elev,
    const float*  __restrict__ inner,
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
    int py = pix >> 8, pxi = pix & 255;
    double rlat = rxll[py], rlon = rxll[256 + pxi];
    double ralt = rxar[pix * 2], refl = rxar[pix * 2 + 1];
    double e0 = 0.0, e1 = 0.0, e2 = 0.0;
    double tprof[MAXT]; float eprof[MAXT];

    for (int s = 0; s < nsrc; s++) {
        double dend, cplat, cplon, frac;
        p2s(rlat, rlon, seg[s*4], seg[s*4+1], seg[s*4+2], seg[s*4+3], &dend, &cplat, &cplon, &frac);
        if (dend > sp[s*3+1]) continue;
        double salt = tile_elev(inner, elev, rows, cols, lat_min, lon_min, inv, bb, cplat, cplon) + sp[s*3+2];
        double dz = salt - ralt;
        double dslant = fmax(sqrt(dend * dend + dz * dz), 1.0);
        double fc = flc(sp[s*3], dend, fmin(fmax(frac, 0.0), 1.0));
        double base = refl + fc - 10.0 * log10(2.0 * PI_D * dslant);
        double atm_km = dslant / 1000.0;

        // ---- terrain diffraction: build the bare-earth profile, ray-march cadence ----
        double terr[NB];
        double src_rf = (cplat - lat_min) * inv, src_cf = (cplon - lon_min) * inv;
        double d_rf = (rlat - cplat) * inv, d_cf = (rlon - cplon) * inv;
        int n = fill_t(dend, tprof);
        for (int i = 0; i < n; i++)
            eprof[i] = bilinear_elev_rc(elev, rows, cols, src_rf + tprof[i] * d_rf, src_cf + tprof[i] * d_cf);
        terrain_bands(tprof, eprof, n, dend, salt, ralt, terr);

        const float* em = &semis[s * 24];
        for (int i = 0; i < NB; i++) {
            double pf = fexp((base - ALPHA_ATM[i] * atm_km - terr[i] + A_W[i]) * LN10 * 0.1);
            e0 += (double)em[i]      * pf;
            e1 += (double)em[8 + i]  * pf;
            e2 += (double)em[16 + i] * pf;
        }
    }
    out[pix * 3 + 0] = (float)e0;
    out[pix * 3 + 1] = (float)e1;
    out[pix * 3 + 2] = (float)e2;
}
