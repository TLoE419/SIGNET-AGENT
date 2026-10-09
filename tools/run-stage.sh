#!/bin/bash
# Official scientific code stays in the official container. This is orchestration.
set -euo pipefail
aid=${1:?}; stage=${2:?}
[[ $aid =~ ^a-[0-9]{8}T[0-9]{6}-[a-f0-9]{12}$ ]] || exit 2
root=/work/runs/$aid
sif=/work/evidence/signet-0.0.6.sif
test -f "$root/signet" && test -s "$sif"
mkdir -p "$root/logs"
echo "$$ $(awk '{print $22}' /proc/$$/stat)" > "$root/logs/remote-process"
export SINGULARITY_BIND="$root,$(dirname "$sif")"
export OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 OMP_NUM_THREADS=1
cd "$root"
case "$stage" in
 visualization) exec bash /work/tools/run-visualization.sh prepare "$aid";;
 genotype) flag=-g; tmp=tmpg;;
 expression) flag=-t; tmp=tmpt;;
 adjustment) flag=-a; tmp=tmpa;;
 ciseqtl) flag=-c; tmp=tmpc;;
 network)
  exec bash /work/tools/run-network.sh "$root" "$sif" local
  ;;
 *) exit 2;;
esac
test ! -e "$root/tmp/$tmp" || { echo 'Refusing to overwrite an existing stage' >&2; exit 1; }
cp config.ini "logs/$stage-config.before.ini"
date -u +%FT%TZ > "logs/$stage-start.txt"
set +e
singularity exec --no-home "$sif" ./signet "$flag" > "logs/$stage.log" 2>&1
status=$?
set -e
echo "$status" > "logs/$stage-exit-code.txt"
date -u +%FT%TZ > "logs/$stage-end.txt"
cp config.ini "logs/$stage-config.after.ini"
# The wrapper can mask errors. The Node worker must verify output contracts.
exit "$status"
