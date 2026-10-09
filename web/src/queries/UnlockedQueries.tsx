import { QueryClientProvider } from '@tanstack/react-query'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createUnlockedQueryClient, OwnerContext, QueryOwner } from './query-scope'

// Only server-visible counters/policies belong here. Keys, decrypted names,
// indexes, thumbnails and recovery records must never enter this cache.
export function UnlockedQueries({ children }: { children: ReactNode }) {
  const [client] = useState(createUnlockedQueryClient)
  const [owner] = useState(() => new QueryOwner())
  useLayoutEffect(() => {
    owner.open()
    return () => { owner.close(); client.clear() }
  }, [client, owner])
  return <OwnerContext.Provider value={owner}><QueryClientProvider client={client}>{children}</QueryClientProvider></OwnerContext.Provider>
}
