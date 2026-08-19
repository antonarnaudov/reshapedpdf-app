// Minimal Chrome DevTools Protocol client for driving the running app.
//
// Node 22 ships a global WebSocket, so this needs no dependency — which matters
// for a test harness: one that drags in a package tree is one that rots.
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function connect({ port = 9333, timeoutMs = Number(process.env.CDP_TIMEOUT_MS || (process.env.CI ? 90000 : 30000)) } = {}) {
  const deadline = Date.now() + timeoutMs
  let target = null
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target =
        list.find((t) => t.type === 'page' && t.url.startsWith('reshapedpdf://')) ||
        list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  if (!target) throw new Error(`no CDP page target on port ${port}`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))

  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  let seq = 0
  const api = {
    /**
     * Evaluate something that takes a while, without holding the connection
     * open across it.
     *
     * Awaiting a slow promise over CDP lets V8 collect it mid-flight — the
     * connection comes back "Promise was collected", which reads as a failing
     * test and is nothing of the kind. So park the result on a global, return
     * immediately, and poll for it.
     */
    async run(expression, { timeout = 180000, poll = 400 } = {}) {
      const tag = `__run${++seq}`
      await api.eval(
        `window.${tag} = { done: false, val: null, err: null };` +
        `void Promise.resolve().then(() => (${expression}))` +
        `.then(v => { window.${tag}.val = v; window.${tag}.done = true },` +
        `      e => { window.${tag}.err = String((e && e.stack) || e); window.${tag}.done = true });` +
        `'started'`,
      )
      const deadline = Date.now() + timeout
      for (;;) {
        const st = await api.eval(`({ done: window.${tag}.done, err: window.${tag}.err })`)
        if (st.done) {
          const val = st.err ? null : await api.eval(`window.${tag}.val`)
          await api.eval(`delete window.${tag}; 0`)
          if (st.err) throw new Error(st.err)
          return val
        }
        if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms`)
        await sleep(poll)
      }
    },

    /** Evaluate an expression in the renderer and return its value. */
    async eval(expression, { timeout = 180000 } = {}) {
      const r = await Promise.race([
        send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
          userGesture: true,
        }),
        sleep(timeout).then(() => {
          throw new Error('eval timed out')
        }),
      ])
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      }
      return r.result.value
    },
    close: () => ws.close(),
  }
  return api
}

/** Launch the app with the debugger open, on a throwaway profile. */
export function launchApp({ cwd, port = 9333, userDataDir }) {
  const child = spawn(
    'npx',
    [
      'electron', '.',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // installs the hooks the suites drive the app through; a released build
      // has no such surface (see electron/main.cjs)
      '--enable-automation',
      // Chromium's sandbox needs user namespaces, which CI containers do not
      // grant — without this the process dies before it opens a debugging port
      // and every suite fails as "no CDP page target", which looks like a
      // broken test and is a broken environment.
      ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    ],
    // Detached so the whole process group can be killed. `npx electron` is a
    // wrapper: killing it leaves the real Electron running, holding its profile
    // and its share of the machine. Three suites in a row on a small CI runner
    // and the third one cannot get a window up at all — which reports as "no
    // CDP page target" and looks like the app is broken.
    { cwd, stdio: 'ignore', detached: true },
  )
  child.unref()
  const original = child.kill.bind(child)
  child.kill = (signal = 'SIGKILL') => {
    try { process.kill(-child.pid, signal) } catch { original(signal) }
  }
  return child
}

export { sleep }
