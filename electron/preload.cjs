const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('reshapedpdfNative', {
  platform: process.platform,
  // how many open documents have unsaved edits — the main process needs this to
  // guard window close / quit / reload, which the renderer cannot veto itself
  setDirtyCount: (n) => ipcRenderer.send('reshapedpdf:dirty-count', n),
  // real BrowserWindow close, for the close-guard suite; main only listens under
  // --enable-automation, so in a shipped build this is a no-op message
  testClose: () => ipcRenderer.send('reshapedpdf:test-close'),
  saveFile: (name, bytes) => ipcRenderer.invoke('reshapedpdf:save-file', { name, bytes }),
  openFiles: () => ipcRenderer.invoke('reshapedpdf:open-files'),
  openTemp: (name, bytes) => ipcRenderer.invoke('reshapedpdf:open-temp', { name, bytes }),
  sysInfo: () => ipcRenderer.invoke('reshapedpdf:sysinfo'),
  fetchText: (url) => ipcRenderer.invoke('reshapedpdf:fetch-text', url),
  startOllama: () => ipcRenderer.invoke('reshapedpdf:start-ollama'),
  proxyJson: (req) => ipcRenderer.invoke('reshapedpdf:proxy-json', req),
  ollamaPull: (root, model) => ipcRenderer.invoke('reshapedpdf:ollama-pull', { root, model }),
  onPullProgress: (cb) => ipcRenderer.on('reshapedpdf:pull-progress', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('reshapedpdf:menu', (_e, id) => cb(id)),
  // updates: the renderer asks and listens, the main process decides and acts
  updateCheck: (manual) => ipcRenderer.invoke('reshapedpdf:update-check', { manual: Boolean(manual) }),
  updateDownload: () => ipcRenderer.invoke('reshapedpdf:update-download'),
  updateInstall: () => ipcRenderer.invoke('reshapedpdf:update-install'),
  updateDismiss: (version) => ipcRenderer.invoke('reshapedpdf:update-dismiss', version),
  onUpdate: (cb) => ipcRenderer.on('reshapedpdf:update', (_e, s) => cb(s)),
  onOpenFile: (cb) => ipcRenderer.on('reshapedpdf:open-file', (_e, f) => cb(f)),
})
