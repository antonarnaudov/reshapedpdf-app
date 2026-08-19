import type { AiConfig } from './catalog'
import { FONT_IDS } from '../core/types'
import type { FontId } from '../core/types'

/** What the vision model reads off a region of print. */
export interface ReshapeReading {
  text: string
  font: FontId
  bold: boolean
  color: string
}

const READ_PROMPT = `You are a print-matching assistant inside a PDF editor. The image is a cropped region of a PDF page, and a layout tool re-prints each line you return on its own row — so the ORDER and the LINE COUNT must be exact.

1. Transcribe the text:
   - Output lines strictly TOP-to-BOTTOM, in the order they appear. Never reorder.
   - One output line per visible ROW of text. If a row has several columns or wide gaps (a table row, a label and its value), keep them on ONE line separated by single spaces — do NOT split a row into multiple lines.
   - SKIP a line ONLY if the top or bottom edge cuts through it so badly that less than half its height is visible (a mere sliver of a neighbouring line). Transcribe any line that is essentially whole, even if it lightly touches an edge.
   - Copy characters exactly, including punctuation and symbols (— € × etc.) and digits.
2. Classify the dominant typeface as exactly ONE of these ids (pick the closest):
   "sans" — neutral grotesque like Helvetica/Arial
   "serif" — bracketed serifs like Times/Garamond
   "mono" — fixed-width typewriter like Courier/Consolas
   "geo" — geometric circles-and-lines like Futura/Poppins/Century Gothic
   "humanist" — open, calligraphic-skeleton sans like Lato/Segoe/Frutiger
   "condensed" — tall narrow sans like Oswald/Impact/DIN Condensed
   "rounded" — visibly rounded stroke ends like Nunito/VAG Rounded
   "slab" — heavy rectangular serifs like Rockwell/Roboto Slab
   "grotesk" — tight early-grotesque like Franklin Gothic/Archivo
3. Decide whether the text weight is bold.
4. Give the dominant text color as a 6-digit lowercase hex string.

Respond with ONLY compact JSON, no markdown fences, in exactly this shape:
{"text":"...","font":"sans","bold":false,"color":"#111111"}`

const isLocalUrl = (url: string): boolean => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Users paste server roots without /v1 (LM Studio shows `http://127.0.0.1:1234`).
 * For local servers, append /v1 when no versioned path is present. Remote URLs
 * are left alone (Gemini's compat root is /v1beta/openai, etc).
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (isLocalUrl(trimmed) && !/\/v\d/i.test(new URL(trimmed).pathname)) return `${trimmed}/v1`
  return trimmed
}

/**
 * All AI HTTP goes through the Electron main process when available: renderers
 * enforce CORS, which LM Studio (ships with CORS off) and api.openai.com (sends
 * no CORS headers) don't accommodate. Browsers fall back to plain fetch.
 */
// Well-known local AI ports the vite dev server proxies same-origin (see
// vite.config.ts). LM Studio and Ollama both ship with CORS OFF, so a browser
// dev build (origin :5173) can't fetch them directly — it must go through the
// proxy path.
const DEV_PROXY_PREFIX: Record<string, string> = { '1234': '/lms', '11434': '/oll' }

/**
 * In the vite dev/browser build there is no native proxy and the browser is
 * CORS-walled from a localhost model server. Rewrite a localhost:1234/:11434 URL
 * to its same-origin proxy path so the connection test AND every real AI call
 * work without asking the user to enable CORS. A packaged build (Electron's
 * native proxyJson, or a production static build where import.meta.env.DEV is
 * false) is left untouched.
 */
function devProxyUrl(url: string): string {
  if (window.reshapedpdfNative || !import.meta.env.DEV) return url
  try {
    const u = new URL(url, window.location.href)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    const prefix = local ? DEV_PROXY_PREFIX[u.port] : undefined
    if (prefix) return `${prefix}${u.pathname}${u.search}`
  } catch { /* not an absolute URL — leave it */ }
  return url
}

async function aiHttp(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const native = window.reshapedpdfNative
  if (native?.proxyJson) {
    // The Electron proxy can't be aborted (no signal reaches main), so a stalled
    // model server would hang the app forever with the busy veil up and no cancel.
    // Race it against the caller's timeout so the UI always recovers; the orphaned
    // IPC request resolves later into the void.
    const ms = init.timeoutMs ?? 30_000
    let timer: number | undefined
    try {
      return await Promise.race([
        native.proxyJson({ url, method: init.method, headers: init.headers, body: init.body }),
        new Promise<never>((_, rej) => {
          timer = window.setTimeout(() => rej(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  try {
    const res = await fetch(devProxyUrl(url), {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    })
    return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`timed out after ${Math.round((init.timeoutMs ?? 30_000) / 1000)}s`)
    }
    // A production browser build (no Electron proxy, no dev proxy) reaching a
    // localhost model server is CORS-walled, and fetch surfaces that as an opaque
    // "Failed to fetch" (a TypeError). Say what actually went wrong and how to fix
    // it, rather than a bare network error.
    if (err instanceof TypeError && !native?.proxyJson && /\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      throw new Error(
        'The browser blocked the local model (CORS). Enable CORS on the model server ' +
        '(LM Studio: Developer → “Enable CORS”; Ollama: run with OLLAMA_ORIGINS=*), or use the desktop app.',
      )
    }
    throw err
  } finally {
    window.clearTimeout(timer)
  }
}

async function chat(
  cfg: AiConfig,
  content: unknown,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const res = await aiHttp(`${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}${res.text ? ` — ${res.text.slice(0, 180)}` : ''}`)
  }
  let json: { choices?: { message?: { content?: string } }[] }
  try {
    json = JSON.parse(res.text) as { choices?: { message?: { content?: string } }[] }
  } catch {
    // a 200 with a non-JSON body (a proxy login page, a truncated stream) — give
    // the same clean message the reading/block parsers do, not a raw SyntaxError
    throw new Error(`model returned invalid JSON${res.text ? ` — ${res.text.slice(0, 120)}` : ''}`)
  }
  const text = json.choices?.[0]?.message?.content
  if (!text) throw new Error('empty model response')
  return text
}

/** Read a cropped print region: exact text + type style. */
export async function readRegion(cfg: AiConfig, imageDataUrl: string): Promise<ReshapeReading> {
  const raw = await chat(
    cfg,
    [
      { type: 'text', text: READ_PROMPT },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
    600,
    90_000, // local models on modest hardware take their time
  )
  return parseReading(raw)
}

/**
 * Turn an OCR model's reply into a clean ReshapeReading. Pure and exported so it
 * can be tested without a model — every field falls back safely (font to 'sans'
 * unless it names one of ours, colour to a near-black unless it is a #rrggbb,
 * text to empty), because peel and retype trust these values directly.
 */
export function parseReading(raw: string): ReshapeReading {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`model returned no JSON: ${cleaned.slice(0, 120)}`)
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<ReshapeReading>

  const font: FontId = FONT_IDS.includes(parsed.font as FontId) ? (parsed.font as FontId) : 'sans'
  const color =
    typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.color.trim())
      ? parsed.color.trim().toLowerCase()
      : '#111111'
  return {
    // A loose model can emit a numeric-only line as a bare JSON number
    // ({"text":426,...}); keep the read value as a string instead of discarding it
    // (which would erase the line on retype / leave the original on peel).
    text: typeof parsed.text === 'string' ? parsed.text : typeof parsed.text === 'number' ? String(parsed.text) : '',
    font,
    bold: Boolean(parsed.bold),
    color,
  }
}

/**
 * Find the text blocks on a page image (for raster layer peeling). Returns each
 * block's box as fractions of the image (0..1), so the caller can map them to
 * whatever resolution it rendered at. A "block" is a line or short paragraph
 * that reads as one unit — a heading, a table row, a label.
 */
export async function detectTextBlocks(
  cfg: AiConfig, imageDataUrl: string, imgW: number, imgH: number,
): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const prompt =
    'You are given an image of a document page that is ' + Math.round(imgW) + ' pixels wide ' +
    'and ' + Math.round(imgH) + ' pixels tall. Find every distinct block of text (a heading, ' +
    'a line, a short paragraph, a label, a table cell with words). Return ONLY a JSON array, ' +
    'no prose, where each item is {"box":[x0,y0,x1,y1]} giving the block\'s bounding box in ' +
    'PIXELS with the top-left corner at (x0,y0) and the bottom-right at (x1,y1). Merge words ' +
    'on the same line into one block. Ignore rules, lines, logos and photos — text only.'
  const raw = await chat(
    cfg,
    [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUrl } }],
    2000, 120_000,
  )
  return parseTextBlocks(raw, imgW, imgH)
}

/**
 * Where is the object the user circled?
 *
 * The clean tool asks this and nothing else. It does NOT ask a model to paint
 * anything: on a page whose artwork is still vector, inventing pixels is the
 * worst way to remove something — the drawing instructions are right there, and
 * taking them out reveals the real background exactly. So the model does the one
 * part a program cannot, which is knowing what counts as "the object", and the
 * removal stays deterministic.
 *
 * The reply is the same shape as block detection, so it goes through the same
 * tolerant parser: fractions of the crop, biggest first.
 */
export async function detectObject(
  cfg: AiConfig, imageDataUrl: string, imgW: number, imgH: number,
): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const prompt =
    'You are given a crop from a document page, ' + Math.round(imgW) + ' pixels wide and ' +
    Math.round(imgH) + ' pixels tall. Someone has drawn a box around something they want ' +
    'REMOVED from the page, and this crop is that box plus a little of its surroundings. ' +
    'Identify the ONE object they meant — the distinct thing nearest the centre: a logo, a ' +
    'stamp, an icon, a photo, a signature, a line of text. Return ONLY a JSON array with a ' +
    'single item {"box":[x0,y0,x1,y1]}, its TIGHT bounding box in PIXELS, top-left (x0,y0) to ' +
    'bottom-right (x1,y1). Include every part of that object and nothing else: not the page ' +
    'background, not a rule, bar or table line it sits on, not neighbouring words. If the crop ' +
    'holds no distinct object, return [].'
  const raw = await chat(
    cfg,
    [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUrl } }],
    600, 90_000,
  )
  return parseTextBlocks(raw, imgW, imgH)
}

/**
 * Turn a detection model's reply into fractional boxes. Pure and exported so it
 * can be tested without a model — vision models are loose about the shape
 * ({box:[x0,y0,x1,y1]}, {bbox:[…]}, {x:[…]}, {x,y,w,h}; pixels or fractions;
 * prose or fences around the JSON), so this is where all that gets tamed.
 */
export function parseTextBlocks(
  raw: string, imgW: number, imgH: number,
): { x: number; y: number; w: number; h: number }[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error(`model returned no JSON array: ${cleaned.slice(0, 120)}`)
  let arr: unknown[]
  try { arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown[] } catch { throw new Error('model returned malformed JSON') }

  // Pull four numbers out of whatever shape came back.
  const four = (it: unknown): number[] | null => {
    const o = it as Record<string, unknown>
    for (const v of [o?.box, o?.bbox, o?.x, o?.rect, it]) {
      if (Array.isArray(v) && v.length >= 4 && v.slice(0, 4).every((n) => typeof n === 'number')) return v.slice(0, 4) as number[]
    }
    const n = (v: unknown) => (typeof v === 'number' ? v : NaN)
    const x = n(o?.x), y = n(o?.y), w = n(o?.w), h = n(o?.h)
    if ([x, y, w, h].every((v) => !Number.isNaN(v))) return [x, y, x + w, y + h]
    return null
  }
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  for (const it of Array.isArray(arr) ? arr : []) {
    const b = four(it)
    if (!b) continue
    let [x0, y0, x1, y1] = b
    // pixels if any value clearly exceeds 1; else already fractions
    if (Math.max(x0, y0, x1, y1) > 1.5) { x0 /= imgW; x1 /= imgW; y0 /= imgH; y1 /= imgH }
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0)
    if (w > 0.005 && h > 0.004 && x >= -0.02 && y >= -0.02 && x + w <= 1.05 && y + h <= 1.05) {
      boxes.push({ x: Math.max(0, x), y: Math.max(0, y), w, h })
    }
  }

  // Detectors routinely return the same line twice — a paragraph box plus its
  // constituent lines, or two near-identical detections of one heading. Peeling
  // both stacks two text objects on one baseline over a doubly-applied patch, so
  // drop a box that is mostly inside, or largely the same as, a larger kept one.
  // Decide keep/drop largest-first (so the survivor is the bigger box), but emit
  // in the original order.
  const area = (b: { w: number; h: number }) => Math.max(0, b.w) * Math.max(0, b.h)
  const byArea = boxes.map((_, i) => i).sort((i, j) => area(boxes[j]) - area(boxes[i]))
  const dropped = new Set<number>()
  const keep: number[] = []
  for (const i of byArea) {
    const b = boxes[i], ba = area(b)
    const dup = keep.some((ki) => {
      const k = boxes[ki]
      const inter = Math.max(0, Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x))
        * Math.max(0, Math.min(b.y + b.h, k.y + k.h) - Math.max(b.y, k.y))
      if (inter <= 0) return false
      return inter / ba >= 0.6 || inter / (ba + area(k) - inter) >= 0.5 // mostly-contained OR high IoU
    })
    if (dup) dropped.add(i); else keep.push(i)
  }
  return boxes.filter((_, i) => !dropped.has(i))
}

/* ---------------- live local-model management ---------------- */

export interface LocalModel {
  id: string
  /** true/false when the server declares it; null = judge by name. */
  vision: boolean | null
}

/**
 * List models the local server actually has. LM Studio's /api/v0/models is
 * preferred (all DOWNLOADED models with a type field, not just loaded ones);
 * the OpenAI-compat /models endpoint is the universal fallback.
 */
export async function listLocalModels(baseUrl: string, apiKey?: string): Promise<LocalModel[]> {
  const normalized = normalizeBaseUrl(baseUrl)
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined

  if (isLocalUrl(normalized)) {
    const root = new URL(normalized).origin
    try {
      const res = await aiHttp(`${root}/api/v0/models`, { headers, timeoutMs: 5000 })
      if (res.ok) {
        const json = JSON.parse(res.text) as { data?: { id: string; type?: string }[] }
        const list = (json.data ?? [])
          .filter((m) => m.type !== 'embeddings')
          .map((m) => ({ id: m.id, vision: m.type ? m.type === 'vlm' : null }))
        if (list.length) return list
      }
    } catch { /* not LM Studio — fall through */ }
  }

  const res = await aiHttp(`${normalized}/models`, { headers, timeoutMs: 5000 })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const json = JSON.parse(res.text) as { data?: { id: string }[] }
  return (json.data ?? []).map((m) => ({ id: m.id, vision: null }))
}

/** Heuristic: does this model name look vision-capable? */
export const isVisionModelName = (name: string): boolean =>
  /(vl|vision|llava|moondream|minicpm|pixtral|internvl|ocr|gemma[0-9])/i.test(name)

/** Fetch text CORS-free via Electron main; browsers try directly and usually fail closed. */
async function fetchCatalogText(url: string): Promise<string | null> {
  const native = window.reshapedpdfNative
  if (native?.fetchText) {
    try {
      return await native.fetchText(url)
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

export interface CatalogModel {
  name: string
  /** Purpose-built for documents/OCR vs. a general multimodal model. */
  docFocused: boolean
}

/** Names that exist to read documents — the right tool for print, not a 200B generalist. */
export const isDocFocusedName = (name: string): boolean =>
  /(ocr|(^|[^a-z])vl($|[^a-z])|-vl\b|vl$|minicpm|llava|moondream|pixtral|internvl|smolvlm|granite.*vision|florence)/i.test(name)

/**
 * LIVE list of the current vision models on ollama.com — never hardcoded.
 * Each search-result card is parsed individually and must carry the actual
 * `vision` capability badge. Cached for 24h. Returns null when unreachable
 * (offline / browser CORS) — callers show instructions then.
 */
export async function fetchOllamaVisionCatalog(): Promise<CatalogModel[] | null> {
  const CACHE_KEY = 'reshapedpdf.ollamaCatalog.v2'
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as { t: number; models: CatalogModel[] } | null
    if (c && Date.now() - c.t < 86_400_000 && c.models.length) return c.models
  } catch { /* re-fetch */ }
  const html = await fetchCatalogText('https://ollama.com/search?c=vision')
  if (!html) return null

  const models: CatalogModel[] = []
  for (const card of html.match(/<li[\s\S]*?<\/li>/g) ?? []) {
    const name = card.match(/href="\/library\/([a-z0-9._-]+)"/)?.[1]
    if (!name || models.some((m) => m.name === name)) continue
    // trust the badge, not the URL: the card must literally declare `vision`
    if (!/>\s*vision\s*</i.test(card)) continue
    models.push({ name, docFocused: isDocFocusedName(name) })
  }
  if (models.length === 0) return null
  // document-readers first — they're the right tool for reading print
  models.sort((a, b) => Number(b.docFocused) - Number(a.docFocused))
  const top = models.slice(0, 14)
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), models: top }))
  } catch { /* quota */ }
  return top
}

/** Size variants (2b/8b/…) for a model, live from its ollama.com tags page. */
export async function fetchOllamaSizeTags(model: string): Promise<{ tag: string; paramsB: number }[] | null> {
  const html = await fetchCatalogText(`https://ollama.com/library/${encodeURIComponent(model)}/tags`)
  if (!html) return null
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${esc}:([a-z0-9.-]+)`, 'g')
  const tags = [...new Set([...html.matchAll(re)].map((m) => m[1]))]
  const sized = tags
    .map((t) => {
      const m = t.match(/^(\d+(?:\.\d+)?)b$/)
      return m ? { tag: t, paramsB: parseFloat(m[1]) } : null
    })
    .filter((x): x is { tag: string; paramsB: number } => x !== null)
    .sort((a, b) => a.paramsB - b.paramsB)
  return sized.length ? sized : null
}

/* pull progress fan-out for the Electron path — one IPC listener, many pulls */
const pullCallbacks = new Map<string, (pct: number, status: string) => void>()
let pullListenerArmed = false

/** Install a model through the local Ollama server, streaming progress. */
export async function ollamaPull(
  baseUrl: string,
  model: string,
  onProgress: (pct: number, status: string) => void,
): Promise<void> {
  const native = window.reshapedpdfNative
  if (native?.ollamaPull) {
    if (!pullListenerArmed) {
      pullListenerArmed = true
      native.onPullProgress((p) => pullCallbacks.get(p.model)?.(p.pct, p.status))
    }
    pullCallbacks.set(model, onProgress)
    try {
      await native.ollamaPull(new URL(normalizeBaseUrl(baseUrl)).origin, model)
      return
    } finally {
      pullCallbacks.delete(model)
    }
  }

  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const res = await fetch(`${root}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`pull failed: ${res.status} ${res.statusText}`)
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
      let j: { error?: string; status?: string; total?: number; completed?: number }
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      if (j.error) throw new Error(j.error)
      if (j.total && j.completed != null) onProgress(Math.round((j.completed / j.total) * 100), j.status ?? '')
      else onProgress(-1, j.status ?? '')
      if (j.status === 'success') return
    }
  }
}

/** Cheap connectivity + auth check. */
/** A tiny image carrying a distinctive number, for the vision round-trip below. */
function makeVisionProbe(): { url: string; answer: string } {
  const answer = '426' // uncommon in prose, so a text-only model's apology can't fake a pass
  const c = document.createElement('canvas')
  c.width = 128; c.height = 56
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#000'; ctx.font = 'bold 44px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(answer, c.width / 2, c.height / 2 + 2)
  return { url: c.toDataURL('image/png'), answer }
}

export async function testConnection(cfg: AiConfig): Promise<{ ok: boolean; message: string }> {
  let t0 = performance.now()
  // Round-trip a real IMAGE, not just text. Every feature that uses a model —
  // peel, retype off an image, colour reading — needs VISION. A text-only model
  // sails through a plain chat and then fails opaquely mid-edit ("connected!",
  // then a wall of nothing when you actually peel). Draw a known number and ask
  // the model to read it back: a non-vision model either rejects the image
  // (throws) or answers without the number.
  try {
    const { url, answer } = makeVisionProbe()
    t0 = performance.now()
    const reply = await chat(
      cfg,
      [{ type: 'text', text: 'What number is shown in this image? Reply with digits only.' },
       { type: 'image_url', image_url: { url } }],
      16, 60_000,
    )
    const ms = Math.round(performance.now() - t0)
    if (reply.replace(/\D/g, '').includes(answer)) {
      return { ok: true, message: `Connected — read the test image in ${ms}ms` }
    }
    return {
      ok: false,
      message: `Connected, but this model didn't read the test image (got “${reply.trim().slice(0, 24)}”). Choose a vision model.`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
