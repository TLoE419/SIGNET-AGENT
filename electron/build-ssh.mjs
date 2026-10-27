import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const absWorkingDir = fileURLToPath(new URL('.', import.meta.url));
await build({absWorkingDir, entryPoints:['src/ssh/index.ts','src/ssh/key-worker.ts'],outdir:'build/ssh',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron','ssh2'],target:'node22'});
await build({absWorkingDir, entryPoints:['src/ssh/renderer.tsx'],outfile:'build/ssh-ui.js',bundle:true,platform:'browser',format:'iife',target:'chrome140',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
