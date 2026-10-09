export interface HeifImageDimensions {
  readonly width: number
  readonly height: number
}

interface Box {
  readonly type: string
  readonly contentStart: number
  readonly end: number
}

export function findHeifImageDimensions(buffer: ArrayBuffer): readonly HeifImageDimensions[] | null {
  const view = new DataView(buffer)
  const dimensions: HeifImageDimensions[] = []

  const parseImageProperties = (ipco: Box): boolean => forEachBox(view, ipco.contentStart, ipco.end, (property) => {
    if (property.type !== 'ispe' || property.end - property.contentStart < 12) return true
    const width = view.getUint32(property.contentStart + 4)
    const height = view.getUint32(property.contentStart + 8)
    if (width < 1 || height < 1) return false
    dimensions.push({ width, height })
    return true
  })

  const parseImagePropertyContainer = (iprp: Box): boolean => forEachBox(view, iprp.contentStart, iprp.end, (property) => {
    return property.type !== 'ipco' || parseImageProperties(property)
  })

  const parseMeta = (meta: Box): boolean => {
    if (meta.end - meta.contentStart < 4) return false
    return forEachBox(view, meta.contentStart + 4, meta.end, (child) => {
      return child.type !== 'iprp' || parseImagePropertyContainer(child)
    })
  }

  const valid = forEachBox(view, 0, view.byteLength, (box) => box.type !== 'meta' || parseMeta(box))
  return valid && dimensions.length > 0 ? dimensions : null
}

function forEachBox(view: DataView, start: number, end: number, visit: (box: Box) => boolean): boolean {
  let offset = start
  while (offset < end) {
    if (end - offset < 8) return false
    let size = view.getUint32(offset)
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7))
    let headerSize = 8
    if (size === 1) {
      if (end - offset < 16) return false
      const extendedSize = view.getBigUint64(offset + 8)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false
      size = Number(extendedSize)
      headerSize = 16
    } else if (size === 0) size = end - offset
    if (size < headerSize || size > end - offset) return false
    if (!visit({ type, contentStart: offset + headerSize, end: offset + size })) return false
    offset += size
  }
  return offset === end
}
