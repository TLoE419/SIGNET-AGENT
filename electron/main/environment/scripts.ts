import type {EnvironmentConfig} from '../../shared/environment/types';
import {runtimeModuleShell,modulePrelude} from './runtimeModules';
export interface Inventory {repository:string;revision:string;scripts:{path:string;sha256:string}[];support_files:{path:string;sha256:string}[]}
export const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export function validRemotePath(s:string){return s.length<=2048&&/^\/[A-Za-z0-9_./-]+$/.test(s)&&!s.split('/').includes('..')&&s!=='/'}
export function checksums(i:Inventory){return [...i.scripts,...i.support_files].map(x=>`${x.sha256}  ${x.path}`).join('\n')+'\n'}
export function sourceCheck(c:EnvironmentConfig,i:Inventory){return `(cd ${quote(c.source)} && sha256sum --check --status <<'SIGNET_HASHES'\n${checksums(i)}SIGNET_HASHES\n)`}
export function probe(root:string,partition:string,revision:string){return `set -eu
printf 'home=%s\\n' "$HOME"
${root?`root=${quote(root)}`:`signet_user=$(id -un)
if [ -d "/pub/$signet_user" ] && [ -w "/pub/$signet_user" ]; then root="/pub/$signet_user/signet-agent"; else root="$HOME/.local/share/signet-agent"; fi`}
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
export function verify(c:EnvironmentConfig){
 const settingsCheck=`set -euo pipefail
command -v Rscript >/dev/null
command -v ParaFly >/dev/null
command -v getopt >/dev/null
Rscript -e 'stopifnot(requireNamespace("data.table",quietly=TRUE))'
cd "$1/source"
test -f config.ini && test -r config.ini && test -s config.ini
# Upstream signet exits zero even when its settings reader fails; verify the actual output.
expected=$(sed '/^[[:space:]]*$/d' config.ini)
actual=$(bash ./signet -s | sed '/^[[:space:]]*$/d')
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
 echo 'SIGNET settings verification failed: output does not match config.ini.' >&2
 exit 1
fi
printf '%s\\n' "$actual"`;
 return `set -euo pipefail
${modulePrelude(c.runtimeModule)}
umask 077
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp -R ${quote(c.source)} "$stage/source"
# Only initialize the disposable copy; never replace an installed user configuration.
if [ ! -d "$stage/source" ] || [ -L "$stage/source" ]; then
 echo 'SIGNET verification source must be a copied directory, not a symlink.' >&2
 exit 1
fi
test ! -L "$stage/source/config.ini" || { echo 'config.ini must not be a symlink.' >&2; exit 1; }
if [ ! -e "$stage/source/config.ini" ]; then
 if [ -L "$stage/source/config.ini.default" ] || [ ! -f "$stage/source/config.ini.default" ] || [ ! -r "$stage/source/config.ini.default" ] || [ ! -s "$stage/source/config.ini.default" ]; then
  echo 'Cannot initialize config.ini: config.ini.default is missing, empty or unreadable.' >&2
  exit 1
 fi
 cp "$stage/source/config.ini.default" "$stage/source/config.ini"
fi
if [ ! -f "$stage/source/config.ini" ] || [ ! -r "$stage/source/config.ini" ] || [ ! -s "$stage/source/config.ini" ]; then
 echo 'config.ini is missing, empty or unreadable.' >&2
 exit 1
fi
${quote(c.executor)} exec --cleanenv --no-home --bind "$stage:$stage" ${quote(c.image)} bash -c ${quote(settingsCheck)} -- "$stage"
# Validate the configured queue, without submitting scientific work.
sinfo -h -p ${quote(c.partition)} -o '%P' | grep -q .
mkdir -p ${quote(c.workRoot)}
test -w ${quote(c.workRoot)}
`}
