const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const read=path=>readFileSync(join(__dirname,'..',path),'utf8');
test('advanced terminal uses the existing broker and follows Settings visibility',()=>{
 assert.match(read('renderer/features/workspace/WorkspaceSshSettings.tsx'),/terminalActive=\{active\}/);
 assert.match(read('renderer/features/ssh/SshControls.tsx'),/devTerminal&&terminalActive&&<DevTerminalPanel/);
 assert.match(read('main/app/main.cjs'),/additionalArguments: \['--signet-dev-terminal', \.\.\.\(devMode \? \['--signet-dev-mode'\] : \[\]\)\]/);
 assert.match(read('preload/index.cjs'),/isDevMode:process\.argv\.includes\('--signet-dev-mode'\)/);
 assert.match(read('renderer/features/ssh/SshControls.tsx'),/\(renderStatus\|\|desktop\.isDevMode===true\)&&devTerminal&&terminalActive/);
 assert.doesNotMatch(read('main/app/main.cjs'),/if\(devMode\)devTerminal=/);
});
test('opening terminal views never starts a shell; only the explicit switch does',()=>{
 const source=read('renderer/features/devtools/DevTerminalPanel.tsx');
 assert.doesNotMatch(source,/void start\(\)/);
 assert.match(source,/onClick=\{\(\)=>void\(state==='Open'\?stop\(\):start\(\)\)\}/);
 assert.match(source,/return\(\)=>\{live=false;const id=session.current;session.current=null;if\(id\)void bridge.close\(id\)/);
});
