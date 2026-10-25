# Sourced by every template: environment, SIGNET config reset, and START/END markers.
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
    bash "$BASELINE_DIR/scripts/apply_config.sh" || baseline_end 90
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
