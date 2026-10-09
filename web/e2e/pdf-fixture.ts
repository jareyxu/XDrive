import { closeSync, openSync, writeSync } from 'node:fs'

/** Non-linearized PDF with real uncompressed image data spread across pages. */
export function createRangePDFFixture(path: string, pageCount = 100, compactMetadata = false): { size: number; pageCount: number; xrefOffset: number } {
  const width = 768
  const height = 912
  const file = openSync(path, 'wx')
  let offset = 0
  const offsets: number[] = [0]
  const write = (value: string | Buffer) => {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'ascii') : value
    let written = 0
    while (written < bytes.length) written += writeSync(file, bytes, written, bytes.length - written)
    offset += bytes.length
  }
  const object = (id: number, value: string) => { offsets[id] = offset; write(`${id} 0 obj\n${value}\nendobj\n`) }
  try {
    write('%PDF-1.7\n% deterministic XDrive range fixture\n')
    object(1, '<< /Type /Catalog /Pages 2 0 R >>')
    object(2, `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 3} 0 R`).join(' ')}] >>`)
    object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const pageDictionary = (pageId: number) => {
      object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>`)
    }
    if (compactMetadata) for (let index = 0; index < pageCount; index += 1) pageDictionary(4 + index * 3)
    for (let index = 0; index < pageCount; index += 1) {
      const pageId = 4 + index * 3
      if (!compactMetadata) pageDictionary(pageId)
      const content = `q 540 0 0 641 36 72 cm /Im0 Do Q\nBT /F1 20 Tf 36 742 Td (XDrive Range fixture - page ${index + 1}) Tj ET\n`
      object(pageId + 1, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`)
      const image = Buffer.alloc(width * height * 3)
      // Every byte belongs to an image that is actually rendered. Color bands
      // make random-page results visually distinct without a giant filler object.
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const position = (y * width + x) * 3
          image[position] = (index * 29 + Math.floor(y / 32) * 7) % 256
          image[position + 1] = (index * 43 + Math.floor(x / 32) * 9) % 256
          image[position + 2] = 160 + index % 80
        }
      }
      offsets[pageId + 2] = offset
      write(`${pageId + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`)
      write(image)
      write('\nendstream\nendobj\n')
    }
    const xrefOffset = offset
    write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`)
    for (const address of offsets.slice(1)) write(`${String(address).padStart(10, '0')} 00000 n \n`)
    write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
    return { size: offset, pageCount, xrefOffset }
  } finally { closeSync(file) }
}
