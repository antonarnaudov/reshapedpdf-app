/** Web ↔ Electron bridge for opening and saving files. */

export const isElectron = (): boolean => typeof window !== 'undefined' && Boolean(window.reshapedpdfNative)

export async function pickFiles(): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (window.reshapedpdfNative) {
    const files = await window.reshapedpdfNative.openFiles()
    return files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }))
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (v: { name: string; bytes: Uint8Array }[]) => { if (!done) { done = true; resolve(v) } }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,image/png,image/jpeg'
    input.multiple = true
    input.onchange = async () => {
      try {
        const out: { name: string; bytes: Uint8Array }[] = []
        for (const f of Array.from(input.files ?? [])) {
          out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
        }
        finish(out)
      } catch {
        // a picked file that won't read (removed volume, deleted mid-read) must
        // still settle the promise — the focus fallback is skipped once a file was
        // selected, so without this the whole picker would hang forever
        finish([])
      }
    }
    // On focus return, resolve empty ONLY if the dialog was dismissed with nothing
    // selected. If files WERE picked, `onchange` owns the resolution — reading a
    // large/multi-file selection can take longer than this timer, and racing it to
    // [] here silently dropped the user's selection.
    window.addEventListener('focus', () => setTimeout(() => {
      if (!input.files || input.files.length === 0) finish([])
    }, 400), { once: true })
    input.click()
  })
}

/**
 * Open a PDF in the system viewer (Electron: temp file; web: blob tab) — printing.
 *
 * In a browser this is a popup, and popups are blocked by default unless the
 * click that caused them is still on the stack — which it is not, because the
 * file has to be exported first. window.open then returns null and Print looked
 * like it simply did nothing. Say so, and hand back a way through.
 */
export async function openTempPdf(name: string, bytes: Uint8Array): Promise<void> {
  if (window.reshapedpdfNative?.openTemp) {
    await window.reshapedpdfNative.openTemp(name, bytes)
    return
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    URL.revokeObjectURL(url)
    throw new Error('Your browser blocked the print window. Allow pop-ups for this site, or export the PDF and print it from your viewer.')
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Write the bytes out, and report HONESTLY whether they landed.
 *
 * The desktop path knows: the save dialog says yes or no. The web path used to
 * click a hidden <a download> and return true regardless — so cancelling the
 * download, or having it fail, still produced "Exported", cleared the unsaved
 * mark, and closed the sheet. The app then believed the work was safe when
 * nothing had been written, and the close guard stopped warning about it.
 *
 * Where the browser offers a real save dialog (showSaveFilePicker, Chromium
 * today) use it: the user picks the place, and a cancel is a cancel. Elsewhere
 * fall back to the anchor — but the caller words that case as a download that has
 * STARTED, because that is all anyone can honestly know from here.
 */
export interface SaveResult { ok: boolean; confirmed: boolean }

export async function saveBytes(name: string, bytes: Uint8Array): Promise<SaveResult> {
  if (window.reshapedpdfNative) {
    const res = await window.reshapedpdfNative.saveFile(name, bytes)
    return { ok: res.ok, confirmed: true }
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
  const picker = (window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>
  }).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      return { ok: true, confirmed: true }
    } catch (err) {
      // AbortError is the user cancelling; anything else means it genuinely failed
      if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, confirmed: true }
      throw err
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return { ok: true, confirmed: false }
}
