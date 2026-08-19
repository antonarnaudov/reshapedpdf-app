import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'

const ember = rgb(1, 0.36, 0.12)
const inkDark = rgb(0.13, 0.13, 0.15)
const inkMid = rgb(0.42, 0.42, 0.45)
const hair = rgb(0.88, 0.87, 0.85)

/** A three-page demo: invoice, letter (text to search/highlight), and a live form. */
export async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold)
  const times = await doc.embedFont(StandardFonts.TimesRoman)

  /* ---- page 1: invoice ---- */
  const p1 = doc.addPage([612, 792])
  p1.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: inkDark })
  p1.drawText('IRONWORKS SUPPLY CO.', { x: 48, y: 761, size: 16, font: helvB, color: rgb(1, 1, 1) })
  p1.drawText('INVOICE  #2041', { x: 448, y: 761, size: 13, font: helvB, color: ember })

  p1.drawText('Billed to', { x: 48, y: 700, size: 9, font: helvB, color: inkMid })
  p1.drawText('Arnaud & Partners Ltd.\n14 Vitosha Blvd\nSofia 1000, Bulgaria', {
    x: 48, y: 684, size: 11, font: helv, color: inkDark, lineHeight: 15,
  })
  p1.drawText('Issued', { x: 400, y: 700, size: 9, font: helvB, color: inkMid })
  p1.drawText('July 3, 2026', { x: 400, y: 686, size: 11, font: helv, color: inkDark })
  p1.drawText('Due', { x: 400, y: 664, size: 9, font: helvB, color: inkMid })
  p1.drawText('July 31, 2026', { x: 400, y: 650, size: 11, font: helv, color: inkDark })

  const rows: [string, string, string, string][] = [
    ['Anvil, 35 kg — forged steel', '2', '410.00', '820.00'],
    ['Cross-peen hammer, 1.5 kg', '6', '38.00', '228.00'],
    ['Tongs, wolf-jaw 400 mm', '4', '52.50', '210.00'],
    ['Coal, bituminous — 25 kg bag', '10', '19.90', '199.00'],
  ]
  let y = 600
  p1.drawLine({ start: { x: 48, y: y + 6 }, end: { x: 564, y: y + 6 }, thickness: 1.2, color: inkDark })
  p1.drawText('Item', { x: 48, y: y - 12, size: 9, font: helvB, color: inkMid })
  p1.drawText('Qty', { x: 380, y: y - 12, size: 9, font: helvB, color: inkMid })
  p1.drawText('Unit', { x: 430, y: y - 12, size: 9, font: helvB, color: inkMid })
  p1.drawText('Amount', { x: 505, y: y - 12, size: 9, font: helvB, color: inkMid })
  y -= 24
  for (const [item, qty, unit, amt] of rows) {
    y -= 22
    p1.drawText(item, { x: 48, y, size: 10.5, font: helv, color: inkDark })
    p1.drawText(qty, { x: 385, y, size: 10.5, font: helv, color: inkDark })
    p1.drawText(unit, { x: 430, y, size: 10.5, font: helv, color: inkDark })
    p1.drawText(amt, { x: 505, y, size: 10.5, font: helv, color: inkDark })
    p1.drawLine({ start: { x: 48, y: y - 7 }, end: { x: 564, y: y - 7 }, thickness: 0.5, color: hair })
  }
  p1.drawText('Total due', { x: 400, y: y - 40, size: 11, font: helvB, color: inkDark })
  p1.drawText('EUR 1,457.00', { x: 490, y: y - 40, size: 12, font: helvB, color: ember })
  p1.drawText('Payment within 28 days. Note the misprinted delivery address above — it needs correcting.', {
    x: 48, y: 96, size: 9.5, font: helv, color: inkMid,
  })
  p1.drawText('Ironworks Supply Co. · Reg 204-556-1 · forge@ironworks.example', {
    x: 48, y: 48, size: 8.5, font: helv, color: inkMid,
  })

  /* ---- page 2: letter ---- */
  const p2 = doc.addPage([612, 792])
  p2.drawText('A short note on repairing documents', { x: 72, y: 700, size: 20, font: times, color: inkDark })
  const paragraphs = [
    'Every office has one: the PDF nobody can change. The lease with the wrong date, the invoice',
    'with a typo in the address, the scanned form that must be signed by Friday. The file is final,',
    'the sender is on holiday, and the deadline is not.',
    '',
    'ReshapedPDF treats a PDF the way a smith treats iron — not as a finished thing, but as material.',
    'Highlight the clause that matters. Strike the sentence that does not. White out the wrong',
    'number and type the right one over it, matched to the paper so the repair disappears.',
    'Drop in your signature, rotate the sideways scan, pull three pages out and send only those.',
    '',
    'Try it on this very page: select this text and highlight it, sign below, or white out any',
    'sentence you disagree with. The document will not mind. It is only material.',
  ]
  let ly = 650
  for (const line of paragraphs) {
    p2.drawText(line, { x: 72, y: ly, size: 12, font: times, color: inkDark })
    ly -= 20
  }
  p2.drawLine({ start: { x: 72, y: 220 }, end: { x: 300, y: 220 }, thickness: 1, color: inkDark })
  p2.drawText('Signature', { x: 72, y: 204, size: 9, font: helv, color: inkMid })
  p2.drawText('— The ReshapedPDF team', { x: 72, y: 320, size: 12, font: times, color: inkMid })

  /* ---- page 3: form ---- */
  const p3 = doc.addPage([612, 792])
  p3.drawText('Workshop registration', { x: 48, y: 726, size: 18, font: helvB, color: inkDark })
  p3.drawText('An interactive AcroForm — fill it right here, then export.', { x: 48, y: 702, size: 10.5, font: helv, color: inkMid })

  const form = doc.getForm()
  const label = (t: string, yy: number) =>
    p3.drawText(t, { x: 48, y: yy, size: 10, font: helvB, color: inkDark })

  label('Full name', 660)
  const name = form.createTextField('attendee.name')
  name.addToPage(p3, { x: 48, y: 626, width: 250, height: 26, borderColor: inkMid, borderWidth: 1 })

  label('Email', 596)
  const email = form.createTextField('attendee.email')
  email.addToPage(p3, { x: 48, y: 562, width: 250, height: 26, borderColor: inkMid, borderWidth: 1 })

  p3.drawText('Workshop track', { x: 380, y: 660, size: 10, font: helvB, color: inkDark })
  const track = form.createRadioGroup('attendee.track')
  track.addOptionToPage('Forging', p3, { x: 380, y: 626, width: 16, height: 16 })
  track.addOptionToPage('Welding', p3, { x: 380, y: 596, width: 16, height: 16 })
  p3.drawText('Forging basics', { x: 404, y: 630, size: 10, font: helv, color: inkDark })
  p3.drawText('Welding & joinery', { x: 404, y: 600, size: 10, font: helv, color: inkDark })

  p3.drawText('Experience level', { x: 380, y: 560, size: 10, font: helvB, color: inkDark })
  const level = form.createDropdown('attendee.level')
  level.addOptions(['Beginner', 'Intermediate', 'Advanced'])
  level.select('Beginner')
  level.addToPage(p3, { x: 380, y: 526, width: 170, height: 24, borderColor: inkMid, borderWidth: 1 })

  const news = form.createCheckBox('attendee.newsletter')
  news.addToPage(p3, { x: 48, y: 500, width: 15, height: 15 })
  p3.drawText('Send me the quarterly foundry letter', { x: 70, y: 503, size: 10, font: helv, color: inkDark })

  label('Anything we should know?', 466)
  const notes = form.createTextField('attendee.notes')
  notes.enableMultiline()
  notes.addToPage(p3, { x: 48, y: 380, width: 502, height: 78, borderColor: inkMid, borderWidth: 1 })

  p3.drawText('Bring ear protection. Coffee is on the house.', { x: 48, y: 96, size: 9.5, font: helv, color: inkMid })

  doc.setTitle('ReshapedPDF sample — invoice, letter & form')
  doc.setProducer('ReshapedPDF Studio')
  return doc.save()
}

/** One blank page matching the given size (defaults to US Letter). */
export async function makeBlankPdf(width = 612, height = 792): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([width, height])
  return doc.save()
}

/** Build a PDF out of images (one page per image, page sized to the image at 72 dpi, capped to A4-ish width). */
export async function makePdfFromImages(images: { bytes: Uint8Array; type: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  let ok = 0
  for (const img of images) {
    try {
      // A truncated download or a file renamed to .png/.jpg (WebP/HEIC) makes
      // embedPng/embedJpg throw — skip that one rather than losing the whole batch.
      const embedded = img.type.includes('png') ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes)
      const maxW = 1000
      const scale = Math.min(1, maxW / embedded.width)
      const w = embedded.width * scale
      const h = embedded.height * scale
      const page = doc.addPage([w, h])
      page.drawImage(embedded, { x: 0, y: 0, width: w, height: h })
      ok++
    } catch { /* corrupt or unsupported image — skip it */ }
  }
  if (!ok) throw new Error('none of the images could be read (corrupt or unsupported)')
  doc.setProducer('ReshapedPDF Studio')
  return doc.save()
}

// keep tree-shaking from stripping degrees import used by future revisions
void degrees
