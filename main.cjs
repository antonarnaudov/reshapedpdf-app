const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const DEV_URL = process.env.ELECTRON_START_URL

/* The test suites drive the app through a set of hooks on `window`, which give
 * full read/write access to the document model. Useful for a harness, not
 * something a shipped build should carry: anything running in the renderer could
 * reach them. They are installed only when this flag is passed, so the released
 * app has no such surface and the suites pass it explicitly. */
const AUTOMATION = process.argv.includes('--enable-automation')
const DIST = path.join(__dirname, '..', 'dist')

app.setName('ReshapedPDF')

/* Packaged builds are served over a privileged scheme instead of file:// —
 * file:// blocks module workers (pdf.js) and fetch() of cmaps/fonts. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'reshapedpdf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/* ---------------- single instance + files opened from the OS ---------------- */

let mainWindow = null
let checkedThisLaunch = false
const pendingOpens = []

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  collectArgvPdfs(argv).forEach(queueOpen)
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueOpen(filePath)
})

function collectArgvPdfs(argv) {
  return argv.filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a))
}

function queueOpen(filePath) {
  try {
    const payload = { name: path.basename(filePath), bytes: fs.readFileSync(filePath) }
    if (mainWindow && !mainWindow.webContents.isLoading()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.webContents.send('reshapedpdf:open-file', payload)
    } else {
      pendingOpens.push(payload)
      // On macOS the app keeps running with every window closed. Opening a PDF from
      // Finder then queued the file and nothing else happened at all — no window, no
      // sign the app had noticed. Bring one back and the pending open drains into it
      // on did-finish-load.
      if (!mainWindow) createWindow()
    }
  } catch (err) {
    console.error('could not open', filePath, err)
  }
}

/* ---------------- window ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101114',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    while (pendingOpens.length) {
      mainWindow.webContents.send('reshapedpdf:open-file', pendingOpens.shift())
    }
    // One check per launch, a moment after the window is up so it never competes
    // with first paint. Silent unless there is something to say.
    if (!updatesDisabled() && !checkedThisLaunch) {
      checkedThisLaunch = true
      setTimeout(() => { autoUpdater.checkForUpdates().catch(() => { /* offline is not an error worth a dialog */ }) }, 4000)
    }
  })

  // The whole session lives in memory until the user exports, so closing the
  // window (or ⌘Q, or ⌘R) throws away every unsaved edit. The renderer cannot own
  // this: a beforeunload prompt is suppressed in Electron, so the guard has to be
  // here. `dirtyDocs` is pushed over IPC whenever the store's dirty count changes.
  mainWindow.on('close', (e) => {
    if (allowClose || dirtyDocs === 0) return
    e.preventDefault()
    if (confirmDiscard('close')) { allowClose = true; mainWindow.close() }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // `allowClose` gave THIS window permission to go; it must not outlive it.
    // On macOS the app survives its last window, so the next one (Dock icon, or a
    // file opened from Finder) would inherit the yes and close without asking —
    // a whole session's edits thrown away silently because the user discarded
    // something an hour earlier.
    allowClose = false
  })

  if (DEV_URL) mainWindow.loadURL(DEV_URL)
  else mainWindow.loadURL(`reshapedpdf://bundle/${AUTOMATION ? '?automation=1' : ''}`)
}

/* ---------------- unsaved-changes guard ---------------- */

// How many open documents have unsaved edits, pushed by the renderer on every
// change, and whether the user has already agreed to lose them.
let dirtyDocs = 0
let allowClose = false
ipcMain.on('reshapedpdf:dirty-count', (_event, n) => { dirtyDocs = Number(n) || 0 })

/**
 * Ask before throwing the session away. Under automation there is nobody to answer
 * a modal, so the guard holds (the safe answer) — which is exactly what the
 * regression test asserts: a close attempt on a dirty document does not go through.
 */
function confirmDiscard(action) {
  if (AUTOMATION || !mainWindow) return false
  const n = dirtyDocs
  return dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', `Discard and ${action}`],
    defaultId: 0,
    cancelId: 0,
    message: n === 1 ? 'One document has unsaved changes.' : `${n} documents have unsaved changes.`,
    detail: 'ReshapedPDF keeps your edits in memory until you export. They will be lost.',
  }) === 1
}

app.on('before-quit', (e) => {
  if (allowClose || dirtyDocs === 0) return
  e.preventDefault()
  if (confirmDiscard('quit')) { allowClose = true; app.quit() }
})

// Ask the window to close the way the red button / ⌘W do, so the suite can prove
// the guard actually vetoes. A renderer `window.close()` tears the page down
// without ever raising BrowserWindow's 'close', so it cannot test this at all.
if (AUTOMATION) ipcMain.on('reshapedpdf:test-close', () => mainWindow?.close())

/* ---------------- application menu ---------------- */

const send = (id) => () => mainWindow?.webContents.send('reshapedpdf:menu', id)

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Export PDF…', accelerator: 'CmdOrCtrl+S', click: send('export') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: send('fit-width') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+1', click: send('zoom-100') },
        { type: 'separator' },
        { label: 'Switch Light / Dark Bench', click: send('theme') },
        { type: 'separator' },
        // not { role: 'reload' }: a plain reload throws the in-memory session away
        // without asking, which is the same data loss as closing the window
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { if (dirtyDocs === 0 || confirmDiscard('reload')) mainWindow?.reload() },
        },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Shift+/', click: send('shortcuts') },
        { label: 'AI blending (preview)', click: send('ai') },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: async () => {
            // A MANUAL check answers even when there is nothing to say — silence
            // is the right response to the automatic one and the wrong response
            // to a person who just asked.
            if (updatesDisabled()) {
              dialog.showMessageBox(mainWindow, {
                type: 'info', buttons: ['OK'],
                message: 'Updates are off in this build',
                detail: app.isPackaged
                  ? 'This build is running under automation.'
                  : 'You are running from source — pull and rebuild instead.',
              })
              return
            }
            declined.clear()
            try {
              const r = await autoUpdater.checkForUpdates()
              const v = r && r.updateInfo && r.updateInfo.version
              if (!v || v === app.getVersion()) {
                dialog.showMessageBox(mainWindow, {
                  type: 'info', buttons: ['OK'],
                  message: `ReshapedPDF ${app.getVersion()} is up to date`,
                })
              }
              // when there IS one, update-available has already put the strip up
            } catch (err) {
              dialog.showMessageBox(mainWindow, {
                type: 'info', buttons: ['OK'],
                message: 'Could not check for updates',
                detail: String((err && err.message) || err),
              })
            }
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ---------------- ipc ---------------- */


/* ---------------- updates -------------------------------------------------

   The app checks for a newer release, tells the user, and does nothing else
   until they say so. Three rules, because an updater that breaks any of them is
   worse than none at all:

     ASK BEFORE DOWNLOADING   a few hundred megabytes over someone's tether,
                              unannounced, is not a favour.
     ASK BEFORE RESTARTING    this is a document editor. Relaunching under
                              someone mid-edit would lose work, so the install
                              waits for an explicit yes, and "later" means the
                              update applies on the next ordinary quit.
     NEVER NAG                one check per launch, and a decline is remembered
                              for that version so the same prompt cannot reappear
                              on every start.

   Nothing is checked in development (there is no release to compare against)
   and nothing is checked under --enable-automation, so the suites never wait on
   a network call. */
const { autoUpdater } = require('electron-updater')

autoUpdater.autoDownload = false          // the user decides
autoUpdater.autoInstallOnAppQuit = true   // "later" still lands, quietly
autoUpdater.logger = null

let updateState = { status: 'idle', version: null, notes: null, percent: 0 }
const declined = new Set()

function sendUpdate(win) {
  if (win && !win.isDestroyed()) win.webContents.send('reshapedpdf:update', updateState)
}

function wireUpdater(getWin) {
  autoUpdater.on('checking-for-update', () => { updateState = { ...updateState, status: 'checking' }; sendUpdate(getWin()) })
  autoUpdater.on('update-not-available', () => { updateState = { status: 'current', version: null, notes: null, percent: 0 }; sendUpdate(getWin()) })
  autoUpdater.on('update-available', (info) => {
    if (declined.has(info.version)) return
    updateState = { status: 'available', version: info.version, notes: String(info.releaseNotes ?? '').slice(0, 4000), percent: 0 }
    sendUpdate(getWin())
  })
  autoUpdater.on('download-progress', (p) => {
    updateState = { ...updateState, status: 'downloading', percent: Math.round(p.percent) }
    sendUpdate(getWin())
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { ...updateState, status: 'ready', version: info.version, percent: 100 }
    sendUpdate(getWin())
  })
  autoUpdater.on('error', (err) => {
    // Offline, rate-limited, no release yet: all ordinary. Report it to the
    // renderer so a MANUAL check can say what happened, but never as a dialog.
    updateState = { status: 'error', version: null, notes: String(err && err.message || err).slice(0, 300), percent: 0 }
    sendUpdate(getWin())
  })
}

const updatesDisabled = () => !app.isPackaged || process.argv.includes('--enable-automation')

ipcMain.handle('reshapedpdf:update-check', async (_e, { manual } = {}) => {
  if (updatesDisabled()) {
    return { status: 'disabled', version: null,
      notes: app.isPackaged ? 'automation build' : 'development build', percent: 0 }
  }
  try {
    // a manual check means the user wants to hear about a version they declined
    if (manual) declined.clear()
    await autoUpdater.checkForUpdates()
  } catch (err) {
    updateState = { status: 'error', version: null, notes: String(err && err.message || err).slice(0, 300), percent: 0 }
  }
  return updateState
})

ipcMain.handle('reshapedpdf:update-download', async () => {
  if (updatesDisabled()) return updateState
  try { await autoUpdater.downloadUpdate() } catch (err) {
    updateState = { status: 'error', version: updateState.version, notes: String(err && err.message || err).slice(0, 300), percent: 0 }
  }
  return updateState
})

ipcMain.handle('reshapedpdf:update-install', () => {
  if (updatesDisabled() || updateState.status !== 'ready') return false
  // isSilent false so the installer shows itself; isForceRunAfter true so the
  // app comes back up where the user left off
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
})

ipcMain.handle('reshapedpdf:update-dismiss', (_e, version) => {
  if (version) declined.add(String(version))
  updateState = { status: 'idle', version: null, notes: null, percent: 0 }
  return true
})

ipcMain.handle('reshapedpdf:save-file', async (event, { name, bytes }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: false }
  fs.writeFileSync(filePath, Buffer.from(bytes))
  return { ok: true, path: filePath }
})

ipcMain.handle('reshapedpdf:open-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF & images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }],
  })
  if (canceled) return []
  return filePaths.map((p) => ({ name: path.basename(p), bytes: fs.readFileSync(p) }))
})

// CORS-free fetch for the renderer, locked to the model catalog host
ipcMain.handle('reshapedpdf:fetch-text', async (_event, url) => {
  const u = new URL(String(url))
  if (u.protocol !== 'https:' || u.hostname !== 'ollama.com') {
    throw new Error('fetch-text is restricted to https://ollama.com')
  }
  const res = await net.fetch(u.toString())
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return await res.text()
})

/* AI traffic goes through the main process: browsers (and Electron renderers)
 * enforce CORS, which local servers (LM Studio ships with CORS off) and remote
 * APIs (api.openai.com sends no CORS headers) don't accommodate. net.fetch
 * here has no such restriction. Allowed: any localhost port, or https. */
const proxyAllowed = (u) =>
  ['localhost', '127.0.0.1'].includes(u.hostname) ? ['http:', 'https:'].includes(u.protocol) : u.protocol === 'https:'

ipcMain.handle('reshapedpdf:proxy-json', async (_event, { url, method = 'GET', headers = {}, body }) => {
  const u = new URL(String(url))
  if (!proxyAllowed(u)) throw new Error('proxy allows localhost or https only')
  const res = await net.fetch(u.toString(), {
    method,
    headers,
    body: body != null ? body : undefined,
  })
  return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() }
})

// Streaming variant for Ollama pulls: progress events flow back over IPC.
ipcMain.handle('reshapedpdf:ollama-pull', async (event, { root, model }) => {
  const u = new URL(String(root))
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('pull is localhost-only')
  const res = await net.fetch(`${u.origin}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`pull failed: ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j.error) throw new Error(j.error)
      event.sender.send('reshapedpdf:pull-progress', {
        model,
        pct: j.total && j.completed != null ? Math.round((j.completed / j.total) * 100) : -1,
        status: j.status ?? '',
      })
      if (j.status === 'success') return { ok: true }
    }
  }
  return { ok: true }
})

// The app manages Ollama directly: start the local server on demand.
ipcMain.handle('reshapedpdf:start-ollama', () => {
  const { spawn, execSync } = require('node:child_process')
  let bin = null
  try {
    bin = execSync(process.platform === 'win32' ? 'where ollama' : 'which ollama', { encoding: 'utf8' })
      .split(/\r?\n/)[0].trim() || null
  } catch { /* not on PATH */ }
  if (!bin) {
    for (const p of ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama']) {
      if (fs.existsSync(p)) { bin = p; break }
    }
  }
  if (!bin) return { ok: false, reason: 'not-installed' }
  try {
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
})

ipcMain.handle('reshapedpdf:sysinfo', () => ({
  ramGB: Math.round(os.totalmem() / (1024 ** 3)),
  arch: process.arch,
  cpus: os.cpus().length,
}))

const tempDirs = []
const cleanupTempDir = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  const i = tempDirs.indexOf(dir)
  if (i >= 0) tempDirs.splice(i, 1)
}
ipcMain.handle('reshapedpdf:open-temp', async (_event, { name, bytes }) => {
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document.pdf'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reshapedpdf-'))
  const file = path.join(dir, safe)
  fs.writeFileSync(file, Buffer.from(bytes))
  tempDirs.push(dir)
  await shell.openPath(file)
  // The external viewer holds the file open, so don't delete it immediately —
  // clean up after it has had time to load, and again on quit (below), so a print
  // session no longer leaves a full copy of every printed document in tmp forever.
  setTimeout(() => cleanupTempDir(dir), 10 * 60_000).unref?.()
})
app.on('will-quit', () => { for (const d of [...tempDirs]) cleanupTempDir(d) })

/* ---------------- lifecycle ---------------- */

wireUpdater(() => mainWindow)

app.whenReady().then(() => {
  // Local model servers (Ollama, LM Studio) reject unknown Origins. Requests from
  // the app to localhost get a friendly Origin so BYOM works out of the box.
  const { session } = require('electron')
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://localhost/*', 'http://127.0.0.1/*', 'http://localhost:*/*', 'http://127.0.0.1:*/*'] },
    (details, callback) => {
      details.requestHeaders.Origin = 'http://localhost'
      callback({ requestHeaders: details.requestHeaders })
    },
  )

  protocol.handle('reshapedpdf', (request) => {
    const url = new URL(request.url)
    let p = decodeURIComponent(url.pathname)
    if (p === '/' || p === '') p = '/index.html'
    const file = path.normalize(path.join(DIST, p))
    if (!file.startsWith(path.normalize(DIST))) {
      return new Response('denied', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })

  buildMenu()
  createWindow()
  collectArgvPdfs(process.argv.slice(1)).forEach(queueOpen)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
