// Opt-in parity check against a previously completed real simulation; no compute is launched.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const R=require('./core/results.cjs'),F=require('./core/files.cjs'),{LEGACY}=require('./core/store.cjs');
const root=path.resolve(process.env.SIGNET_SCIENTIFIC_ROOT||path.join(__dirname,'..'));
test('every real simulation edge and coefficient matches its preserved verified result',()=>{
 const run=path.join(root,'runs',LEGACY),expectedFile=path.join(root,'results/actual/network.json');
 assert.ok(fs.existsSync(expectedFile)&&fs.existsSync(path.join(run,'logs/verification.json')),
  'Real reference data is not included in Git. See docs/INSTALL.md; set SIGNET_SCIENTIFIC_ROOT to an existing reference-data folder.');
 const expected=F.read(expectedFile),actual=R.network(path.join(run,'res/resn'));
 assert.deepEqual(actual.edges,expected.edges);assert.deepEqual(actual.shape,[95,86]);assert.deepEqual(actual.counts,expected.counts);
 assert.deepEqual(R.verify(run,2).job_ids,['1','2','3','4','5']);
});
