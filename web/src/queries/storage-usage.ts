import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchStorageUsage } from '../api/client'
import { useUnlockedQueryOwner } from './query-scope'

const usageKey = ['storage-usage'] as const

export function useStorageUsage(revision: number, polling = false) {
  const owner = useUnlockedQueryOwner()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: usageKey,
    queryFn: async ({ signal }) => {
      const epoch = owner.capture()
      signal.throwIfAborted()
      const usage = await fetchStorageUsage(signal)
      // Even an already-completed response must not publish after cancellation.
      signal.throwIfAborted()
      owner.assert(epoch)
      return usage
    },
    refetchInterval: polling ? 3000 : false,
    refetchIntervalInBackground: true,
  })
  useEffect(() => {
    // Multiple views observe one resource. Only the first observer seeing a
    // new vault revision cancels the stale read and starts its replacement.
    if (owner.observeUsageRevision(revision)) {
      const epoch = owner.capture()
      void (async () => {
        await client.cancelQueries({ queryKey: usageKey, exact: true })
        owner.assertUsageRevision(revision, epoch)
        await client.invalidateQueries({ queryKey: usageKey, exact: true })
      })().catch(cause => { if (!(cause instanceof DOMException && cause.name === 'AbortError')) throw cause })
    }
  }, [client, owner, revision])
  const read = useCallback(async (signal?: AbortSignal) => {
    const epoch = owner.capture()
    signal?.throwIfAborted()
    // A task explicitly rechecking quota supersedes an older background read.
    await client.cancelQueries({ queryKey: usageKey, exact: true })
    signal?.throwIfAborted(); owner.assert(epoch)
    const usage = await fetchStorageUsage(signal)
    signal?.throwIfAborted(); owner.assert(epoch)
    client.setQueryData(usageKey, usage)
    return usage
  }, [client, owner])
  return { ...query, read }
}
