import { useEffect, useMemo, useState } from 'react'
import type { ThumbnailCache } from '../media/thumbnail-cache'
import type { ThumbnailReference } from '../media/thumbnail-schema'
import { File } from 'lucide-react'
export function ThumbnailImage({ cache, fileId, thumbnail }: { cache: ThumbnailCache; fileId: string; thumbnail: ThumbnailReference }) {
 const { objectId, sizeBytes, sha256, mime, width, height, keyVersion } = thumbnail
 const identity = useMemo(() => ({ fileId, thumbnail: { objectId, sizeBytes, sha256, mime, width, height, ...(keyVersion === undefined ? {} : { keyVersion }) } }), [fileId, objectId, sizeBytes, sha256, mime, width, height, keyVersion])
 const key = `${fileId}:${thumbnail.keyVersion ?? 1}:${thumbnail.objectId}:${thumbnail.sha256}:${thumbnail.sizeBytes}:${thumbnail.width}:${thumbnail.height}`
 const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
 useEffect(() => {
  const controller = new AbortController()
  void cache.load(identity, controller.signal).then(url => { if (!controller.signal.aborted) setLoaded({ key, url }) }).catch(() => { /* A broken thumbnail never blocks the file; keep its type icon. */ })
  return () => controller.abort()
 }, [cache, identity, key])
 return loaded?.key === key ? <img src={loaded.url} alt="" aria-hidden="true" width={thumbnail.width} height={thumbnail.height} onError={() => setLoaded(null)} /> : <File size={42} aria-hidden="true" />
}
