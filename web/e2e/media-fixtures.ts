import type { Page } from '@playwright/test'

export async function createPreviewPNG(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable')
    context.fillStyle = '#2678c8'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#f2c547'
    context.fillRect(50, 30, 120, 100)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  })
  return Buffer.from(encoded, 'base64')
}

export function createMinimalPDF(): Buffer {
  const stream = 'BT /F1 18 Tf 20 60 Td (PDF preview fixture) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach(offset => { document += `${String(offset).padStart(10, '0')} 00000 n \n` })
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document)
}
