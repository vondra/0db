#!/usr/bin/env bash
# Configure the current worktree to use .githooks/ for git hooks.
# Run once per worktree — core.hooksPath is per-checkout config that a fresh
# clone does NOT inherit (dev1/dev2 went stale for exactly that reason,
# 2026-07-17). Hooks then fire automatically on pull / checkout.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/post-merge .githooks/post-checkout .githooks/_rebuild-changed.sh
echo "✓ Hook path set to .githooks (per-worktree config)"
echo "  Hooks installed (selective — only what the pulled range touched):"
echo "    - engine/**            → cargo-rebuild engine crates"
echo "    - frontend/, server/   → ./start.sh (rebuild + atomic restart)"
echo "    - docs/pipeline/other  → no-op"
