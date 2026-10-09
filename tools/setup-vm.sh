#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl tzdata slurm-wlm munge openssh-client perl python3 squashfs-tools fuse2fs fuse-overlayfs uidmap libfuse2
curl -fL https://github.com/apptainer/apptainer/releases/download/v1.3.6/apptainer_1.3.6_amd64.deb -o /tmp/apptainer.deb
apt-get install -y /tmp/apptainer.deb
ln -sf /usr/bin/apptainer /usr/local/bin/singularity
mkdir -p /work
mountpoint -q /work || mount -t 9p -o trans=virtio,version=9p2000.L,msize=1048576 work /work
grep -q '^work /work ' /etc/fstab || echo 'work /work 9p trans=virtio,version=9p2000.L,msize=1048576,_netdev 0 0' >> /etc/fstab
hostname signet-local
systemctl stop slurmctld slurmd munge 2>/dev/null || true
# Reuse the recorded single-node configuration; keep daemons started by this script.
sed 's/exec sleep infinity/echo READY/' /work/tools/local-slurm.sh | bash
singularity --version
scontrol ping
sinfo -Nel
