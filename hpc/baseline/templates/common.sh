# common.sh - helpers sourced by every sbatch template in this folder (Monitor Spec 01, 6.1).
#
# Provides:
#   baseline_start STEP  print "[BASELINE] START step=... job=... host=... cpus=... ts=..."
#   baseline_end CODE    print "[BASELINE] END step=... exit=CODE ts=..." and exit with CODE
#   prepare_signet       reset config.ini (apply_config.sh), cd to SIGNET, set ncore_local
#   signet_args          split $SIGNET_ARGS into the SIGNET_EXTRA array
#   in_container CMD...  run CMD inside the SIGNET container ($SIGNET_SIF)
#
# The START/END markers give the monitor an exit code that SIGNET itself does not provide:
# the `signet` entry script always ends with `exit 0`.
# Exit codes 90-92 mean the job failed while preparing SIGNET, before the step started.
# shellcheck shell=bash
: "${BASELINE_DIR:?BASELINE_DIR must be exported by submit_step.sh}"
# shellcheck source=/dev/null
source "$BASELINE_DIR/env.sh"

baseline_start() {
    BASELINE_STEP=$1
    echo "[BASELINE] START step=$BASELINE_STEP job=${SLURM_JOB_ID:-none} host=$(hostname) cpus=${SLURM_CPUS_PER_TASK:-unset} ts=$(date -Iseconds)"
}

baseline_end() {
    echo "[BASELINE] END step=$BASELINE_STEP exit=$1 ts=$(date -Iseconds)"
    exit "$1"
}

# Reset config.ini to the baseline overlay so a previous run's CLI flags cannot leak in,
# then size SIGNET's local parallelism to the cores Slurm actually granted.
prepare_signet() {
    bash "$BASELINE_DIR/scripts/apply_config.sh" "$BASELINE_STEP" || baseline_end 90
    cd "$SIGNET_DIR" || baseline_end 91
    ./signet -s --ncore_local "${SLURM_CPUS_PER_TASK:-1}" || baseline_end 92
}

# Extra SIGNET flags for one experiment (e.g. E4's bad path), split on whitespace only.
signet_args() {
    read -r -a SIGNET_EXTRA <<< "${SIGNET_ARGS:-}"
}

# Steps -g/-t/-a/-c run inside the container (SIGNET manual); -n must not.
in_container() {
    singularity exec "$SIGNET_SIF" "$@"
}
