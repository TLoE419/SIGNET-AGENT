import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const absWorkingDir=fileURLToPath(root);
await build({absWorkingDir,entryPoints:['main/ssh/index.ts','main/ssh/keys/key-worker.ts'],outdir:'build/ssh',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron','ssh2','node-pty'],target:'node22'});
await build({absWorkingDir,entryPoints:['renderer/app/main.tsx'],outfile:'build/renderer/renderer.js',bundle:true,platform:'browser',loader:{'.css':'text'},format:'iife',target:'chrome140',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
await mkdir(new URL('build/renderer/vendor/',root),{recursive:true});
for(const [source,output] of [['index.html','index.html'],['styles/chat.css','chat.css'],['styles/ssh.css','ssh.css'],['vendor/vis-network.min.js','vendor/vis-network.min.js']]){
 await copyFile(new URL('renderer/'+source,root),new URL('build/renderer/'+output,root));
}
// Existing chat/graph controllers share a lexical scope until their React migration.
const workspace=await Promise.all(['i18n/index.js','features/chat/chat.js','features/stage6/stage6.js'].map(file=>readFile(new URL('renderer/'+file,root),'utf8')));
await writeFile(new URL('build/renderer/workspace.js',root),workspace.join('\n;\n'));
