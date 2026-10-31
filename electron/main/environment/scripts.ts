import type {EnvironmentConfig} from '../../shared/environment/types';
import {runtimeModuleShell,modulePrelude} from './runtimeModules';
export interface Inventory {repository:string;revision:string;scripts:{path:string;sha256:string}[];support_files:{path:string;sha256:string}[]}
export const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export function validRemotePath(s:string){return s.length<=2048&&/^\/[A-Za-z0-9_./-]+$/.test(s)&&!s.split('/').includes('..')&&s!=='/'}
export function checksums(i:Inventory){return [...i.scripts,...i.support_files].map(x=>`${x.sha256}  ${x.path}`).join('\n')+'\n'}
export function sourceCheck(c:EnvironmentConfig,i:Inventory){return `(cd ${quote(c.source)} && sha256sum --check --status <<'SIGNET_HASHES'\n${checksums(i)}SIGNET_HASHES\n)`}
export function probe(root:string,partition:string,revision:string){return `set -eu
printf 'home=%s\\n' "$HOME"
root=${root?quote(root):'"$HOME/.local/share/signet-agent"'}
printf 'root=%s\\n' "$root"
for tool in bash git tar sha256sum timeout python3 setsid sbatch scontrol sinfo squeue; do
 if command -v "$tool" >/dev/null 2>&1; then printf '%s=yes\\n' "$tool"; else printf '%s=no\\n' "$tool"; fi
done
${runtimeModuleShell}
signet_find_runtime
printf 'executor=%s\\n' "$executor"
printf 'runtime_module=%s\\n' "$runtime_module"
partition=${quote(partition)}
if [ -z "$partition" ] && command -v sinfo >/dev/null 2>&1; then partition=$(sinfo -h -o '%P' 2>/dev/null | sed -n 's/\\*$//p' | head -1); fi
printf 'partition=%s\\n' "$partition"
if [ -e "$root/software/${revision}" ]; then printf 'source=exists\\n'; else printf 'source=missing\\n'; fi
if [ -s "$root/images/signet-0.0.6.sif" ]; then printf 'image=exists\\n'; else printf 'image=missing\\n'; fi
# Probe permission without creating directories during automatic checks.
parent="$root"; while [ ! -e "$parent" ]; do parent=$(dirname "$parent"); done
if [ -d "$parent" ] && [ -w "$parent" ]; then printf 'writable=yes\\n'; else printf 'writable=no\\n'; fi
`}
export function installSource(c:EnvironmentConfig,i:Inventory){
 const files=[...i.scripts,...i.support_files].map(x=>x.path).concat(['LICENSE.txt','LICENSE_THIRD_PARTY.md']);
 return `set -euo pipefail
umask 077
mkdir -p ${quote(c.root+'/software')}
[ ! -e ${quote(c.source)} ] || { echo 'Source destination already exists; choose a new root.' >&2; exit 1; }
stage=$(mktemp -d ${quote(c.root+'/software/.install-XXXXXX')})
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/repository" "$stage/source"
git -C "$stage/repository" init -q
git -C "$stage/repository" fetch -q --depth=1 ${quote(i.repository)} ${quote(i.revision)}
git -C "$stage/repository" archive ${quote(i.revision)} -- ${files.map(quote).join(' ')} | tar -xf - -C "$stage/source"
(cd "$stage/source" && sha256sum --check --status <<'SIGNET_HASHES'
${checksums(i)}SIGNET_HASHES
)
# -T refuses replacement if a directory appeared while downloading.
mv -T -n "$stage/source" ${quote(c.source)}
${sourceCheck(c,i)}
`;
}
export function installImage(c:EnvironmentConfig){return `set -euo pipefail
${modulePrelude(c.runtimeModule)}
umask 077
mkdir -p ${quote(c.root+'/images')}
[ ! -e ${quote(c.image)} ] || { echo 'Image destination already exists; choose a new root.' >&2; exit 1; }
stage=$(mktemp -d ${quote(c.root+'/images/.install-XXXXXX')})
trap 'rm -rf -- "$stage"' EXIT
${quote(c.executor)} pull "$stage/signet.sif" library://jiang548/signet/signet:0.0.6
${quote(c.executor)} exec --cleanenv --no-home "$stage/signet.sif" bash -c 'command -v Rscript >/dev/null && command -v ParaFly >/dev/null && command -v getopt >/dev/null'
[ ! -e ${quote(c.image)} ]
# Hard-link publication refuses any existing target; stage is on the same filesystem.
ln "$stage/signet.sif" ${quote(c.image)}
`}
export function verify(c:EnvironmentConfig){return `set -euo pipefail
${modulePrelude(c.runtimeModule)}
umask 077
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp -R ${quote(c.source)} "$stage/source"
${quote(c.executor)} exec --cleanenv --no-home --bind "$stage:$stage" ${quote(c.image)} bash -c ${quote(`command -v Rscript >/dev/null && command -v ParaFly >/dev/null && command -v getopt >/dev/null && Rscript -e 'stopifnot(requireNamespace("data.table",quietly=TRUE))' && cd "$1/source" && bash ./signet -s`)} -- "$stage"
# Validate the configured queue, without submitting scientific work.
sinfo -h -p ${quote(c.partition)} -o '%P' | grep -q .
mkdir -p ${quote(c.workRoot)}
test -w ${quote(c.workRoot)}
`}
