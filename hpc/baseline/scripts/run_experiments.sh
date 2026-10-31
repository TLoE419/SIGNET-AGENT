#!/bin/bash
# run_experiments.sh - run the baseline (B1-B4) and failure (E1-E9) experiments, Spec 01 section 8.
#
# Usage:   run_experiments.sh <ID>...   e.g. run_experiments.sh E1 E2 E3
#          run_experiments.sh all-failures | all-baselines
# Env:     PARTITION (default free), EXPERIMENT_POLL seconds between squeue checks (>= 15),
#          E5_SBATCH resource request for E5, E5_HOLD_SECONDS how long E5 stays pending
#
# Each experiment goes through submit_step.sh, so every run gets its own fixture and
# observer. SIGNET steps run one at a time (they share one install directory), so the
# script waits for each to leave the queue. Scheduler-only experiments (sleep_test.sub)
# return as soon as they are submitted. Resource values are the spec's starting guesses.
set -u
BASELINE_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=/dev/null
source "$BASELINE_DIR/env.sh"
: "${LAB_ACCOUNT:?LAB_ACCOUNT is not set in env.sh}"
SUBMIT=$BASELINE_DIR/scripts/submit_step.sh
PARTITION=${PARTITION:-free}
POLL=${EXPERIMENT_POLL:-30}
(( POLL >= 15 )) || { echo "EXPERIMENT_POLL must be >= 15 seconds" >&2; exit 1; }
# Every job is charged to the lab account explicitly.
COMMON=(--partition="$PARTITION" --account="$LAB_ACCOUNT")

submit() {  # submit <step> <label> [sbatch...]; sets JOB_ID and RUN_ID
    local out
    out=$("$SUBMIT" "$@") || return 1
    echo "$out"
    RUN_ID=$(sed -n 's/.*run_id=\([^ ]*\).*/\1/p' <<< "$out")
    JOB_ID=$(sed -n 's/.*job_id=\([0-9]*\).*/\1/p' <<< "$out")
}

# Current squeue state, or empty once the job has left the queue.
state_of() { squeue -j "$1" -h -o %T 2>/dev/null; }

# Block until the job has left the queue (finished, failed or cancelled).
wait_gone() {
    while [[ -n "$(state_of "$1")" ]]; do sleep "$POLL"; done
}

wait_state() {  # wait_state <job> <state>; gives up when the job leaves the queue
    local now
    while now=$(state_of "$1"); [[ -n "$now" && "$now" != "$2" ]]; do sleep "$POLL"; done
    [[ "$now" == "$2" ]]
}

note() {  # append a line to the fixture's notes.md
    echo "- $(date -Iseconds) $2" >> "$BASELINE_DIR/fixtures/$1/notes.md"
}

# --- Baselines: one successful run per SIGNET step -----------------------------------
B1() { submit g B1 "${COMMON[@]}" --cpus-per-task=20 --mem=64G --time=12:00:00 && wait_gone "$JOB_ID"; }
B2() { submit t B2 "${COMMON[@]}" --cpus-per-task=4 --mem=16G --time=02:00:00 && wait_gone "$JOB_ID"; }
B3() { PC_ANSWER_MODE=stdin NPC=3 submit a B3 "${COMMON[@]}" --cpus-per-task=4 --mem=32G --time=04:00:00 \
           && wait_gone "$JOB_ID"; }
B4() { submit c B4 "${COMMON[@]}" --cpus-per-task=8 --mem=32G --time=06:00:00 && wait_gone "$JOB_ID"; }

# --- Failures: each should end in the state listed in Spec 01 section 8.2 -------------
E1() { SLEEP_SECONDS=300 submit sleep E1-timeout "${COMMON[@]}" --cpus-per-task=1 --mem=1G --time=00:01:00; }
E2() { ALLOC_MB=4000 SLEEP_SECONDS=120 submit sleep E2-oom "${COMMON[@]}" --cpus-per-task=1 --mem=1G \
           --time=00:10:00; }
E3() {
    SLEEP_SECONDS=1800 submit sleep E3-cancel "${COMMON[@]}" --cpus-per-task=1 --mem=1G --time=00:40:00 || return 1
    if wait_state "$JOB_ID" RUNNING; then
        sleep "$POLL"  # let the observer record at least one RUNNING snapshot
        scancel "$JOB_ID" && note "$RUN_ID" "scancel $JOB_ID sent while RUNNING"
    else
        note "$RUN_ID" "job left the queue before reaching RUNNING; scancel not sent"
    fi
}
E4() { SIGNET_ARGS="--g /nonexistent/baseline_missing_gexp" submit t E4-bad-input "${COMMON[@]}" \
           --cpus-per-task=4 --mem=16G --time=00:30:00 && wait_gone "$JOB_ID"; }
E5() {
    # Must be satisfiable by the partition (or sbatch rejects it outright) yet not free right now.
    # shellcheck disable=SC2086
    submit sleep E5-pending-resources "${COMMON[@]}" ${E5_SBATCH:---nodes=1 --exclusive --mem=0} --time=00:10:00 \
        || return 1
    sleep "${E5_HOLD_SECONDS:-120}"
    note "$RUN_ID" "state before scancel: $(squeue -j "$JOB_ID" -h -o '%T %r')"
    scancel "$JOB_ID"
}
E6() {
    SLEEP_SECONDS=180 submit sleep E6-first "${COMMON[@]}" --cpus-per-task=1 --mem=1G --time=00:10:00 || return 1
    local first=$JOB_ID
    SLEEP_SECONDS=30 submit sleep E6-dependent "${COMMON[@]}" --cpus-per-task=1 --mem=1G --time=00:10:00 \
        --dependency=afterok:"$first" && note "$RUN_ID" "depends on job $first"
}
E7() { PC_ANSWER_MODE=none submit a E7-no-stdin "${COMMON[@]}" --cpus-per-task=4 --mem=32G --time=00:15:00 \
           && wait_gone "$JOB_ID"; }
E8() { submit g E8-signet-timeout "${COMMON[@]}" --cpus-per-task=20 --mem=64G --time=00:05:00 \
           && wait_gone "$JOB_ID"; }
E9() { SLEEP_SECONDS=21600 submit sleep E9-preempt "--partition=free" --account="$LAB_ACCOUNT" \
           --cpus-per-task=1 --mem=1G --time=07:00:00; }

# --- Main: expand the requested IDs and run them in order --------------------------
[[ $# -ge 1 ]] || { sed -n '4,5p' "$0"; exit 1; }
ids=()
for arg in "$@"; do
    case "$arg" in
        all-baselines) ids+=(B1 B2 B3 B4);;
        all-failures) ids+=(E1 E2 E3 E4 E5 E6 E7 E8);;
        B[1-4]|E[1-9]) ids+=("$arg");;
        *) echo "unknown experiment '$arg'" >&2; exit 1;;
    esac
done
failed=0
for id in "${ids[@]}"; do
    echo "== $id"
    "$id" || { echo "== $id did not submit cleanly" >&2; failed=1; }
done
exit $failed
