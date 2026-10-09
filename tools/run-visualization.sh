#!/bin/bash
# Official stage six runs in its container; only headless launch is adapted.
set -euo pipefail
mode=${1:?}; aid=${2:?}
[[ $aid =~ ^(a-[0-9]{8}T[0-9]{6}-[a-f0-9]{12}|macos-vm-smoke-20261006)$ ]] || exit 2
root=/work/runs/$aid
sif=/work/evidence/signet-0.0.6.sif
export SINGULARITY_BIND="$root,$(dirname "$sif"),/work/tools"
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
cd "$root"
case "$mode" in
 prepare)
  test ! -e res/resv/official-session.RData || { echo 'Stage six already prepared' >&2; exit 1; }
  mkdir -p logs res/resv
  export cloud=T
  # Restore the official source, then save its fully prepared UI/server state.
  cp /work/official-signet/script/netvis/netshiny.R script/netvis/netshiny.R
  cat >> script/netvis/netshiny.R <<'RSCRIPT'

save.image(file=paste0(Sys.getenv("SIGNET_RESULT_ROOT"), "/resv/official-session.RData"))
RSCRIPT
  singularity exec --no-home "$sif" ./signet -v > logs/visualization.log 2>&1
  test -s res/resv/official-session.RData
  ;;
 stop)
  token=${3:?}; [[ $token =~ ^[a-f0-9-]{36}$ ]] || exit 2
  record="$root/logs/visualization-owner-$token"
  test -f "$record" || exit 0
  read -r pid birth < "$record"
  if [[ $pid =~ ^[0-9]+$ ]] && test -r "/proc/$pid/stat" && [[ $(awk '{print $22}' "/proc/$pid/stat") == "$birth" ]] && tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq "$token"; then
   kill -TERM -- "-$pid" 2>/dev/null || true
  fi
  ;;
 serve)
  token=${3:?}; [[ $token =~ ^[a-f0-9-]{36}$ ]] || exit 2
  port=${4:?}; [[ $port =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || exit 2
  echo "$$ $(awk '{print $22}' /proc/$$/stat)" > "$root/logs/visualization-owner-$token"
  test -s res/resv/official-session.RData
  singularity exec --no-home "$sif" Rscript /work/tools/serve-visualization.R "$root" "$port" "$token" &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true' EXIT HUP TERM INT
  wait "$child"
  ;;
 *) exit 2;;
esac
