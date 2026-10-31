#!/bin/bash
# submit_step.sh - submit one baseline step and start its observer (Monitor Spec 01, 6.2).
#
# Usage:   submit_step.sh <g|t|a|c|sleep> <attempt_label> [sbatch options...]
#          e.g. submit_step.sh t B2 --partition=free --account=$LAB_ACCOUNT \
#                   --cpus-per-task=4 --mem=16G --time=02:00:00
# Env:     experiment knobs SLEEP_SECONDS, ALLOC_MB, PC_ANSWER_MODE, NPC, SIGNET_ARGS are
#          forwarded to the job with --export=ALL and recorded in meta.json;
#          OBSERVE_INTERVAL (default 30, minimum 15); BASELINE_NO_OBSERVER=1 (tests);
#          BASELINE_ALLOW_CONCURRENT=1 to skip the one-SIGNET-step-at-a-time check
# Output:  "run_id=<id> job_id=<id>" on stdout
#
# Steps: refuse unsafe options, check no other SIGNET step is active, create
# fixtures/<YYYYMMDD-HHMMSS>_<step>_<label>/, write meta.json and outputs_before.json,
# submit with sbatch --parsable, then start observe.py with nohup.
# An existing fixture is never overwritten; a rejected submission is recorded in meta.json.
set -u
BASELINE_DIR=$(cd "$(dirname "$0")/.." && pwd)
export BASELINE_DIR
# shellcheck source=/dev/null
source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set in env.sh}"

die() { echo "[submit_step] $*" >&2; exit 1; }

[[ $# -ge 2 ]] || die "usage: submit_step.sh <g|t|a|c|sleep> <attempt_label> [sbatch options...]"
step=$1 label=$2
shift 2
case "$step" in
    g|t|a|c) template=$BASELINE_DIR/templates/signet_$step.sub; uses_signet=1;;
    sleep) template=$BASELINE_DIR/templates/sleep_test.sub; uses_signet=0;;
    *) die "unknown step '$step'";;
esac
[[ "$label" =~ ^[A-Za-z0-9_-]+$ ]] || die "attempt_label may contain only letters, digits, _ and -"
# These options are owned by this script; letting callers override them would break the fixture.
for option in "$@"; do
    case "$option" in
        --output*|--error*|-o|-e|--export*|--parsable) die "$option is set by submit_step.sh";;
    esac
done

if [[ $uses_signet -eq 1 ]]; then
    bash "$BASELINE_DIR/scripts/apply_config.sh" --check-only "$step" || exit 1
fi

# SIGNET keeps one analysis per install directory (shared tmp/, res/, config.ini).
if [[ $uses_signet -eq 1 && "${BASELINE_ALLOW_CONCURRENT:-0}" != 1 ]]; then
    queue=$(squeue -u "$USER" -h -o '%i %j') || die "could not check active SIGNET jobs; refusing submission"
    active=$(printf '%s\n' "$queue" | awk '$2 ~ /^signet_[gtac]$/')
    [[ -z "$active" ]] || die "another SIGNET step is queued or running: $active"
fi

run_id="$(date +%Y%m%d-%H%M%S)_${step}_${label}"
fixture=$BASELINE_DIR/fixtures/$run_id
mkdir -p "$BASELINE_DIR/fixtures"
mkdir "$fixture" || die "fixture $fixture already exists; refusing to overwrite"
cp "$BASELINE_DIR/config/baseline.overrides" "$fixture/config_overrides.txt"

command=(sbatch --parsable "--output=$fixture/stdout.log" "--error=$fixture/stderr.log"
         "--export=ALL,BASELINE_DIR=$BASELINE_DIR,FIXTURE_DIR=$fixture" "$@" "$template")
commit=$(git -C "$SIGNET_DIR" rev-parse HEAD 2>/dev/null || echo unknown)

# meta KEY JSON [KEY JSON...]: merge values into meta.json (values are already JSON-encoded).
meta() {
    python3 - "$fixture/meta.json" "$@" <<'PY'
import json, os, sys
path, updates = sys.argv[1], dict(zip(sys.argv[2::2], sys.argv[3::2]))
meta = json.load(open(path)) if os.path.exists(path) else {}
for key, value in updates.items():
    meta[key] = json.loads(value)
tmp = path + '.tmp'
with open(tmp, 'w') as handle:
    json.dump(meta, handle, indent=2, sort_keys=True)
    handle.write('\n')
os.replace(tmp, path)
PY
}
# JSON-encode a string / an argv list / the experiment knobs that are set.
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
json_argv() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
experiment_env=$(python3 -c 'import json,os; print(json.dumps({k: os.environ[k] for k in
    ("SLEEP_SECONDS","ALLOC_MB","PC_ANSWER_MODE","NPC","SIGNET_ARGS") if k in os.environ}))')

meta run_id "$(json_str "$run_id")" step "$(json_str "$step")" attempt_label "$(json_str "$label")" \
     sbatch_command "$(json_argv "${command[@]}")" signet_commit "$(json_str "$commit")" \
     hostname "$(json_str "$(hostname)")" submit_ts "$(json_str "$(date -Iseconds)")" \
     experiment_env "$experiment_env" || die "could not write meta.json"

python3 "$BASELINE_DIR/scripts/outputs.py" before --signet-dir "$SIGNET_DIR" --fixture-dir "$fixture" \
    || die "could not snapshot outputs before submission"

if ! submitted=$("${command[@]}" 2> "$fixture/sbatch_stderr.txt"); then
    meta submit_error "$(json_str "$(cat "$fixture/sbatch_stderr.txt")")"
    die "sbatch rejected the job; see $fixture/sbatch_stderr.txt"
fi
job_id=${submitted%%;*}            # --parsable prints "<id>" or "<id>;<cluster>"
[[ "$job_id" =~ ^[0-9]+$ ]] || die "unexpected sbatch output: $submitted"
meta job_id "$(json_str "$job_id")"

if [[ "${BASELINE_NO_OBSERVER:-0}" != 1 ]]; then
    nohup python3 "$BASELINE_DIR/scripts/observe.py" --job-id "$job_id" --fixture-dir "$fixture" \
        --interval "${OBSERVE_INTERVAL:-30}" > "$fixture/observer.log" 2>&1 &
    meta observer_pid "$!"
fi
echo "run_id=$run_id job_id=$job_id"
