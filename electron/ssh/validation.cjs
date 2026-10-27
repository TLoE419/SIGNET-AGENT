'use strict';

class SshFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) { throw new SshFailure(code, message); }
function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function absolutePath(value) {
  return text(value, 4096) && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}
function profileInput(value) {
  const p = value;
  if (!p || typeof p !== 'object' || Array.isArray(p) ||
      Object.keys(p).some(key => !['id', 'name', 'host', 'port', 'username', 'privateKeyPath', 'keyId'].includes(key)) ||
      (p.id !== undefined && (!text(p.id, 80) || !/^[a-zA-Z0-9_-]+$/.test(p.id))) ||
      !text(p.name, 120) || !text(p.host, 253) || !/^[a-zA-Z0-9:][a-zA-Z0-9.:-]*$/.test(p.host) ||
      !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 ||
      !text(p.username, 128) || !/^[a-zA-Z0-9_.@-]+$/.test(p.username) ||
      !absolutePath(p.privateKeyPath) ||
      (p.keyId !== undefined && (!text(p.keyId, 80) || !/^[a-zA-Z0-9_-]+$/.test(p.keyId)))) {
    fail('INVALID_PROFILE', 'Enter a name, host, port, username and an absolute private-key path.');
  }
  return {...p, host: p.host.toLowerCase()};
}

function safeError(error) {
  if (error instanceof SshFailure) return error;
  const code = error?.code || '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) {
    return new SshFailure('NETWORK_UNREACHABLE', 'Cannot reach the SSH host. Check the address, network or VPN.');
  }
  if (code === 'ETIMEDOUT' || error?.level === 'client-timeout') {
    return new SshFailure('CONNECTION_TIMEOUT', 'The SSH connection timed out.');
  }
  if (error?.level === 'client-authentication') {
    return new SshFailure('AUTH_FAILED', 'The host rejected the selected username or private key.');
  }
  return new SshFailure('UNKNOWN', 'The SSH operation failed. Check the profile and connection.');
}

module.exports = {SshFailure, fail, text, absolutePath, profileInput, safeError};
