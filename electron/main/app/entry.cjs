'use strict';
const {app, dialog} = require('electron');
const {openWorkspacePreview} = require('./workspace-preview.cjs');
// Electron loads the package entry through its own loader, so require.main
// does not identify this module. Keep executable startup separate from imports.
async function start() {
  if (process.argv.includes('--workspace-preview')) {
    app.setName('SIGNET Workspace Preview');
    app.on('window-all-closed', () => app.quit());
    await app.whenReady();
    return openWorkspacePreview();
  }
  const {launch, providerFromArgs} = require('./main.cjs');
  return launch({provider: providerFromArgs(process.argv), devMode: process.argv.includes('--dev')});
}

start().catch(async error => {
  await app.whenReady();
  dialog.showErrorBox('SIGNET could not start', error.message);
  app.exit(1);
});
