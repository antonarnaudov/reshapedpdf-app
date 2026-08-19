/** Pointer capture that tolerates pen/touch edge cases, released pointers and synthetic events. */
export function capturePointer(e: { currentTarget: EventTarget | null; pointerId: number }): void {
  try {
    ;(e.currentTarget as Element)?.setPointerCapture?.(e.pointerId)
  } catch {
    /* capture is an optimization, never a requirement */
  }
}
