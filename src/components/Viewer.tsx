import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, useActiveDoc } from '../core/store'
import { capturePointer } from '../core/pointer'
import { pageViewSize } from '../pdf/registry'
import { PageView } from './PageView'
import { SelectionPopover } from './SelectionPopover'

// remembers where you were in each document across tab switches
const scrollMemory = new Map<string, number>()

export function Viewer(): JSX.Element | null {
  const doc = useActiveDoc()
  const zoom = useStore((s) => s.zoom)
  const fitMode = useStore((s) => s.fitMode)
  const scrollRequest = useStore((s) => s.scrollRequest)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const prevZoomRef = useRef(zoom)
  const anchorRef = useRef<{ x: number; y: number } | null>(null)
  // where the pages sat at the last committed zoom, so the next zoom can re-seat the
  // anchored point against real geometry instead of assuming everything scales
  const layoutRef = useRef<{ zoom: number; offsets: number[] } | null>(null)
  const [visiblePages, setVisiblePages] = useState<Set<string>>(new Set())
  const [spaceDown, setSpaceDown] = useState(false)

  /* ---- per-document scroll restore ---- */
  useEffect(() => {
    const el = scrollerRef.current
    const id = doc?.id
    if (!el || !id) return
    const saved = scrollMemory.get(id)
    if (saved != null) {
      requestAnimationFrame(() => {
        el.scrollTop = saved
      })
    }
    return () => {
      scrollMemory.set(id, el.scrollTop)
    }
  }, [doc?.id])

  /* ---- fit modes ---- */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !doc || !fitMode) return
    const compute = () => {
      // read fresh state: fit-page must not re-trigger itself as scrolling changes the current page
      const st = useStore.getState()
      const d = st.active ? st.docs[st.active] : null
      if (!d || d.pages.length === 0) return
      let z: number
      if (fitMode === 'width') {
        const maxW = Math.max(...d.pages.map((p) => pageViewSize(p).w))
        z = (el.clientWidth - 88) / maxW
      } else {
        const ref = d.pages[d.currentPage] ?? d.pages[0]
        const pv = pageViewSize(ref)
        z = Math.min((el.clientHeight - 70) / pv.h, (el.clientWidth - 88) / pv.w)
      }
      z = Math.min(4, Math.max(0.1, z))
      if (Math.abs(z - st.zoom) > 0.001) useStore.setState({ zoom: z })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitMode, doc?.pages, doc?.id])

  /* ---- zoom anchoring ---- */
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const k = zoom / prevZoomRef.current
    const shells = Array.from(el.querySelectorAll<HTMLElement>('.page-shell'))
    if (k !== 1) {
      // Interactive zoom keeps the visible CENTRE stable. But an auto-fit on open
      // (no explicit anchor, still parked at the very top) must keep the top edge —
      // a centre anchor there scrolled a freshly-opened narrow PDF down past the
      // start of page 1.
      const a = anchorRef.current ?? { x: el.clientWidth / 2, y: el.scrollTop === 0 ? 0 : el.clientHeight / 2 }
      // Scaling the scroll offset assumes ALL of the scrolled content scales — but
      // the column's padding and each page's margin do not, so the anchored point
      // slid by (padding + margin x pageIndex) x (k-1): one wheel notch on page 21
      // moved it 202px in an 821px viewport, five notches 1899px. Anchor on the DOM
      // instead: find which page held the point in the PREVIOUS layout, keep the
      // unscaled offset inside that page, and re-seat it against the page's new
      // offsetTop. Reading offsetTop survives any future padding/margin change.
      const prev = layoutRef.current
      const pOld = el.scrollTop + a.y
      if (prev && shells.length && prev.offsets.length === shells.length) {
        let i = 0
        while (i + 1 < prev.offsets.length && prev.offsets[i + 1] <= pOld) i++
        const rel = (pOld - prev.offsets[i]) / prev.zoom      // unscaled depth into that page
        el.scrollTop = shells[i].offsetTop + rel * zoom - a.y // browser clamps for us
      } else {
        el.scrollTop = (el.scrollTop + a.y) * k - a.y         // first zoom, nothing measured yet
      }
      el.scrollLeft = (el.scrollLeft + a.x) * k - a.x
    }
    // remember this layout so the NEXT zoom knows where the pages were beforehand
    layoutRef.current = { zoom, offsets: shells.map((sh) => sh.offsetTop) }
    prevZoomRef.current = zoom
    anchorRef.current = null
  }, [zoom])

  /* ---- ctrl/cmd + wheel & trackpad pinch zoom ---- */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const s = useStore.getState()
      const next = Math.min(8, Math.max(0.1, s.zoom * Math.pow(2, -e.deltaY * 0.004)))
      // Already sitting on the clamp — a further wheel-in is a no-op, so setting the
      // cursor anchor here would leave it stale (the zoom effect only clears it when
      // zoom actually changes) and the NEXT keyboard/fit zoom would jump to it.
      if (next === s.zoom) return
      const r = el.getBoundingClientRect()
      anchorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
      s.setZoom(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [doc?.id])

  /* ---- space / middle-button panning ---- */
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      // Space is also how a keyboard user presses the control they have focused.
      // Claiming it for panning whenever a document was open meant no button,
      // checkbox, link or summary anywhere in the app could be activated from the
      // keyboard — the press was swallowed and preventDefault'd.
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable], button, a[href], summary, label, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]')) return
      setSpaceDown(true)
      e.preventDefault()
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    // If the window loses focus while Space is held — ⌘Tab, a dialog, clicking
    // another app — the keyup is delivered somewhere else and never arrives here,
    // so the pan hold latched ON for the rest of the session and every tool
    // silently behaved like the hand. Release it whenever we lose focus.
    const release = () => setSpaceDown(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', release)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', release)
    }
  }, [])

  const panState = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollerRef.current
    if (!el) return
    if (spaceDown || e.button === 1) {
      panState.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      capturePointer(e)
      e.preventDefault()
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panState.current
    const el = scrollerRef.current
    if (p && el) {
      el.scrollLeft = p.sl - (e.clientX - p.x)
      el.scrollTop = p.st - (e.clientY - p.y)
    }
  }
  const onPointerUp = () => {
    panState.current = null
  }

  /* ---- visibility & current page tracking ---- */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !doc) return
    let raf = 0
    const update = () => {
      raf = 0
      const shells = el.querySelectorAll<HTMLElement>('[data-page-id]')
      const viewTop = el.scrollTop
      const viewH = el.clientHeight
      const vis = new Set<string>()
      let current = -1
      let bestOverlap = 0
      shells.forEach((shell, i) => {
        const top = shell.offsetTop
        const h = shell.offsetHeight
        if (top < viewTop + viewH + 700 && top + h > viewTop - 700) vis.add(shell.dataset.pageId!)
        const overlap = Math.min(top + h, viewTop + viewH) - Math.max(top, viewTop)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          current = i
        }
      })
      setVisiblePages((prev) => {
        if (prev.size === vis.size && [...vis].every((v) => prev.has(v))) return prev
        return vis
      })
      if (current >= 0) useStore.getState().setCurrentPage(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [doc?.pages, doc?.id, zoom, doc])

  /* ---- programmatic scroll (page jump, search, comments) ---- */
  useEffect(() => {
    if (!scrollRequest || !doc) return
    const el = scrollerRef.current
    if (!el) return
    const shell = el.querySelector<HTMLElement>(`[data-page-id="${scrollRequest.page}"]`)
    if (!shell) return
    const z = useStore.getState().zoom
    let top = shell.offsetTop - 26
    let left: number | undefined
    if (scrollRequest.rect) {
      top = shell.offsetTop + scrollRequest.rect.y * z - el.clientHeight * 0.34
      left = shell.offsetLeft + scrollRequest.rect.x * z - el.clientWidth / 2
    }
    el.scrollTo({ top: Math.max(0, top), left, behavior: 'smooth' })
    // Depend ONLY on scrollRequest (a fresh object per request, via its nonce).
    // Having `doc` here re-ran the jump on every edit, yanking the viewport back
    // to the last search/goto target while the user was working elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest])

  if (!doc) return null

  return (
    <main className="viewer">
      <div
        ref={scrollerRef}
        className={`viewer-scroll ${spaceDown ? 'panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="pages-column">
          {doc.pages.map((page, i) => (
            <PageView key={page.id} page={page} index={i} visible={visiblePages.has(page.id)} />
          ))}
        </div>
      </div>
      <SelectionPopover />
    </main>
  )
}
