/**
 * Invisible — Preload (Context Bridge)
 * @author Zen (zhwzein)
 * @github https://github.com/zhwzein/invisible
 * @license MIT
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  saveConfig: (config) => ipcRenderer.send('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  quitApp: () => ipcRenderer.send('quit-app'),
  setOpacity: (value) => ipcRenderer.send('set-opacity', value),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('set-always-on-top', enabled),
  setKeepFocus: (enabled) => ipcRenderer.send('set-keep-focus', enabled),
  onStartTyping: (callback) => ipcRenderer.on('start-typing', () => callback()),
  aiFetch: (options) => ipcRenderer.invoke('ai-fetch', options),
  onScreenshotCaptured: (callback) => ipcRenderer.on('screenshot-captured', (_, data) => callback(data)),
  onCaptureStart: (callback) => ipcRenderer.on('capture-start', () => callback()),
  onCaptureError: (callback) => ipcRenderer.on('capture-error', (_, msg) => callback(msg)),
  onTransparencyChanged: (callback) => ipcRenderer.on('transparency-changed', (_, level) => callback(level)),
  pickKnowledgeFolder: () => ipcRenderer.invoke('pick-knowledge-folder'),
  knowledgeStatus: (folder) => ipcRenderer.invoke('knowledge-status', folder),
  knowledgeReindex: (folder) => ipcRenderer.invoke('knowledge-reindex', folder),
  knowledgeRetrieve: (query) => ipcRenderer.invoke('knowledge-retrieve', query),
  knowledgeImages: (query) => ipcRenderer.invoke('knowledge-images', query),
});
