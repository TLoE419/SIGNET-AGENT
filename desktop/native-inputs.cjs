const {randomUUID}=require('node:crypto');
const {exact,fields}=require('./core/drafts.cjs');
class NativeInputs{
 constructor(clock=Date.now){this.clock=clock;this.items=new Map();this.ttl=15*60*1000;}
 add(key,cohort,workflow,source){this.prune();while(this.items.size>=128)this.items.delete(this.items.keys().next().value);const token=randomUUID();this.items.set(token,{key,cohort,workflow,source,expires:this.clock()+this.ttl});return token;}
 prune(){for(const [k,v]of this.items)if(v.expires<=this.clock())this.items.delete(k);}
 resolve(p){this.prune();exact(p.inputs,fields(p.workflow,p.cohort).map(f=>f[0]));const sources={};for(const [key,input]of Object.entries(p.inputs)){
  exact(input,['ref','token']);if(Object.keys(input).length!==1)throw Error('Select exactly one input reference');
  if(Object.hasOwn(input,'ref')){if(typeof input.ref!=='string')throw Error('Invalid persisted reference');continue;}
  const selected=this.items.get(input.token);if(!selected||selected.key!==key||selected.cohort!==p.cohort||selected.workflow!==p.workflow)throw Error('Expired or mismatched native picker reference; select again');sources[key]=selected.source;
 }return sources;}
}
module.exports={NativeInputs};
