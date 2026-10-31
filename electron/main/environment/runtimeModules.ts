import {readFileSync} from 'node:fs';
import path from 'node:path';
// Both source main/environment and bundled build/ssh sit three levels below the root.
export const runtimeModuleShell=readFileSync(path.join(__dirname,'../../../runtime_modules.sh'),'utf8');
export const validRuntimeModule=(name:string)=>/^(singularity|apptainer)\/[0-9][A-Za-z0-9_.+-]*$/.test(name);
export function modulePrelude(name?:string){
 if(name===undefined)return '';
 if(!validRuntimeModule(name))throw Error('Invalid container runtime module.');
 return `${runtimeModuleShell}\nif ! signet_load_module '${name}'; then echo 'Could not load container module ${name}.' >&2; exit 1; fi\n`;
}
