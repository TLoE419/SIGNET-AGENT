#!/bin/bash
# Keep the failed VM and its disk immutable; repair in a copy-on-write overlay.
set -euo pipefail
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
project=${SIGNET_RUNTIME_PROJECT:-$script_root/.dependencies/scientific-runtime}
if [[ $project != /* ]]; then project=$script_root/$project; fi
port=${SIGNET_SSH_PORT:-2226}
if [[ ! $port =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo 'SIGNET_SSH_PORT must be between 1 and 65535.' >&2
  exit 1
fi
if [[ ! -d $project/vm ]]; then
  echo 'Existing VM assets required. Set SIGNET_RUNTIME_PROJECT; see docs/ADVANCED.md.' >&2
  exit 1
fi
image=signet-qemu:20261006
original=signet-vm-20261006
stable=signet-vm-stable-20261020
if [[ $(docker inspect -f '{{.State.Running}}' "$original") != false ]]; then
  echo 'Stop the original VM before using its disk as an overlay backing file.' >&2
  exit 1
fi
if docker inspect "$stable" >/dev/null 2>&1; then
  docker start "$stable"
  exit
fi
if [[ ! -f $project/vm/signet-stable-20261020.qcow2 ]]; then
  docker run --rm --platform linux/arm64 --mount "type=bind,src=$project,dst=/work" "$image" \
    qemu-img create -f qcow2 -F qcow2 -b /work/vm/signet.qcow2 /work/vm/signet-stable-20261020.qcow2
fi
docker run -d --platform linux/arm64 --name "$stable" --cpus 4 --memory 6g \
  -p 127.0.0.1:$port:2222 --mount "type=bind,src=$project,dst=/work" "$image" \
  qemu-system-x86_64 -accel tcg,thread=single -machine q35 -cpu max -smp 4 -m 5120 \
  -drive file=/work/vm/signet-stable-20261020.qcow2,format=qcow2,if=virtio \
  -drive file=/work/vm/seed.img,format=raw,if=virtio \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=net0 \
  -virtfs local,path=/work,mount_tag=work,security_model=none,id=work \
  -display none -serial file:/work/vm/console-stable-20261020.log
