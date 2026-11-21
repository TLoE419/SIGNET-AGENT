import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const absWorkingDir=fileURLToPath(root);
await build({absWorkingDir,entryPoints:{index:'main/ssh/index.ts','key-worker':'main/ssh/keys/key-worker.ts'},outdir:'build/ssh',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron','ssh2','node-pty'],target:'node22'});
await build({absWorkingDir,entryPoints:['renderer/app/main.tsx'],outfile:'build/renderer/renderer.js',bundle:true,platform:'browser',loader:{'.css':'text'},format:'iife',target:'chrome140',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
await mkdir(new URL('build/renderer/vendor/',root),{recursive:true});
for(const [source,output] of [['index.html','index.html'],['features/chat/markdown.js','chat-markdown.js'],['styles/chat.css','chat.css'],['styles/ssh.css','ssh.css'],['vendor/vis-network.min.js','vendor/vis-network.min.js']]){
 await copyFile(new URL('renderer/'+source,root),new URL('build/renderer/'+output,root));
}
await mkdir(new URL('build/renderer/workspace/',root), {recursive:true});
for (const file of ['index.html', 'workspace.css', 'workspace.js', 'job-logs.js', 'genotype-run.js', 'input-validation.js', 'result-assets.js', 'result-assets.css', 'icons.js', 'interaction.js', 'LUCIDE-LICENSE.txt']) {
  await copyFile(new URL('renderer/features/workspace/'+file,root),new URL('build/renderer/workspace/'+file,root));
}
// Existing chat/graph controllers share a lexical scope until their React migration.
const classic=await Promise.all(['features/chat/markdown.js','features/chat/chat.js','features/stage6/stage6.js','workflow.js'].map(file=>readFile(new URL('renderer/'+file,root),'utf8')));
await writeFile(new URL('build/renderer/workspace.js',root),classic.join('\n;\n'));

await writeFile(new URL('build/renderer/chat.css',root),(await readFile(new URL('renderer/styles/chat.css',root),'utf8'))+'\n'+(await readFile(new URL('renderer/workflow.css',root),'utf8')));
