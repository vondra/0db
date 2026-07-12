#!/usr/bin/env bash
# Regression: a docs-only merge must not rebuild engines even when HEAD's
# reflog contains an older engine revision immediately behind the branch tip.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name hook-test
git -C "$REPO" config user.email hook-test@example.invalid

mkdir -p "$REPO/engine/demo/src" "$REPO/docs"
printf '[package]\nname="demo"\nversion="0.1.0"\n' > "$REPO/engine/demo/Cargo.toml"
printf 'pub fn version() -> u8 { 1 }\n' > "$REPO/engine/demo/src/lib.rs"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'engine v1'
ENGINE_V1=$(git -C "$REPO" rev-parse HEAD)

printf 'pub fn version() -> u8 { 2 }\n' > "$REPO/engine/demo/src/lib.rs"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'engine v2'
git -C "$REPO" checkout -qb docs-feature
printf 'feature docs\n' > "$REPO/docs/feature.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'feature docs'
git -C "$REPO" checkout -q main
mkdir -p "$REPO/docs"
printf 'main docs\n' > "$REPO/docs/main.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'main docs'

# Produce the semantic post-merge state first. ORIG_HEAD now names the real
# pre-merge commit and its engine is identical to HEAD.
git -C "$REPO" merge -q --no-ff docs-feature -m 'merge docs feature'

# Then dirty only HEAD's reflog, as an earlier rebase/checkout can do before a
# hook is replayed manually. This fixture deliberately proves both sides of
# the regression: HEAD@{1} is wrong and ORIG_HEAD is right for the same HEAD.
git -C "$REPO" checkout -q --detach "$ENGINE_V1"
git -C "$REPO" checkout -q main
if git -C "$REPO" diff --quiet 'HEAD@{1}' HEAD -- engine; then
  echo 'hook test fixture did not make HEAD@{1} engine-different' >&2
  exit 1
fi
if ! git -C "$REPO" diff --quiet ORIG_HEAD HEAD -- engine; then
  echo 'hook test fixture did not preserve the docs-only ORIG_HEAD range' >&2
  exit 1
fi

mkdir -p "$REPO/.githooks" "$TMP/bin"
cp "$ROOT/.githooks/post-merge" "$ROOT/.githooks/_engine-rebuild.sh" "$REPO/.githooks/"
chmod +x "$REPO/.githooks/post-merge" "$REPO/.githooks/_engine-rebuild.sh"
git -C "$REPO" config core.hooksPath .githooks

printf '#!/usr/bin/env bash\ntouch "$HOOK_MARK"\nexit 0\n' > "$TMP/bin/cargo"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/bin/pgrep"
chmod +x "$TMP/bin/cargo" "$TMP/bin/pgrep"

(
  cd "$REPO"
  HOOK_MARK="$TMP/engine-rebuilt" PATH="$TMP/bin:$PATH" .githooks/post-merge
)

if [ -e "$TMP/engine-rebuilt" ]; then
  echo 'post-merge hook rebuilt engines for a docs-only merge' >&2
  exit 1
fi
echo 'git hook regression: OK'
