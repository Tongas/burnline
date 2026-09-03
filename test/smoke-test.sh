#!/usr/bin/env bash
# Manual smoke test for statusline/status.js — pipes a sequence of mock
# statusLine payloads through the script and prints the rendered line plus
# the on-disk state after each tick, so behavior can be eyeballed tick by
# tick. Writes to a repo-local temp dir (BURNLINE_DATA_DIR override), never
# touches the real ~/.claude/burnline/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
STATUS_JS="$REPO_ROOT/statusline/status.js"
DATA_DIR="$SCRIPT_DIR/tmp-burnline-data"

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

run_tick() {
  local n="$1" payload="$2"
  echo "=================================================================="
  echo "TICK $n — input:"
  echo "$payload"
  echo "------------------------------------------------------------------"
  echo -n "stdout: "
  echo "$payload" | BURNLINE_DATA_DIR="$DATA_DIR" node "$STATUS_JS"
  echo
  echo "------------------------------------------------------------------"
  echo "on-disk state ($DATA_DIR):"
  find "$DATA_DIR" -type f | sort | while read -r f; do
    echo "  $f:"
    sed 's/^/    /' "$f"
  done
  echo
}

TICK1='{"session_id":"sess-A","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/medicalhair"},"cost":{"total_cost_usd":0.05}}'

TICK2='{"session_id":"sess-A","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/medicalhair"},"cost":{"total_cost_usd":0.18}}'

TICK3='{"session_id":"sess-A","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/medicalhair"},"cost":{"total_cost_usd":0.05}}'

TICK4='{"session_id":"sess-B","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/setar"},"cost":{"total_cost_usd":0.10}}'

TICK5='{"session_id":"sess-B","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/setar"},"cost":{"total_cost_usd":0.10},"rate_limits":{"five_hour":{"used_percentage":12}}}'

TICK6='{"session_id":"sess-B","model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},"workspace":{"current_dir":"/home/gaston/projects/setar"}}'

run_tick 1 "$TICK1"
run_tick 2 "$TICK2"
run_tick 3 "$TICK3"
run_tick 4 "$TICK4"
run_tick 5 "$TICK5"
run_tick 6 "$TICK6"

echo "=================================================================="
echo "Done. Temp data left at $DATA_DIR for inspection (delete freely)."
