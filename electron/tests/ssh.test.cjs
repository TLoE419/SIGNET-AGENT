'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {SshBroker}=require('../main/ssh/ipc/broker.cjs');
test('private broker requires its launch token and returns binary command output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signet-broker-'));
  const socketPath = path.join(root, 'runtime', 'broker.sock');
  const service = {publicSnapshot: () => ({connection:{status:'connected'}}),
    exec: async (_command, input) => ({returncode:0, signal:null, stdout:Buffer.from(`ok:${input.length}`), stderr:Buffer.alloc(0)})};
  const broker = new SshBroker({socketPath, token:'correct-token', service});
  await broker.start();
  async function send(request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const chunks = [];
      socket.on('connect', () => {
        const input = request.input || Buffer.alloc(0);
        socket.write(JSON.stringify({...request, input:undefined, inputLength:input.length}) + '\n');
        socket.write(input);
      });
      socket.on('data', chunk => { chunks.push(chunk); });
      socket.on('end', () => {
        const data = Buffer.concat(chunks), newline = data.indexOf(10);
        const reply = JSON.parse(data.subarray(0, newline));
        if (reply.ok) {
          const start = newline + 1, split = start + reply.value.stdoutLength;
          reply.stdout = data.subarray(start, split);
          reply.stderr = data.subarray(split);
        }
        resolve(reply);
      });
      socket.on('error', reject);
    });
  }
  try {
    const denied = await send({token:'wrong', action:'status'});
    assert.equal(denied.ok, false);
    const reply = await send({token:'correct-token', action:'exec', command:'true', input:Buffer.from('abc'), timeoutMs:1000});
    assert.equal(reply.ok, true);
    assert.equal(reply.stdout.toString(), 'ok:3');
  } finally { await broker.close(); }
});

test('broker shutdown closes incomplete local clients without hanging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signet-broker-close-'));
  const socketPath = path.join(root, 'runtime', 'broker.sock');
  const broker = new SshBroker({socketPath, token:'correct-token', service:{exec: async () => assert.fail()}});
  await broker.start();
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await broker.close();
  await closed;
  assert.equal(socket.destroyed, true);
});

test('Python can query only a ready environment through the authenticated broker',async()=>{
 let phase='checking';
 const config={image:'/home/user/signet/image.sif'};
 const broker=new SshBroker({socketPath:'/unused',token:'token',service:{},environment:{getSnapshot:()=>({phase,config})}});
 await assert.rejects(()=>broker.request({token:'wrong',action:'environment',inputLength:0},Buffer.alloc(0)),/Unauthorized/);
 await assert.rejects(()=>broker.request({token:'token',action:'environment',inputLength:0},Buffer.alloc(0)),/Prepare/);
 phase='ready';
 assert.deepEqual(JSON.parse((await broker.request({token:'token',action:'environment',inputLength:0},Buffer.alloc(0))).stdout),config);
});
