'use strict';
const {app, dialog} = require('electron');
const {launch, providerFromArgs} = require('./main.cjs');
// Electron loads the package entry through its own loader, so require.main
// does not identify this module. Keep executable startup separate from imports.
Promise.resolve().then(() => launch({provider: providerFromArgs(process.argv)})).catch(async error => {
  await app.whenReady();
  dialog.showErrorBox('SIGNET could not start', error.message);
  app.exit(1);
});
