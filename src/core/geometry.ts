import type { AnyObj, Rect, Rotation } from './types'

/*
 * Coordinate spaces
 * -----------------
 * view space : CSS pixels at zoom 1, origin top-left, in the page's *displayed*
 *              orientation (source /Rotate + user rotation applied).
 * user space : PDF coordinates, origin bottom-left of the (unrotated) page,
 *              possibly offset by the crop box origin (cx, cy).
 *
 * For a page displayed with total rotation R and crop box (cx, cy, uw, uh):
 *   view dims: R in {90, 270} ? (uh, uw) : (uw, uh)
 */

export interface PageGeom {
  cx: number
  cy: number
  uw: number
  uh: number
  rot: Rotation // total rotation (source + user)
}

export const viewDims = (g: PageGeom): { w: number; h: number } =>
  g.rot % 180 === 90 ? { w: g.uh, h: g.uw } : { w: g.uw, h: g.uh }

/** user-space point -> view-space point */
export function userToView(g: PageGeom, X: number, Y: number): [number, number] {
  const x = X - g.cx
  const y = Y - g.cy
  switch (g.rot) {
    case 0:
      return [x, g.uh - y]
    case 90:
      return [y, x]
    case 180:
      return [g.uw - x, y]
    case 270:
      return [g.uh - y, g.uw - x]
  }
}

/** view-space point -> user-space point */
export function viewToUser(g: PageGeom, x: number, y: number): [number, number] {
  switch (g.rot) {
    case 0:
      return [g.cx + x, g.cy + g.uh - y]
    case 90:
      return [g.cx + y, g.cy + x]
    case 180:
      return [g.cx + g.uw - x, g.cy + y]
    case 270:
      return [g.cx + g.uw - y, g.cy + g.uh - x]
  }
}

export function userRectToView(g: PageGeom, r: [number, number, number, number]): Rect {
  const [ax, ay] = userToView(g, r[0], r[1])
  const [bx, by] = userToView(g, r[2], r[3])
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  }
}

export function viewRectToUser(g: PageGeom, r: Rect): [number, number, number, number] {
  const [ax, ay] = viewToUser(g, r.x, r.y)
  const [bx, by] = viewToUser(g, r.x + r.w, r.y + r.h)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/**
 * Transformation matrix mapping the "flipped view frame" F -> user space.
 * F has origin at the page's bottom-left *as displayed*, x right, y up,
 * in view-space units. Drawing in F lets the exporter use identical math for
 * every rotation: fx = viewX, fyUp = viewH - viewY.
 * Returns [a, b, c, d, e, f] for the PDF `cm` operator.
 */
export function frameMatrix(g: PageGeom): [number, number, number, number, number, number] {
  switch (g.rot) {
    case 0:
      return [1, 0, 0, 1, g.cx, g.cy]
    case 90:
      return [0, 1, -1, 0, g.cx + g.uw, g.cy]
    case 180:
      return [-1, 0, 0, -1, g.cx + g.uw, g.cy + g.uh]
    case 270:
      return [0, -1, 1, 0, g.cx, g.cy + g.uh]
  }
}

/* ---------- object transforms when the user rotates a page ---------- */

const rotPointCW = (x: number, y: number, H: number): [number, number] => [H - y, x]
const rotPointCCW = (x: number, y: number, W: number): [number, number] => [y, W - x]

function rotRect(r: Rect, cw: boolean, dims: { w: number; h: number }): Rect {
  return cw
    ? { x: dims.h - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : { x: r.y, y: dims.w - r.x - r.w, w: r.h, h: r.w }
}

/** Rotate an object's coordinates when its page is rotated by ±90°. `dims` = view dims BEFORE the rotation. */
export function rotateObj(obj: AnyObj, cw: boolean, dims: { w: number; h: number }): AnyObj {
  const rp = (x: number, y: number): [number, number] =>
    cw ? rotPointCW(x, y, dims.h) : rotPointCCW(x, y, dims.w)

  switch (obj.kind) {
    case 'ink':
      return { ...obj, points: obj.points.map(([x, y]) => rp(x, y)) }
    case 'markup':
      return { ...obj, rects: obj.rects.map((r) => rotRect(r, cw, dims)) }
    case 'note': {
      const [x, y] = rp(obj.x, obj.y)
      return { ...obj, x, y }
    }
    case 'vector': {
      // The path lives in the object's own local space, so a rotation is just
      // the box turning: the geometry rides along untouched.
      const r = rotRect({ x: obj.x, y: obj.y, w: obj.w, h: obj.h }, cw, dims)
      return { ...obj, ...r }
    }
    case 'shape': {
      if (obj.mode === 'line' || obj.mode === 'arrow') {
        const [x1, y1] = rp(obj.x, obj.y)
        const [x2, y2] = rp(obj.x + obj.w, obj.y + obj.h)
        return { ...obj, x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
      }
      const r = rotRect({ x: obj.x, y: obj.y, w: obj.w, h: obj.h }, cw, dims)
      return { ...obj, ...r }
    }
    case 'text':
    case 'image':
    case 'whiteout': {
      // Text, images, and TEXTURED erase/lift patches carry an orientation the box
      // alone can't: a run reads left-to-right, a photo/patch has an up. Swapping
      // the box (rotRect) without turning the content left the words flat in a
      // portrait box and squashed the bitmap. Record the content's own turn so the
      // renderer and exporter draw it rotated inside the (still axis-aligned) box.
      // A flat-colour whiteout ignores rot (a solid rect is rotation-invariant).
      const r = rotRect({ x: obj.x, y: obj.y, w: obj.w, h: obj.h }, cw, dims)
      const rot = (((obj.rot ?? 0) + (cw ? 90 : 270)) % 360) as typeof obj.rot
      return { ...obj, ...r, rot }
    }
    default: {
      const r = rotRect({ x: obj.x, y: obj.y, w: obj.w, h: obj.h }, cw, dims)
      return { ...obj, ...r }
    }
  }
}

/* ---------- hit testing ---------- */

export function objBounds(obj: AnyObj): Rect {
  switch (obj.kind) {
    case 'ink': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (const [x, y] of obj.points) {
        x1 = Math.min(x1, x); y1 = Math.min(y1, y)
        x2 = Math.max(x2, x); y2 = Math.max(y2, y)
      }
      const pad = obj.width / 2 + 1
      return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 }
    }
    case 'markup': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (const r of obj.rects) {
        x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y)
        x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h)
      }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }
    case 'note':
      return { x: obj.x, y: obj.y, w: 26, h: 26 }
    case 'vector':
      return { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
    case 'shape':
      if (obj.mode === 'line' || obj.mode === 'arrow') {
        const x1 = Math.min(obj.x, obj.x + obj.w)
        const y1 = Math.min(obj.y, obj.y + obj.h)
        return { x: x1, y: y1, w: Math.abs(obj.w), h: Math.abs(obj.h) }
      }
      return { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
    default:
      return { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
  }
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export function hitTest(obj: AnyObj, x: number, y: number, slack: number): boolean {
  if (obj.kind === 'shape' && (obj.mode === 'line' || obj.mode === 'arrow')) {
    return distToSegment(x, y, obj.x, obj.y, obj.x + obj.w, obj.y + obj.h) <= obj.strokeWidth / 2 + slack + 2
  }
  if (obj.kind === 'ink') {
    const b = objBounds(obj)
    if (!inRect(x, y, b, slack)) return false
    for (let i = 0; i < obj.points.length - 1; i++) {
      const [x1, y1] = obj.points[i]
      const [x2, y2] = obj.points[i + 1]
      if (distToSegment(x, y, x1, y1, x2, y2) <= obj.width / 2 + slack + 2) return true
    }
    return obj.points.length === 1 && Math.hypot(x - obj.points[0][0], y - obj.points[0][1]) < slack + 4
  }
  if (obj.kind === 'markup') return obj.rects.some((r) => inRect(x, y, r, slack))
  if (obj.kind === 'shape' && obj.mode === 'rect' && !obj.fill) {
    // hollow rectangle: only edges are grabbable so content underneath stays reachable
    const b = objBounds(obj)
    const outer = inRect(x, y, b, slack + obj.strokeWidth / 2)
    const innerPad = slack + obj.strokeWidth / 2 + 3
    const inner =
      x > b.x + innerPad && x < b.x + b.w - innerPad && y > b.y + innerPad && y < b.y + b.h - innerPad
    return outer && !inner
  }
  return inRect(x, y, objBounds(obj), slack)
}

export const inRect = (x: number, y: number, r: Rect, slack = 0): boolean =>
  x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack

export const normRect = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
})

/** Translate any object by (dx, dy) in view space. */
export function translateObj(obj: AnyObj, dx: number, dy: number): AnyObj {
  switch (obj.kind) {
    case 'ink':
      return { ...obj, points: obj.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
    case 'markup':
      return { ...obj, rects: obj.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) }
    default:
      return { ...obj, x: obj.x + dx, y: obj.y + dy }
  }
}

/** Arrowhead endpoints for a line from p1 to p2 (two barbs at the p2 end). */
export function arrowHead(
  x1: number, y1: number, x2: number, y2: number, strokeWidth: number,
): [[number, number], [number, number]] {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.min(26, Math.max(9, 6 + strokeWidth * 3.4))
  const spread = 0.46
  return [
    [x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread)],
    [x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread)],
  ]
}

/** Smooth an ink stroke into an SVG path via quadratic midpoints. */
export function inkPath(points: [number, number][]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const [x, y] = points[0]
    return `M ${x} ${y} L ${x + 0.01} ${y}`
  }
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[i + 1]
    d += ` Q ${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`
  }
  const last = points[points.length - 1]
  d += ` L ${last[0]} ${last[1]}`
  return d
}
