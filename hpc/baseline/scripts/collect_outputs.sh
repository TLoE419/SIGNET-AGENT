#!/bin/bash
# Record res*/tmp* paths, sizes and mtimes after a job ends (called by observe.py).
# Usage: collect_outputs.sh <fixture_dir>
set -u
BASELINE_DIR=${BASELINE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
# shellcheck source=/dev/null
[[ -n "${SIGNET_DIR:-}" ]] || source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set}"
[[ $# -eq 1 && -d "$1" ]] || { echo "usage: collect_outputs.sh <fixture_dir>" >&2; exit 1; }
exec python3 "$BASELINE_DIR/scripts/outputs.py" after --signet-dir "$SIGNET_DIR" --fixture-dir "$1"
