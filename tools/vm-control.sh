#!/bin/bash
# Fixed control operations. No Python control service, no user shell commands.
set -euo pipefail
mode=${1:?}; aid=${2:?}
[[ $aid =~ ^a-[0-9]{8}T[0-9]{6}-[a-f0-9]{12}$ ]] || exit 2
root=/work/runs/$aid
test -d "$root"
job_ids() {
  find "$root/tmp/tmpn" -name 'submit*_log' -type f -exec sed -n 's/.*Submitted batch job \([0-9]*\).*/\1/p' {} \; 2>/dev/null | sort -nu || true
}
case "$mode" in
 preflight)
  scontrol ping | grep -q UP
  test -z "$(squeue -h -o '%i')" || { echo 'Scheduler still has active jobs' >&2; exit 1; }
  for file in /proc/[0-9]*/cmdline; do
   test -r "$file" || continue
   if tr '\0' '\n' < "$file" 2>/dev/null | grep -Eq '^(/work/tools/run-stage.sh|/work/tools/run-network.sh|\./signet)$'; then
    echo 'Official analysis or controller still active; refusing a new launch' >&2; exit 1
   fi
  done
  echo ready
  ;;
 snapshot)
  for job in $(job_ids); do
   echo "ID $job"
   if record=$(scontrol show job "$job" -o 2>/dev/null); then echo "$record"; else echo "ERROR $job controller-record-expired"; fi
  done
  ;;
 cancel)
  # Only the isolated runner process group named in this run may be signalled.
  if test -f "$root/logs/remote-process"; then
   read -r pid birth < "$root/logs/remote-process"
   if [[ $pid =~ ^[0-9]+$ ]] && test -r "/proc/$pid/stat"; then
    actual=$(awk '{print $22}' "/proc/$pid/stat")
    if [[ $actual == "$birth" ]] && tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Eq "^($aid|$root)$"; then
     kill -TERM -- "-$pid" 2>/dev/null || true
     sleep 1
     kill -KILL -- "-$pid" 2>/dev/null || true
    fi
   fi
  fi
  # squeue catches a job submitted before its stdout reached the submission log.
  candidates=$( { job_ids; squeue -h -o '%i'; } | sort -nu)
  for job in $candidates; do
   record=$(scontrol show job "$job" -o 2>/dev/null) || continue
   work=$(sed -n 's/.* WorkDir=\([^ ]*\).*/\1/p' <<< "$record")
   if [[ $work == "$root" || $work == "$root/"* ]]; then scancel "$job"; echo "cancelled job=$job"; fi
  done
  # Confirm no owned jobs remain active; don't label cancellation complete on failure.
  for attempt in {1..10}; do
   remaining=0
   for job in $(squeue -h -o '%i'); do
    record=$(scontrol show job "$job" -o 2>/dev/null) || continue
    work=$(sed -n 's/.* WorkDir=\([^ ]*\).*/\1/p' <<< "$record")
    if [[ $work == "$root" || $work == "$root/"* ]]; then remaining=1; fi
   done
   test "$remaining" = 0 && break
   sleep 1
  done
  test "$remaining" = 0 || { echo 'Owned scheduler jobs are still active' >&2; exit 1; }
  if test -n "${pid:-}" && test -r "/proc/$pid/stat" && [[ $(awk '{print $22}' "/proc/$pid/stat") == "$birth" ]]; then
   echo 'Owned analysis process is still active' >&2; exit 1
  fi
  echo 'owned processes and jobs stopped'
  ;;
 *) exit 2;;
esac
