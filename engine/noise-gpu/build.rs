//! Build script for `noise-gpu` — compiles CUDA kernels to PTX (only under the
//! `gpu` feature) so a CUDA-less host still builds the CPU-side lib cleanly.
// Compile every kernels/*.cu to its own PTX (kernels/foo.cu -> $OUT_DIR/foo.ptx)
// at build time via nvcc. This is the production path (vs runtime nvrtc): the PTX
// is embedded in the binary and JIT-finalised by the driver at load, so one build
// runs on any SM >= the arch. nvcc is isolated from Cargo's rustflags, so
// target-cpu=native parity is untouched. NOISE_GPU_ARCH overrides sm_89 (4060).
//
// Only the `gpu` feature (the gpu-surface/e2-full bins) needs CUDA. Without it the
// crate is the CPU-side lib alone, so skip nvcc entirely — a host with no CUDA
// toolkit (e.g. a CPU-only box) then builds noise-gpu cleanly. nvcc is required only when you
// explicitly build `--features gpu`, which only happens on a GPU host.
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=NOISE_GPU_ARCH");
    // Watch the whole dir, not just each .cu — otherwise ADDING a new kernel
    // (e.g. airborne.cu) doesn't re-run this script, so its .ptx never builds.
    println!("cargo:rerun-if-changed=kernels");
    if env::var_os("CARGO_FEATURE_GPU").is_none() {
        return;
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let arch = env::var("NOISE_GPU_ARCH").unwrap_or_else(|_| "sm_89".into());
    // NUM_CLASSES is parsed from the generated profiles table and injected as
    // -DNPD_NC so the kernel's NPD LUT stride can never drift from the Rust
    // upload (hardcoded 14 corrupted departures when the pinned 15th class
    // landed; /gg C10b 2026-06-11).
    let gen = "../noise-compute/src/emission/profiles_generated.rs";
    println!("cargo:rerun-if-changed={gen}");
    let num_classes = fs::read_to_string(gen)
        .expect("profiles_generated.rs not found next to noise-gpu")
        .lines()
        .find_map(|l| {
            l.strip_prefix("pub const NUM_CLASSES: usize = ")?
                .strip_suffix(';')
                .map(str::to_owned)
        })
        .expect("NUM_CLASSES const not found in profiles_generated.rs");
    for entry in fs::read_dir("kernels").expect("kernels/ dir") {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "cu") {
            let stem = path.file_stem().unwrap().to_str().unwrap();
            let ptx = out.join(format!("{stem}.ptx"));
            let status = Command::new("nvcc")
                .args([
                    "-ptx",
                    &format!("-arch={arch}"),
                    "-O3",
                    &format!("-DNPD_NC={num_classes}"),
                ])
                .arg(&path)
                .arg("-o")
                .arg(&ptx)
                .status()
                .expect("nvcc not found — `--features gpu` needs the CUDA toolkit on this host");
            assert!(status.success(), "nvcc failed to compile {path:?}");
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
