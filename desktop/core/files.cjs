const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function digest(file) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function hashes(root) {
  const result = {};
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Error('Analysis inputs cannot contain symlinks: ' + file);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result[path.relative(root, file)] = digest(file);
    }
  }
  walk(root); return result;
}
function copy(source, target) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw Error('Symlink inputs are not accepted');
  if (info.isDirectory()) {
    fs.mkdirSync(target, {recursive: true});
    for (const name of fs.readdirSync(source)) if (name !== '.git') copy(path.join(source,name),path.join(target,name));
  } else if (info.isFile()) {
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, info.mode & 0o777);
  } else throw Error('Only regular files and folders can be imported');
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function lines(file) { return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(s=>s.trim()); }
module.exports = {read, write, digest, hashes, copy, alive, lines};
