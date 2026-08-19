/**
 * The catalog of model platforms ReshapedPDF knows how to connect to — the settings
 * UI turns this into a "pick your provider" gallery so connecting is one click +
 * (usually) one API key. Every preset is editable after the fact.
 *
 * One wire protocol covers the field: the OpenAI-compatible `/chat/completions`
 * API with vision input. Ollama, LM Studio, OpenAI, Gemini's compat endpoint,
 * vLLM, and (later) the hosted ReshapedPDF gateway all speak it.
 */

export interface ProviderPreset {
  /** Stable catalog key, stored with the connection. */
  id: string
  label: string
  /** Short tagline for the gallery card. */
  blurb: string
  /** OpenAI-compat `/v1` root. Empty = user fills it in. */
  baseUrl: string
  /** Default vision-capable model id. Editable. */
  model: string
  needsKey: boolean
  /** Localhost server — surfaced with a privacy note. */
  local?: boolean
  keyUrl?: string
  note?: string
  /** Not selectable yet (hosted gateway). */
  comingSoon?: boolean
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    blurb: 'Free, private, offline — ReshapedPDF installs models for you.',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    needsKey: false,
    local: true,
    note: 'Install Ollama from ollama.com, then pick or install a vision model below — the list is fetched live, never hardcoded.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    blurb: 'Point at any vision model loaded in LM Studio.',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    needsKey: false,
    local: true,
    note: 'In LM Studio: Discover tab → search “VL” or “vision” — pick the newest release that fits your RAM (on Apple Silicon prefer MLX builds). Start the local server (Developer tab), load the model, then pick it below.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'GPT-4o family via your API key.',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    blurb: 'Gemini Flash via the OpenAI-compatible endpoint.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    blurb: 'Any OpenAI-compatible server: vLLM, llama.cpp, a gateway…',
    baseUrl: '',
    model: '',
    needsKey: false,
  },
  {
    id: 'reshapedpdf-cloud',
    label: 'ReshapedPDF Cloud',
    blurb: 'Our tuned blending models — one toggle, no setup.',
    baseUrl: '',
    model: '',
    needsKey: true,
    comingSoon: true,
  },
] as const

export interface AiConfig {
  presetId: string
  baseUrl: string
  model: string
  apiKey: string
}

/* ---------------- hardware-aware local model recommendations ---------------- */

export interface MachineInfo {
  ramGB: number | null
  appleSilicon: boolean
  cpus: number
}

/** Best-effort machine sniffing: exact in Electron, approximate in browsers. */
export async function detectMachine(): Promise<MachineInfo> {
  const native = window.reshapedpdfNative
  if (native?.sysInfo) {
    try {
      const s = await native.sysInfo()
      return { ramGB: s.ramGB, appleSilicon: s.arch === 'arm64' && native.platform === 'darwin', cpus: s.cpus }
    } catch { /* fall through */ }
  }
  const nav = navigator as Navigator & { deviceMemory?: number }
  const mac = /Mac/.test(navigator.platform)
  return {
    // browsers cap deviceMemory at 8 — treat it as a floor, not a measurement
    ramGB: typeof nav.deviceMemory === 'number' ? (nav.deviceMemory >= 8 ? null : nav.deviceMemory) : null,
    appleSilicon: mac, // most Macs in the wild are Apple Silicon by now
    cpus: navigator.hardwareConcurrency ?? 4,
  }
}

/**
 * RAM → largest sensible parameter count (q4-ish quantization rule of thumb:
 * a model needs ~0.65 GB per B params, plus headroom for the OS and the app).
 * Model NAMES are never hardcoded — they come live from the server/catalog.
 */
export function ramFitParamsB(ramGB: number | null): number {
  const ram = ramGB ?? 16
  if (ram <= 8) return 4
  if (ram <= 16) return 9
  if (ram <= 36) return 34
  return 120
}

export const estGBForParams = (paramsB: number): number => Math.round(paramsB * 0.65 * 10) / 10
