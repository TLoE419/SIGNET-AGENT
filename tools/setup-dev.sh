#!/bin/bash
# Installs only development dependencies; does not boot a VM or launch scientific work.
set -euo pipefail
project_root=$(cd "$(dirname "$0")/.." && pwd)
command -v node >/dev/null && command -v npm >/dev/null || { echo 'Install Node.js 24 LTS (minimum 22.12.0) and npm first.' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){console.error("Node.js >=22.12.0 is required");process.exit(1)}'
bash "$project_root/tools/download-official.sh"
cd "$project_root/desktop"
npm ci
npx --no-install install-electron --no
npm test
echo 'Development setup complete. Start the desktop with: cd desktop && npm start'
