// Compile every kernels/*.cu to its own PTX (kernels/foo.cu -> $OUT_DIR/foo.ptx)
// at build time via nvcc. This is the production path (vs runtime nvrtc): the PTX
// is embedded in the binary and JIT-finalised by the driver at load, so one build
// runs on any SM >= the arch. nvcc is isolated from Cargo's rustflags, so
// target-cpu=native parity is untouched. NOISE_GPU_ARCH overrides sm_89 (4060).
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let arch = env::var("NOISE_GPU_ARCH").unwrap_or_else(|_| "sm_89".into());
    for entry in fs::read_dir("kernels").expect("kernels/ dir") {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "cu") {
            let stem = path.file_stem().unwrap().to_str().unwrap();
            let ptx = out.join(format!("{stem}.ptx"));
            let status = Command::new("nvcc")
                .args(["-ptx", &format!("-arch={arch}"), "-O3"])
                .arg(&path)
                .arg("-o")
                .arg(&ptx)
                .status()
                .expect("nvcc not found — need the CUDA toolkit on this host");
            assert!(status.success(), "nvcc failed to compile {path:?}");
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    println!("cargo:rerun-if-env-changed=NOISE_GPU_ARCH");
}
