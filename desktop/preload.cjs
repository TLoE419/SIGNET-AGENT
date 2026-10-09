const {contextBridge, ipcRenderer} = require('electron');
// No generic invoke, filesystem, shell, token, or user-specified URL exposure.
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  closeVisualization: () => ipcRenderer.invoke('desktop:closeVisualization'),
  visualization: id => ipcRenderer.invoke('desktop:visualization', id),
  status: () => ipcRenderer.invoke('desktop:status'),
  reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
  schema: () => ipcRenderer.invoke('desktop:schema'),
  pick: (key, cohort) => ipcRenderer.invoke('desktop:pick', key, cohort),
  list: () => ipcRenderer.invoke('desktop:list'),
  detail: id => ipcRenderer.invoke('desktop:detail', id),
  logs: id => ipcRenderer.invoke('desktop:logs', id),
  create: params => ipcRenderer.invoke('desktop:create', params),
  start: (id, stage) => ipcRenderer.invoke('desktop:start', id, stage),
  cancel: id => ipcRenderer.invoke('desktop:cancel', id),
  save: (id, name) => ipcRenderer.invoke('desktop:save', id, name),
  reveal: id => ipcRenderer.invoke('desktop:reveal', id),
}));
