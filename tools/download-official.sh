#!/bin/bash
# Fetch the exact official source used by the desktop contracts. Never replace an existing checkout.
set -euo pipefail
project_root=$(cd "$(dirname "$0")/.." && pwd)
destination=${1:-"$project_root/official-signet"}
revision=bed55b3e121de0edf5fd43da683dc59850ff82d3
repository=https://github.com/signet4grn/SIGNET.git
command -v git >/dev/null || { echo 'Install Git first.' >&2; exit 1; }
if [[ -e "$destination" ]]; then
  [[ -d "$destination/.git" ]] || { echo 'Destination exists and is not the official Git checkout; move it manually.' >&2; exit 1; }
  [[ $(git -C "$destination" rev-parse HEAD) == "$revision" ]] || { echo 'Existing official checkout has a different revision; it was not changed.' >&2; exit 1; }
  [[ $(git -C "$destination" remote get-url origin) == "$repository" ]] || { echo 'Existing checkout has an unexpected source; it was not changed.' >&2; exit 1; }
  [[ -z $(git -C "$destination" status --porcelain) ]] || { echo 'Existing official checkout has local changes; it was not changed.' >&2; exit 1; }
  echo "Official source already verified: $revision"
  exit 0
fi
mkdir -p "$(dirname "$destination")"
staging=$(mktemp -d "$(dirname "$destination")/.signet-download.XXXXXX")
trap 'rm -rf "$staging"' EXIT
git -C "$staging" init -q
git -C "$staging" remote add origin "$repository"
git -C "$staging" fetch --depth 1 origin "$revision"
git -C "$staging" checkout -q --detach FETCH_HEAD
[[ $(git -C "$staging" rev-parse HEAD) == "$revision" ]]
test -f "$staging/signet" && test -f "$staging/LICENSE.txt"
[[ ! -e "$destination" ]] || { echo 'Destination appeared during download; leaving it unchanged.' >&2; exit 1; }
mv "$staging" "$destination"
echo "Official source installed: $destination ($revision)"
