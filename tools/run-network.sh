#!/bin/bash
# Invoke from a verified Linux environment OUTSIDE the SIGNET SIF.
set -euo pipefail
run_root=$(readlink -f "${1:?isolated SIGNET run directory}")
sif=$(readlink -f "${2:?official signet 0.0.6 sif path}")
partition=${3:?verified SLURM partition}
test "$(uname -s)" = Linux
test -f "$run_root/signet" && test -s "$sif"
test ! -e "$run_root/tmp/tmpn" || { echo 'Refusing to overwrite an existing analysis'; exit 1; }
for cmd in singularity sbatch squeue sinfo scontrol; do command -v "$cmd"; done
mkdir -p "$run_root/logs"
singularity --version | tee "$run_root/logs/container-runtime.txt"
singularity inspect --json "$sif" > "$run_root/logs/container-inspect.json"
if [[ ${SIGNET_VERIFIED_SIF_SHA256:-} =~ ^[0-9a-f]{64}$ ]]; then
    printf '%s  %s\n' "$SIGNET_VERIFIED_SIF_SHA256" "$sif" > "$run_root/logs/container-sha256.txt"
    echo 'Checksum verified on macOS before mounting the same file in the VM.' > "$run_root/logs/checksum-source.txt"
else
    sha256sum "$sif" > "$run_root/logs/container-sha256.txt"
    echo 'Checksum computed in Linux execution environment.' > "$run_root/logs/checksum-source.txt"
fi
sinfo -p "$partition" -Nel > "$run_root/logs/sinfo.txt"
cp "$run_root/config.ini" "$run_root/logs/config.before.ini"
export SINGULARITY_BIND="$run_root,$(dirname "$sif")"
export OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 OMP_NUM_THREADS=1
singularity exec --no-home "$sif" Rscript -e 'packages<-c("MASS","data.table","dataPreparation","parcor","matrixcalc","chron");stopifnot(all(vapply(packages,requireNamespace,logical(1),quietly=TRUE)));print(R.version.string);print(sapply(packages,packageVersion));stopifnot(nzchar(Sys.which("ParaFly")))' > "$run_root/logs/dependencies.txt" 2>&1
date -u +%FT%TZ > "$run_root/logs/start.txt"
cd "$run_root"
set +e
./signet -n > logs/network.log 2>&1
status=$?
set -e
echo "$status" > logs/entrypoint-exit-code.txt
date -u +%FT%TZ > logs/end.txt
cp config.ini logs/config.after.ini
# The Node analysis worker collects scheduler history and verifies outputs.
# Do not infer success from this wrapper exit code.
exit "$status"
