'use strict';

const net = require('node:net');
const {mkdir, chmod, unlink, rmdir, lstat} = require('node:fs/promises');
const path = require('node:path');
const {timingSafeEqual} = require('node:crypto');

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class SshBroker {
  constructor({socketPath, token, service, environment}) {
    this.socketPath = socketPath;
    this.token = token;
    this.service = service;
    this.environment = environment;
    this.sockets = new Set();
  }
  async start() {
    const directory = path.dirname(this.socketPath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        (process.getuid && directoryStat.uid !== process.getuid())) throw Error('Unsafe SSH broker directory.');
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    await unlink(this.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.server = net.createServer(socket => this.handle(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600);
    return this.socketPath;
  }
  handle(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    let headerBuffer = Buffer.alloc(0), body = [], bodyLength = 0, header, handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      if (!header) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const newline = headerBuffer.indexOf(10);
        if (newline < 0) { if (headerBuffer.length > 65536) { handled = true; socket.destroy(); } return; }
        try { header = JSON.parse(headerBuffer.subarray(0, newline).toString('utf8')); }
        catch { handled = true; socket.destroy(); return; }
        const remainder = headerBuffer.subarray(newline + 1);
        if (remainder.length) { body.push(remainder); bodyLength += remainder.length; }
        headerBuffer = Buffer.alloc(0);
        if (!Number.isInteger(header.inputLength) || header.inputLength < 0 || header.inputLength > 1024 * 1024 * 1024) {
          handled = true; socket.destroy(); return;
        }
      } else {
        body.push(chunk);
        bodyLength += chunk.length;
      }
      if (bodyLength < header.inputLength) return;
      if (bodyLength !== header.inputLength) { handled = true; socket.destroy(); return; }
      handled = true;
      void this.request(header, Buffer.concat(body, bodyLength)).then(reply => {
        const response = Buffer.from(JSON.stringify({ok: true, value: {returncode: reply.returncode,
          signal: reply.signal, stdoutLength: reply.stdout.length, stderrLength: reply.stderr.length}}) + '\n');
        socket.write(response);
        socket.write(reply.stdout);
        socket.end(reply.stderr);
      }, error => {
        socket.end(JSON.stringify({ok: false, error: {code: error.code || 'UNKNOWN', message: error.message || 'SSH broker failed.'}}) + '\n');
      });
    });
  }
  async request(request, input) {
    if (!request || Object.keys(request).some(key => !['token', 'action', 'command', 'inputLength', 'timeoutMs'].includes(key)) ||
        !sameToken(request.token, this.token)) throw Error('Unauthorized SSH broker request.');
    if(request.action==='environment'&&input.length===0&&request.inputLength===0){
      const value=this.environment?.getSnapshot();
      if(!value||value.phase!=='ready')throw Error('Prepare the SIGNET environment in Electron before running scientific work.');
      return {returncode:0,stdout:Buffer.from(JSON.stringify(value.config)),stderr:Buffer.alloc(0)};
    }
    if (request.action !== 'exec' || input.length !== request.inputLength) throw Error('Unsupported SSH broker action.');
    const result = await this.service.exec(request.command, input, request.timeoutMs);
    return result;
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await unlink(this.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(path.dirname(this.socketPath)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
}

module.exports = {SshBroker, sameToken};
