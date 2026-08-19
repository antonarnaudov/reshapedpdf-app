/// <reference types="vite/client" />

interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled'
  version: string | null
  notes: string | null
  percent: number
}

interface ReshapedPDFNative {
  updateCheck?: (manual?: boolean) => Promise<UpdateState>
  updateDownload?: () => Promise<UpdateState>
  updateInstall?: () => Promise<boolean>
  updateDismiss?: (version: string | null) => Promise<boolean>
  onUpdate?: (cb: (s: UpdateState) => void) => void
  platform: string
  saveFile: (name: string, bytes: Uint8Array) => Promise<{ ok: boolean; path?: string }>
  openFiles: () => Promise<{ name: string; bytes: Uint8Array }[]>
  openTemp: (name: string, bytes: Uint8Array) => Promise<void>
  sysInfo: () => Promise<{ ramGB: number; arch: string; cpus: number }>
  fetchText: (url: string) => Promise<string>
  startOllama: () => Promise<{ ok: boolean; reason?: string }>
  proxyJson: (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; statusText: string; text: string }>
  ollamaPull: (root: string, model: string) => Promise<{ ok: boolean }>
  onPullProgress: (cb: (p: { model: string; pct: number; status: string }) => void) => void
  onMenu: (cb: (id: string) => void) => void
  onOpenFile: (cb: (f: { name: string; bytes: Uint8Array }) => void) => void
  /** push the unsaved-document count so the main process can guard close/quit/reload */
  setDirtyCount?: (n: number) => void
}

interface Window {
  reshapedpdfNative?: ReshapedPDFNative
  __reshapedpdf?: Record<string, (...args: never[]) => unknown>
}
