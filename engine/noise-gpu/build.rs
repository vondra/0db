// Compile every kernels/*.cu to a single PTX at build time via nvcc. This is the
// production path (vs runtime nvrtc): the PTX is embedded in the binary and
// JIT-finalised by the driver at load, so one build runs on any SM >= the arch.
// nvcc is isolated from Cargo's rustflags, so target-cpu=native parity is untouched.
use std::{env, path::PathBuf, process::Command};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let arch = env::var("NOISE_GPU_ARCH").unwrap_or_else(|_| "sm_89".into()); // 4060 = sm_89
    let kernel = "kernels/test.cu";
    let ptx = out.join("test.ptx");
    let status = Command::new("nvcc")
        .args(["-ptx", &format!("-arch={arch}"), "-O3", kernel, "-o"])
        .arg(&ptx)
        .status()
        .expect("nvcc not found — need the CUDA toolkit on this host");
    assert!(status.success(), "nvcc failed to compile {kernel}");
    println!("cargo:rerun-if-changed={kernel}");
    println!("cargo:rerun-if-env-changed=NOISE_GPU_ARCH");
}
