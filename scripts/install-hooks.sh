#!/usr/bin/env bash
# Configure the current worktree to use .githooks/ for git hooks.
# Run once per worktree. Hooks then fire automatically on pull / checkout.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/post-merge .githooks/post-checkout .githooks/_engine-rebuild.sh
echo "✓ Hook path set to .githooks (per-worktree config)"
echo "  Hooks installed:"
echo "    - post-merge:    rebuild engine bins after git pull"
echo "    - post-checkout: rebuild engine bins after branch switch"
