/**
 * Collection access control — resolves which user's collection (playlist / library)
 * a request is allowed to touch, strictly from the *verified* identity.
 *
 * Back-ported from upstream XCQ0607/lxserver PR #457 (released in v2.1.4).
 * Before this, several user-collection routes fell back to a caller-supplied
 * name (`?user=` / `x-user-name`), allowing an unauthenticated request to read
 * or overwrite another user's private playlists & library (IDOR / auth bypass).
 * This helper never trusts a display name that is not backed by a verified token.
 */
export function resolveCollectionUser(
  requested: string,
  verified: string | null,
  admin: boolean,
  allowOpen: boolean,
  write: boolean,
): string | null {
  // No specific user requested, or the public bucket requested.
  if (requested === '_open' || (!requested && !verified)) {
    // Public reads are allowed only when public favorites are enabled;
    // public *writes* additionally require administrator identity.
    return allowOpen && (!write || admin) ? '_open' : null
  }
  // Administrators may act on any named collection.
  if (admin && requested) return requested
  // A non-admin may only touch the collection that matches their own verified identity.
  if (requested && requested !== verified) return null
  return verified
}
