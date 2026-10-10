'use strict';
/* AEGIS Sentinel — least-privilege preload bridge */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('aegis', Object.freeze({
  getSystemInfo: invoke('sys:info'),
  getDiskUsage: invoke('disk:usage'),
  quickScan: invoke('scan:quick'),
  scanFiles: invoke('scan:files'),
  cleanFiles: invoke('files:clean'),
  listProcesses: invoke('proc:list'),
  killProcess: invoke('proc:kill'),
  listApps: invoke('apps:list'),
  uninstallApp: invoke('apps:uninstall'),
  getNetwork: invoke('net:list'),
  getFirewall: invoke('fw:status'),
  enableFirewall: invoke('fw:enable'),
  getEncryption: invoke('enc:status'),
  checkUpdates: invoke('updates:check'),
  installUpdates: invoke('updates:install'),
  getSystemErrors: invoke('errors:list'),
  pickDirectory: invoke('dialog:pickDir'),
  saveReport: invoke('report:save'),
  minimize: invoke('win:minimize'),
  toggleMaximize: invoke('win:toggleMax'),
  close: invoke('win:close'),
}));
