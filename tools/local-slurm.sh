#!/bin/bash
set -euo pipefail
mkdir -p /run/munge /var/lib/slurm/slurmd /var/lib/slurm/slurmctld /var/log/slurm
chown -R munge:munge /run/munge /var/log/munge /var/lib/munge /etc/munge
test -f /etc/munge/munge.key || dd if=/dev/urandom of=/etc/munge/munge.key bs=1024 count=1 status=none
chown munge:munge /etc/munge/munge.key
chmod 400 /etc/munge/munge.key
cat > /etc/slurm/slurm.conf <<'EOF'
ClusterName=signet-local
SlurmctldHost=signet-local
SlurmUser=root
SlurmdUser=root
AuthType=auth/munge
StateSaveLocation=/var/lib/slurm/slurmctld
SlurmdSpoolDir=/var/lib/slurm/slurmd
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log
SlurmctldPidFile=/run/slurmctld.pid
SlurmdPidFile=/run/slurmd.pid
ProctrackType=proctrack/linuxproc
TaskPlugin=task/none
SelectType=select/cons_tres
SelectTypeParameters=CR_Core_Memory
SchedulerType=sched/backfill
AccountingStorageType=accounting_storage/none
JobAcctGatherType=jobacct_gather/none
MinJobAge=3600
ReturnToService=2
MpiDefault=none
NodeName=signet-local CPUs=4 Sockets=1 CoresPerSocket=4 ThreadsPerCore=1 RealMemory=4500 State=UNKNOWN
PartitionName=local Nodes=signet-local Default=YES MaxTime=01:00:00 State=UP
EOF
node_configuration=$(/usr/sbin/slurmd -C | head -n1 | sed -E 's/RealMemory=[0-9]+/RealMemory=4500/; s/ UpTime=.*//')
sed -i "s/^NodeName=.*/$node_configuration State=UNKNOWN/" /etc/slurm/slurm.conf
runuser -u munge -- /usr/sbin/munged
/usr/sbin/slurmctld
/usr/sbin/slurmd
exec sleep infinity
