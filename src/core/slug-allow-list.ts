/**
 * Match one canonical page slug against recursive or exact slug fences.
 *
 * A trailing `/*` or `/` permits descendants but not the namespace root.
 * A bare fence permits only the exact slug.
 */
export function matchesSlugAllowList(slug: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (prefix.endsWith('/*')) {
      const base = prefix.slice(0, -2);
      if (slug !== base && slug.startsWith(`${base}/`)) return true;
    } else if (prefix.endsWith('/')) {
      if (slug.startsWith(prefix) && slug.length > prefix.length) return true;
    } else if (prefix === slug) {
      return true;
    }
  }
  return false;
}

/** Return whether every slug matched by a requested fence is inside a bound fence. */
export function slugFenceContains(bound: string, requested: string): boolean {
  const boundBase = recursiveSlugFenceBase(bound);
  const requestedBase = recursiveSlugFenceBase(requested);
  if (boundBase === null) {
    return requestedBase === null && requested === bound;
  }
  const requestedAnchor = requestedBase ?? requested;
  return requestedAnchor.startsWith(`${boundBase}/`)
    || (requestedBase !== null && requestedAnchor === boundBase);
}

/** Strip the recursive suffix from one slash- or glob-form slug fence. */
function recursiveSlugFenceBase(fence: string): string | null {
  if (fence.endsWith('/*')) return fence.slice(0, -2);
  if (fence.endsWith('/')) return fence.slice(0, -1);
  return null;
}
