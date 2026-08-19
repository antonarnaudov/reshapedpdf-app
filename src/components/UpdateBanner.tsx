import { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import { useStore } from '../core/store'

/**
 * The update prompt.
 *
 * Deliberately a strip at the foot of the window rather than a modal: an update
 * is never more important than the document someone is in the middle of. It
 * cannot take focus, cannot swallow a keystroke, and closing it is one click.
 *
 * It asks twice, because the two questions are different and both have a wrong
 * moment. Downloading is a few hundred megabytes and might be someone's phone
 * tether. Installing relaunches the app, and this is a document editor — a
 * restart at the wrong instant loses work that only exists in memory. Declining
 * the second question is not a refusal: electron-updater is set to install on
 * the next ordinary quit, so "later" genuinely means later.
 */
export function UpdateBanner(): JSX.Element | null {
  const [st, setSt] = useState<UpdateState | null>(null)
  const dirty = useStore((s) => Object.values(s.docs).filter((d) => d.dirty).length)

  useEffect(() => {
    const n = window.reshapedpdfNative
    if (!n?.onUpdate) return
    n.onUpdate(setSt)
  }, [])

  if (!st) return null
  const n = window.reshapedpdfNative
  const show = st.status === 'available' || st.status === 'downloading' || st.status === 'ready'
  if (!show) return null

  const dismiss = (): void => { void n?.updateDismiss?.(st.version ?? null); setSt(null) }

  return (
    <div className="update-bar" role="status">
      {st.status === 'available' && (
        <>
          <Download size={14} />
          <span><b>ReshapedPDF {st.version}</b> is available.</span>
          <button className="btn primary sm" onClick={() => void n?.updateDownload?.()}>Download</button>
          <button className="btn sm" onClick={dismiss}>Not now</button>
        </>
      )}
      {st.status === 'downloading' && (
        <>
          <Download size={14} />
          <span>Downloading {st.version}… {st.percent}%</span>
          <div className="update-progress"><div style={{ width: `${st.percent}%` }} /></div>
        </>
      )}
      {st.status === 'ready' && (
        <>
          <RefreshCw size={14} />
          <span>
            <b>{st.version}</b> is ready.{' '}
            {dirty > 0
              // Naming the cost, rather than a generic "unsaved changes" warning:
              // the session lives in memory and a relaunch is where it ends.
              ? `Restarting now would lose edits in ${dirty} unsaved document${dirty === 1 ? '' : 's'}.`
              : 'It installs when you restart.'}
          </span>
          <button className="btn primary sm" onClick={() => void n?.updateInstall?.()}>
            {dirty > 0 ? 'Restart anyway' : 'Restart now'}
          </button>
          <button className="btn sm" onClick={dismiss}>On next quit</button>
        </>
      )}
      <button className="icon-btn sm" title="Hide" onClick={dismiss}><X size={13} /></button>
    </div>
  )
}
