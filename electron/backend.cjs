'use strict';
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {existsSync} = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ROOT = path.resolve(__dirname, '..');

function pythonExecutable() {
  if (process.env.SIGNET_PYTHON) return process.env.SIGNET_PYTHON;
  const local = path.join(ROOT, '.venv', 'bin', 'python');
  return existsSync(local) ? local : 'python3';
}

class Backend extends EventEmitter {
  constructor({stateFile, provider = 'codex', python = pythonExecutable(), startupMs = 30000, sshBroker} = {}) {
    super();
    if (!['codex', 'gemini', 'groq'].includes(provider)) throw Error('Unsupported model provider.');
    if (!stateFile || !path.isAbsolute(stateFile)) throw Error('An absolute state path is required.');
    this.options = {stateFile, provider, python, startupMs, sshBroker};
    this.stopping = false;
  }

  start() {
    if (this.child) throw Error('Backend already started.');
    const {python, provider, stateFile, startupMs, sshBroker} = this.options;
    this.child = spawn(python, ['-u', path.join(__dirname, 'server.py'), '--provider', provider, '--state-file', stateFile], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], detached: true,
      env: {...process.env, PYTHONUNBUFFERED: '1',
        ...(sshBroker ? {SIGNET_SSH_BROKER: sshBroker.path, SIGNET_SSH_BROKER_TOKEN: sshBroker.token} : {})},
    });
    const child = this.child;
    child.stdin.on('error', () => {}); // EPIPE during child shutdown is expected.
    this.closed = new Promise(resolve => {
      child.once('close', (code, signal) => {
        this.exited = true;
        resolve({code, signal});
        this.emit('closed', {code, signal});
      });
    });
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = message => {
        clearTimeout(timer);
        this.forceStop();
        reject(Error(message));
      };
      const timer = setTimeout(() => fail('Python service did not start within 30 seconds.'), startupMs);
      child.once('error', () => fail('Could not launch Python. Install requirements.txt and check SIGNET_PYTHON.'));
      child.once('close', () => {
        clearTimeout(timer);
        if (!ready) reject(Error('Python service exited before startup. Check Python dependencies, provider configuration and the terminal output.'));
      });
      const lines = readline.createInterface({input: child.stdout});
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return fail('Invalid Python lifecycle response.'); }
        if (message.event === 'ready' && !ready) {
          if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return fail('Invalid Python listening port.');
          clearTimeout(timer);
          ready = true;
          this.origin = `http://127.0.0.1:${message.port}`;
          resolve(this.origin);
        }
      });
    });
  }

  stop() {
    this.stopping = true;
    if (this.child && !this.exited) this.child.stdin.end();
    return this.closed || Promise.resolve();
  }

  forceStop() {
    this.stopping = true;
    if (this.child?.pid && !this.exited) {
      try { process.kill(-this.child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return this.closed || Promise.resolve();
  }
}
module.exports = {Backend, pythonExecutable};
