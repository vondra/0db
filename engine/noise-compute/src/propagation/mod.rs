//! Propagation (source→receiver attenuation) submodules — ISO 9613-2 divergence,
//! ground, atmosphere, plus path effects (diffraction/screening/vegetation).
pub mod diffraction;
pub mod geo;
pub mod horizon;
pub mod iso9613;
pub mod path_effects;
pub mod path_profile;
pub mod reflection;
pub mod screening;
pub mod vegetation;

pub use path_profile::PathProfile;
