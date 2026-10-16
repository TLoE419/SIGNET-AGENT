'use strict';
const fs=require('node:fs'),path=require('node:path');
const CURRENT_SOURCE=fs.realpathSync(path.resolve(__dirname,'../..'));
const fail=()=>{throw Object.assign(Error('runtime-not-isolated'),{code:'runtime-not-isolated'});};
const within=(root,source)=>root===source||root.startsWith(source+path.sep);
function directory(root){
 if(typeof root!=='string'||root.length>4096||!path.isAbsolute(root)||path.resolve(root)!==root||root===path.parse(root).root)fail();
 let at=path.parse(root).root;
 for(const part of root.slice(at.length).split(path.sep)){
  at=path.join(at,part);const st=fs.lstatSync(at);
  if(st.isSymbolicLink()||!st.isDirectory())fail();
 }
 return fs.realpathSync(root);
}
// Supplied by the trusted main process, never by a renderer request or the working directory.
function sourceContext(original=process.env.SIGNET_ORIGINAL_SOURCE_ROOT){
 return Object.freeze({currentSourceRoot:CURRENT_SOURCE,originalSourceRoot:directory(original)});
}
function validateSourceContext(context){
 if(!context||Object.getPrototypeOf(context)!==Object.prototype||Object.keys(context).length!==2||context.currentSourceRoot!==CURRENT_SOURCE||!Object.hasOwn(context,'originalSourceRoot'))fail();
 return sourceContext(context.originalSourceRoot);
}
function runtimeRoot(root,context=sourceContext()){
 const trusted=validateSourceContext(context);
 if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)fail();
 for(const source of [CURRENT_SOURCE,trusted.originalSourceRoot])if(within(root,source))fail();
 const real=directory(root);
 for(const source of [CURRENT_SOURCE,trusted.originalSourceRoot])if(within(real,source))fail();
 return real;
}
module.exports={sourceContext,validateSourceContext,runtimeRoot};
