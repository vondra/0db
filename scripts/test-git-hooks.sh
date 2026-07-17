#!/usr/bin/env bash
# Regression: a docs-only merge must not rebuild engines even when HEAD's
# reflog contains an older engine revision immediately behind the branch tip.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
LISTENER_PID=""
cleanup() {
  [ -z "$LISTENER_PID" ] || kill "$LISTENER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
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
cp "$ROOT/.githooks/post-merge" "$ROOT/.githooks/_rebuild-changed.sh" "$REPO/.githooks/"
chmod +x "$REPO/.githooks/post-merge" "$REPO/.githooks/_rebuild-changed.sh"
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

# A CLI HOST/PORT override must survive a checkout-local .env. Stop start.sh at
# its first lock attempt so this tests configuration precedence without doing a
# build or touching a real listener.
START_FIXTURE="$TMP/start-fixture"
START_BIN="$TMP/start-bin"
mkdir -p "$START_FIXTURE" "$START_BIN"
cp "$ROOT/start.sh" "$START_FIXTURE/start.sh"
printf 'HOST=0.0.0.0\nPORT=9000\n' > "$START_FIXTURE/.env"
printf '#!/usr/bin/env bash\nexit 0\n' > "$START_BIN/lsof"
cat > "$START_BIN/flock" <<'EOF'
#!/usr/bin/env bash
printf '%s:%s\n' "$HOST" "$PORT" > "$START_ENV_MARK"
exit 1
EOF
chmod +x "$START_BIN/lsof" "$START_BIN/flock"
if START_ENV_MARK="$TMP/start-env" PATH="$START_BIN:$PATH" \
    HOST=127.0.0.1 PORT=9001 "$START_FIXTURE/start.sh" >/dev/null 2>&1; then
  echo 'start.sh unexpectedly passed the deliberate lock failure' >&2
  exit 1
fi
if [ "$(cat "$TMP/start-env")" != '127.0.0.1:9001' ]; then
  echo 'start.sh let .env replace an explicit HOST or PORT' >&2
  exit 1
fi

# An engine hook restart must pass the listener's actual bind address to
# start.sh. In particular, a loopback listener must not become 0.0.0.0.
HOOK_PREV=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$REPO/engine/source-reader/src"
printf '[package]\nname="source-reader"\nversion="0.1.0"\n' > "$REPO/engine/source-reader/Cargo.toml"
printf 'pub fn version() -> u8 { 1 }\n' > "$REPO/engine/source-reader/src/lib.rs"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'engine v3'
HOOK_NEW=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$REPO/server"
( cd "$REPO/server" && exec sleep 30 ) &
LISTENER_PID=$!
for _ in {1..20}; do
  [ "$(readlink "/proc/$LISTENER_PID/cwd" 2>/dev/null || true)" = "$REPO/server" ] && break
  sleep 0.05
done
export FAKE_LISTENER_PID="$LISTENER_PID"
export HOOK_RESTART_ARGS="$TMP/hook-restart-args"
cat > "$TMP/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = '-of' ]; then exit 1; fi
printf '%s\n' "$FAKE_LISTENER_PID"
EOF
cat > "$TMP/bin/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 511 127.0.0.1:9123 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "$FAKE_LISTENER_PID"
EOF
cat > "$TMP/bin/nohup" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$HOOK_RESTART_ARGS"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/cargo"
chmod +x "$TMP/bin/cargo" "$TMP/bin/pgrep" "$TMP/bin/ss" "$TMP/bin/nohup"
(
  cd "$REPO"
  PATH="$TMP/bin:$PATH" .githooks/_rebuild-changed.sh "$HOOK_PREV" "$HOOK_NEW"
)
for _ in {1..20}; do
  [ -s "$HOOK_RESTART_ARGS" ] && break
  sleep 0.05
done
kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""
if ! grep -q '^env HOST=127\.0\.0\.1 PORT=9123 ' "$HOOK_RESTART_ARGS"; then
  echo 'engine hook restart did not preserve the loopback bind address' >&2
  exit 1
fi

# A frontend-only pull must schedule a web restart WITHOUT any cargo build —
# the selective split (owner 2026-07-17): web changes rebuild the web, engine
# changes rebuild the engine, never everything for either.
HOOK_PREV=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$REPO/frontend/src"
printf 'export const marker = 1\n' > "$REPO/frontend/src/app.ts"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'frontend change'
HOOK_NEW=$(git -C "$REPO" rev-parse HEAD)
( cd "$REPO/server" && exec sleep 30 ) &
LISTENER_PID=$!
for _ in {1..20}; do
  [ "$(readlink "/proc/$LISTENER_PID/cwd" 2>/dev/null || true)" = "$REPO/server" ] && break
  sleep 0.05
done
export FAKE_LISTENER_PID="$LISTENER_PID"
export HOOK_RESTART_ARGS="$TMP/hook-web-restart-args"
printf '#!/usr/bin/env bash\ntouch "$CARGO_MARK"\nexit 0\n' > "$TMP/bin/cargo"
chmod +x "$TMP/bin/cargo"
(
  cd "$REPO"
  CARGO_MARK="$TMP/web-cargo-ran" PATH="$TMP/bin:$PATH" \
    .githooks/_rebuild-changed.sh "$HOOK_PREV" "$HOOK_NEW"
)
for _ in {1..20}; do
  [ -s "$HOOK_RESTART_ARGS" ] && break
  sleep 0.05
done
kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""
if [ -e "$TMP/web-cargo-ran" ]; then
  echo 'frontend-only pull must not cargo-rebuild the engine' >&2
  exit 1
fi
if ! grep -q '^env HOST=127\.0\.0\.1 PORT=9123 ' "$HOOK_RESTART_ARGS"; then
  echo 'frontend-only pull did not schedule the web restart' >&2
  exit 1
fi
echo 'git hook regression: OK'
