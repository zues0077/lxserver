import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCollectionUser } from '../src/server/collectionAccess'

// Back-ported security regression from upstream XCQ0607/lxserver PR #457 (v2.1.4).
// Verifies an unverified / mismatched display name can NEVER resolve to another
// user's private collection (was an IDOR / auth-bypass before the fix).

// Private collections require verified ownership or explicit administrator authorization.
for (const write of [false, true]) {
  // attacker with no token, naming a victim -> rejected
  assert.equal(resolveCollectionUser('victim', null, false, true, write), null)
  // attacker verified as someone else, naming a victim -> rejected
  assert.equal(resolveCollectionUser('victim', 'other', false, true, write), null)
  // own name + own verified identity -> allowed
  assert.equal(resolveCollectionUser('victim', 'victim', false, false, write), 'victim')
  // empty requested falls back to verified identity
  assert.equal(resolveCollectionUser('', 'victim', false, false, write), 'victim')
  // admin may act on any named collection
  assert.equal(resolveCollectionUser('victim', null, true, false, write), 'victim')
}

// Public collection reads follow configuration; writes require administrator authorization.
assert.equal(resolveCollectionUser('_open', null, false, true, false), '_open')
// public write by non-admin is rejected even when public favorites are open
assert.equal(resolveCollectionUser('_open', 'user', false, true, true), null)
// no requested and no verified -> rejected when public favorites disabled
assert.equal(resolveCollectionUser('', null, false, false, false), null)
// admin without open permission cannot force _open
assert.equal(resolveCollectionUser('_open', null, true, false, false), null)
// admin may write public bucket when open
assert.equal(resolveCollectionUser('_open', null, true, true, true), '_open')
// empty requested + write without open permission -> rejected
assert.equal(resolveCollectionUser('', null, false, true, true), null)
