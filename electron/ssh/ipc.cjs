'use strict';

function installSshHandlers({ipcMain, dialog, service, getWindow, getOrigin}) {
  const operations = {
    snapshot: () => service.publicSnapshot(),
    saveProfile: input => service.saveProfile(input),
    selectProfile: id => service.selectProfile(id),
    inspectPrivateKey: keyPath => service.inspectPrivateKey(keyPath),
    listKeys: () => service.listKeys(),
    generateKey: input => service.generateKey(input),
    connect: (id, passphrase) => service.connect(id, passphrase),
    disconnect: () => service.disconnect(),
    trustHost: identity => service.trustHost(identity),
    pickPrivateKey: async () => {
      const window = getWindow();
      const choice = await dialog.showOpenDialog(window, {title: 'Select an encrypted OpenSSH private key', properties: ['openFile']});
      if (choice.canceled || !choice.filePaths[0]) return {canceled: true};
      return {canceled: false, path: choice.filePaths[0], name: require('node:path').basename(choice.filePaths[0])};
    },
  };
  const trusted = event => {
    const window = getWindow(), origin = getOrigin();
    if (!window || !origin || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  for (const [name, operation] of Object.entries(operations)) {
    ipcMain.handle(`ssh:${name}`, async (event, ...args) => {
      if (!trusted(event)) return {ok: false, error: {code: 'UNTRUSTED', message: 'Untrusted SSH request.'}};
      try { return {ok: true, value: await operation(...args)}; }
      catch (error) { return {ok: false, error: {code: error.code || 'UNKNOWN', message: error.message || 'SSH operation failed.'}}; }
    });
  }
  const listener = snapshot => {
    const window = getWindow(), origin = getOrigin();
    if (!window || window.isDestroyed() || !origin) return;
    try { if (new URL(window.webContents.mainFrame.url).origin === origin) window.webContents.send('ssh:snapshot', snapshot); }
    catch {}
  };
  service.on('snapshot', listener);
  return () => {
    service.off('snapshot', listener);
    for (const name of Object.keys(operations)) ipcMain.removeHandler(`ssh:${name}`);
  };
}

module.exports = {installSshHandlers};
