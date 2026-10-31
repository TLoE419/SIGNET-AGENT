#!/bin/bash
# start_network.sh - experiment N1: observe `signet -n` and its child jobs (Spec 01, 8.3).
#
# `signet -n` is meant to run on the login node and submits its own Slurm jobs, so it is
# not wrapped in sbatch. This script:
#   1. creates fixtures/<timestamp>_n_<label>/ with meta.json and outputs_before.json;
#   2. resets config.ini with apply_config.sh (nboots=2, queue=free, ncores=4, ...);
#   3. starts observe_network.py in the background, watching this script's PID;
#   4. runs `signet -n` in the foreground, copying its output to stdout.log.
#
# Usage:   start_network.sh <attempt_label>          (run inside tmux)
# Env:     OBSERVE_INTERVAL seconds between polls (default 30, minimum 15)
#          BASELINE_NO_TMUX_CHECK=1 to skip the tmux check
# Exit:    the exit code of `signet -n`
set -u
BASELINE_DIR=$(cd "$(dirname "$0")/.." && pwd)
export BASELINE_DIR
# shellcheck source=/dev/null
source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set in env.sh}"
[[ $# -eq 1 && "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "usage: start_network.sh <attempt_label>" >&2; exit 1; }
[[ -n "${TMUX:-}" || "${BASELINE_NO_TMUX_CHECK:-0}" == 1 ]] \
    || { echo "run this inside tmux: -n runs for a long time on the login node" >&2; exit 1; }

run_id="$(date +%Y%m%d-%H%M%S)_n_$1"
fixture=$BASELINE_DIR/fixtures/$run_id
mkdir -p "$BASELINE_DIR/fixtures"
mkdir "$fixture" || exit 1
cp "$BASELINE_DIR/config/baseline.overrides" "$fixture/config_overrides.txt"
bash "$BASELINE_DIR/scripts/apply_config.sh" n > "$fixture/apply_config.log" 2>&1 \
    || { echo "apply_config failed; see $fixture/apply_config.log" >&2; exit 1; }
python3 "$BASELINE_DIR/scripts/outputs.py" before --signet-dir "$SIGNET_DIR" --fixture-dir "$fixture"

# The observer counts every job submitted at or after this moment as a candidate child.
start=$(date +%Y-%m-%dT%H:%M:%S)
commit=$(git -C "$SIGNET_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
python3 -c 'import json,sys; json.dump(dict(zip(sys.argv[2::2], sys.argv[3::2])), open(sys.argv[1], "w"), indent=2)' \
    "$fixture/meta.json" run_id "$run_id" step n attempt_label "$1" network_start "$start" \
    signet_commit "$commit" hostname "$(hostname)" parent_pid "$$"
nohup python3 "$BASELINE_DIR/scripts/observe_network.py" --fixture-dir "$fixture" --signet-dir "$SIGNET_DIR" \
    --start "$start" --parent-pid "$$" --log-path "$fixture/stdout.log" \
    --interval "${OBSERVE_INTERVAL:-30}" > "$fixture/observer.log" 2>&1 &
echo "run_id=$run_id observer_pid=$!"

cd "$SIGNET_DIR" || exit 1
echo "[BASELINE] START step=n host=$(hostname) ts=$(date -Iseconds)" | tee "$fixture/stdout.log"
./signet -n 2>&1 | tee -a "$fixture/stdout.log"
rc=${PIPESTATUS[0]}                # exit code of signet, not of tee
echo "[BASELINE] END step=n exit=$rc ts=$(date -Iseconds)" | tee -a "$fixture/stdout.log"
python3 "$BASELINE_DIR/scripts/outputs.py" after --signet-dir "$SIGNET_DIR" --fixture-dir "$fixture"
exit "$rc"
