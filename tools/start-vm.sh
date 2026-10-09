#!/bin/bash
# Run on macOS from the SIGNET project root. Uses only task-specific containers.
set -euo pipefail
root=$(pwd)
test -f vm/jammy-amd64.img && test -f vm/user-data && test -f vm/meta-data
docker run --rm --platform linux/arm64 --mount "type=bind,src=$root,dst=/work" signet-qemu:20261006 bash -c '
  set -e
  test -f /work/vm/signet.qcow2 || qemu-img create -f qcow2 -F qcow2 -b /work/vm/jammy-amd64.img /work/vm/signet.qcow2 32G
  test -f /work/vm/seed.img || cloud-localds /work/vm/seed.img /work/vm/user-data /work/vm/meta-data
'
docker run -d --platform linux/arm64 --name signet-vm-20261006 --cpus 4 --memory 6g \
  -p 127.0.0.1:2226:2222 --mount "type=bind,src=$root,dst=/work" signet-qemu:20261006 \
  qemu-system-x86_64 -accel tcg,thread=multi -machine q35 -cpu max -smp 4 -m 5120 \
  -drive file=/work/vm/signet.qcow2,format=qcow2,if=virtio \
  -drive file=/work/vm/seed.img,format=raw,if=virtio \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=net0 \
  -virtfs local,path=/work,mount_tag=work,security_model=none,id=work \
  -display none -serial file:/work/vm/console.log
