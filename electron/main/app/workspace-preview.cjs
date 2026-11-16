'use strict';
const {BrowserWindow, session} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const directory = path.join(__dirname, '../../build/workspace-preview');
const entry = path.join(directory, 'index.html');
const entryURL = pathToFileURL(entry).href;
const allowed = new Set(['index.html', 'workspace.css', 'workspace.js', 'icons.js', 'interaction.js']
  .map(file => pathToFileURL(path.join(directory, file)).href));

let previewSession;
let previewWindow;

function getPreviewSession() {
  if (previewSession) return previewSession;
  // Preview fixtures never use the live renderer's credentials, HTTP origin, or IPC bridge.
  previewSession = session.fromPartition('signet-workspace-preview');
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({cancel: !allowed.has(details.url)});
  });
  previewSession.on('will-download', event => event.preventDefault());
  return previewSession;
}

async function openWorkspacePreview({visible = true} = {}) {
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (visible) {
      if (previewWindow.isMinimized()) previewWindow.restore();
      previewWindow.show();
      previewWindow.focus();
    }
    return previewWindow;
  }

  const window = new BrowserWindow({
    width: 1650, height: 894, minWidth: 760, minHeight: 460, useContentSize: true,
    show: false, title: 'SIGNET Workspace Preview · Simulated data',
    webPreferences: {
      session: getPreviewSession(), nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, webviewTag: false,
    },
  });
  previewWindow = window;
  window.on('closed', () => { previewWindow = undefined; });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== entryURL) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || event.url !== entryURL) event.preventDefault();
  });

  try {
    await window.loadFile(entry);
    if (visible && !window.isDestroyed()) window.show();
    return window;
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

module.exports = {openWorkspacePreview};
