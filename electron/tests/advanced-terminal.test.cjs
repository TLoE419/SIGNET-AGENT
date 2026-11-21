const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const read=path=>readFileSync(join(__dirname,'..',path),'utf8');
test('advanced terminal uses the existing broker and follows Settings visibility',()=>{
 assert.match(read('renderer/features/workspace/WorkspaceSshSettings.tsx'),/terminalActive=\{active\}/);
 assert.match(read('renderer/features/ssh/SshControls.tsx'),/devTerminal&&terminalActive&&<DevTerminalPanel/);
 assert.match(read('main/app/main.cjs'),/additionalArguments: devMode \? \['--signet-dev-terminal', '--signet-dev-mode'\] : \[\]/);
 assert.match(read('renderer/features/ssh/SshControls.tsx'),/desktop\.isDevMode===true&&devTerminal&&terminalActive/);
 assert.match(read('main/app/main.cjs'),/if\(devMode\)devTerminal=installDevTerminal/);
});
test('opening terminal views never starts a shell; only the explicit switch does',()=>{
 const source=read('renderer/features/devtools/DevTerminalPanel.tsx');
 assert.doesNotMatch(source,/void start\(\)/);
 assert.match(source,/onClick=\{\(\)=>void\(state==='Open'\?stop\(\):start\(\)\)\}/);
 assert.match(source,/return\(\)=>\{live=false;const id=session.current;session.current=null;if\(id\)void bridge.close\(id\)/);
});

test('terminal bridge requires both development flags and keeps normal SSH available',()=>{
 const {runInNewContext}=require('node:vm');
 for(const args of [[],['--signet-dev-terminal'],['--signet-dev-mode'],['--signet-dev-terminal','--signet-dev-mode']]){
  let exposed;
  runInNewContext(read('preload/index.cjs'),{process:{argv:args,isMainFrame:true},require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{exposed=value}},ipcRenderer:{}})});
  assert.equal(!!exposed.devTerminal,args.length===2);
  assert.equal(typeof exposed.ssh.connect,'function');
 }
});
