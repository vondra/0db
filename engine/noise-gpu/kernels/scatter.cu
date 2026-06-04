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
