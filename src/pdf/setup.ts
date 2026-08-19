import * as pdfjs from 'pdfjs-dist'

// Module worker via URL keeps this working in Vite dev, static builds, and Electron file://
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
  { type: 'module' },
)

const assetBase = new URL(`${import.meta.env.BASE_URL}pdf-assets/`, window.location.href).toString()

export const PDFJS_DOC_PARAMS = {
  cMapUrl: `${assetBase}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  // keep the raw font program on each font object so we can read its real name
  // (and, for embedded faces, its bytes) when retyping printed text
  fontExtraProperties: true,
}

export { pdfjs }
