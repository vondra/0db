#!/usr/bin/env bash
# Re-run all measured enrichment scripts (roads + railways + buildings + industrial).
# Parallel with limited concurrency to avoid thrashing Arrow flock.
#
# Usage: DATA_YEAR=2025 bash pipeline/bench/rerun-measured.sh
set -uo pipefail   # NO -e: we want to continue even if one script fails
cd "$(dirname "$0")/../.."

LOG_DIR="logs/rerun-measured"
mkdir -p "$LOG_DIR"

YEAR="${DATA_YEAR:-2025}"
export DATA_YEAR="$YEAR"
JOBS="${JOBS:-6}"

# Bump Node heap to 8 GB. Some national enrichers hold the full country's
# cache in memory (e.g. enrich-buildings-es loads ~30M Catastro buildings)
# and would otherwise OOM at the default 3.4 GB limit.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Helper: run one script, redirect logs
run_one() {
    local script="$1"
    local basename
    basename=$(basename "$script" .ts)
    local log="$LOG_DIR/${basename}.log"
    if ! npx tsx "$script" --enrich-only > "$log" 2>&1; then
        # Retry once without --enrich-only (maybe cache missing)
        if ! npx tsx "$script" >> "$log" 2>&1; then
            echo "FAIL $script" >> "$LOG_DIR/_failures.txt"
        fi
    fi
    echo "  done $basename"
}
export -f run_one
export DATA_YEAR LOG_DIR

# ── Discover surviving scripts ──
ROADS=$(ls pipeline/enrich-roads-*.ts 2>/dev/null)
RAILWAYS=$(ls pipeline/enrich-railway-*.ts 2>/dev/null)
BUILDINGS=$(ls pipeline/enrich-buildings-*.ts 2>/dev/null)
INDUSTRIAL=$(ls pipeline/enrich-industrial-*.ts 2>/dev/null)
GLOBAL=$(ls pipeline/enrich-global-industrial.ts pipeline/enrich-global-windturbines.ts 2>/dev/null)

log "Scripts to run:"
log "  roads:      $(echo "$ROADS" | wc -l)"
log "  railways:   $(echo "$RAILWAYS" | wc -l)"
log "  buildings:  $(echo "$BUILDINGS" | wc -l)"
log "  industrial: $(echo "$INDUSTRIAL" | wc -l)"
log "  global:     $(echo "$GLOBAL" | wc -l)"
log "  parallelism: $JOBS"

rm -f "$LOG_DIR/_failures.txt"

# ── Phase 1: Continental + Global (dependencies for country priority) ──
log ""
log "Phase 1: Global + Continental"
for s in $GLOBAL pipeline/enrich-roads-europe.ts pipeline/enrich-railway-europe.ts pipeline/enrich-industrial-europe.ts; do
    [ -f "$s" ] && run_one "$s"
done

# ── Phase 2: Country-level (parallel, all layers mixed) ──
log ""
log "Phase 2: Country scripts (parallel, $JOBS jobs)"
echo "$ROADS $RAILWAYS $BUILDINGS $INDUSTRIAL" | tr ' ' '\n' | grep -v '^$' | \
    xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {}

# ── Summary ──
log ""
log "Done. Failures:"
if [ -f "$LOG_DIR/_failures.txt" ]; then
    cat "$LOG_DIR/_failures.txt"
    log "  ($(wc -l < "$LOG_DIR/_failures.txt") failures)"
else
    log "  (none)"
fi
