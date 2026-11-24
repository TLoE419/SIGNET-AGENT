import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const absWorkingDir=fileURLToPath(root);
await build({absWorkingDir,entryPoints:{index:'main/ssh/index.ts','key-worker':'main/ssh/keys/key-worker.ts'},outdir:'build/ssh',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron','ssh2','node-pty'],target:'node22'});
await build({absWorkingDir,entryPoints:['renderer/app/main.tsx'],outfile:'build/renderer/renderer.js',bundle:true,platform:'browser',loader:{'.css':'text'},format:'iife',target:'chrome140',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
await mkdir(new URL('build/renderer/',root),{recursive:true});
for(const [source,output] of [['features/chat/markdown.js','chat-markdown.js'],['index.html','index.html'],['styles/chat.css','chat.css'],['styles/ssh.css','ssh.css']]){
 await copyFile(new URL('renderer/'+source,root),new URL('build/renderer/'+output,root));
}
await mkdir(new URL('build/renderer/workspace/',root), {recursive:true});
for (const file of ['index.html', 'workspace.css', 'workspace.js', 'job-logs.js', 'genotype-run.js', 'input-validation.js', 'stage6-dashboard.js', 'result-assets.js', 'result-assets.css', 'icons.js', 'interaction.js', 'LUCIDE-LICENSE.txt']) {
  await copyFile(new URL('renderer/features/workspace/'+file,root),new URL('build/renderer/workspace/'+file,root));
}
// Existing chat controllers share a lexical scope until their React migration.
const workspace=await Promise.all(['i18n/index.js','features/chat/markdown.js','features/chat/chat.js','features/chat/step-review.js','features/chat/analysis-results.js','features/chat/analysis-progress.js','workflow.js'].map(file=>readFile(new URL('renderer/'+file,root),'utf8')));
await writeFile(new URL('build/renderer/workspace.js',root),workspace.join('\n;\n'));

await writeFile(new URL('build/renderer/chat.css',root),(await readFile(new URL('renderer/styles/chat.css',root),'utf8'))+'\n'+(await readFile(new URL('renderer/workflow.css',root),'utf8')));
