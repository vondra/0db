# AGENTS.md — conventions for coding agents

Conventions for the Quiet Map product repo. They bind every contributor,
human or agent. Ops/automation conventions live in the separate private repo
and do not apply here.

## Language

English everywhere: code, comments, docstrings, commit messages, docs, UI
strings.

## Quality gate

`./scripts/check-fast.sh` must be green before every commit (optional `node` /
`rust` argument runs one side only). Read gate output raw — never grep/tail
it. Zero compiler warnings, Rust Clippy included.

## Code style

- **Code is the documentation.** Names long, precise, greppable
  (`write_rail_trains_with_priority_gate`, never `wrt`) — code is located by
  search.
- **Docstrings orient, comments explain.** One-line module doc atop every
  file (`//!`, `///`, JSDoc); each crate root (`lib.rs`) maps its submodules.
  Comments only for what code cannot carry: WHY this approach over the
  alternatives, provenance of constants (cite the source, e.g. "ITE Trip Gen
  10th Ed code 310"), subtle invariants.
- File size: aim for ~300 lines.
- **One source of truth.** Correctness-critical acoustic logic lives once, in
  the shared kernel (`engine/noise-compute`); per-case files stay thin data
  plus a call to it. Keep `engine/noise-compute/SPEC.md` in sync with the code
  it specifies — a model change without its SPEC update is incomplete.
- Edit originals — never create `-v2` / parallel variants.
- Occam's razor: standards permit error and input data is incomplete — don't
  buy "perfect" acoustic accuracy with code complexity. Given two equal
  variants, pick the simpler one.

## Native binaries after pulls

After every `git pull` or source sync that touches `engine/`, rebuild the
native crates before running anything: the server dlopens
`libsource_reader.so` once per process and caches it, and long-running scripts
cache their extractor binary — stale binaries have shipped wrong numbers.
`./start.sh` rebuilds and restarts everything.

## Public-repo boundary

NEVER put internal hostnames, provider names, infrastructure paths or
deployment details into product files — comments and docs included. This repo
is public and stays host/provider-agnostic.

## Data

`data/` is gitignored and may be irreplaceable (source extracts whose origins
can vanish) — never `rm -rf` without checking contents first. Numbers are
computed from data, never estimated.
