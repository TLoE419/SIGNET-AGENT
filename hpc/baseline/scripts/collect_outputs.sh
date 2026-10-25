#!/bin/bash
# collect_outputs.sh - record the files a SIGNET step produced (Monitor Spec 01, 6.4).
#
# observe.py calls this once the job reaches a terminal state. It lists every file under
# $SIGNET_DIR/res* and $SIGNET_DIR/tmp* (path, size, mtime; never contents) and compares
# the list with outputs_before.json, which submit_step.sh took at submission.
#
# Usage:   collect_outputs.sh <fixture_dir>
# Output:  <fixture_dir>/outputs.json and <fixture_dir>/outputs_diff.json
set -u
BASELINE_DIR=${BASELINE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
# shellcheck source=/dev/null
[[ -n "${SIGNET_DIR:-}" ]] || source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set}"
[[ $# -eq 1 && -d "$1" ]] || { echo "usage: collect_outputs.sh <fixture_dir>" >&2; exit 1; }
# The listing and diff are done in Python so the JSON is well formed.
exec python3 "$BASELINE_DIR/scripts/outputs.py" after --signet-dir "$SIGNET_DIR" --fixture-dir "$1"
