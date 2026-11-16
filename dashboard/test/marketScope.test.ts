import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SCOPE_KEY,
  effectiveGroup,
  parseScope,
  readScope,
  scopeLabel,
  writeScope,
} from '../src/lib/marketScope.ts'

const fakeStore = (initial: Record<string, string> = {}) => {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  }
}

test('only a known asset class is a scope; anything else means every market', () => {
  assert.equal(parseScope('meme'), 'meme')
  assert.equal(parseScope('majors'), 'majors')
  for (const bad of ['', 'all', 'bluechip', 'MEME', null, undefined]) assert.equal(parseScope(bad), '')
})

test('a stored value that is stale or edited can never hide every market', () => {
  assert.equal(readScope(fakeStore({ [SCOPE_KEY]: 'defunct_class' })), '')
  assert.equal(readScope(fakeStore({ [SCOPE_KEY]: 'tradfi' })), 'tradfi')
  assert.equal(readScope(null), '')
})

test('writing a scope stores it, and clearing it removes the key', () => {
  const s = fakeStore()
  writeScope('alts', s)
  assert.equal(s.m.get(SCOPE_KEY), 'alts')
  writeScope('', s)
  assert.equal(s.m.has(SCOPE_KEY), false)
})

test('blocked storage does not throw', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  assert.equal(readScope(broken), '')
  assert.doesNotThrow(() => writeScope('meme', broken))
})

test('a page choice beats the scope, "all" is a choice, and only the scope can narrow silently', () => {
  assert.deepEqual(effectiveGroup(null, 'meme'), { group: 'meme', fromScope: true })
  assert.deepEqual(effectiveGroup(null, ''), { group: '', fromScope: false })
  assert.deepEqual(effectiveGroup('majors', 'meme'), { group: 'majors', fromScope: false })
  assert.deepEqual(effectiveGroup('all', 'meme'), { group: '', fromScope: false })
  assert.deepEqual(
    effectiveGroup('junk', 'meme'),
    { group: '', fromScope: false },
    'junk in the URL is not the scope',
  )
})

test('labels name the class, or all markets', () => {
  assert.equal(scopeLabel(''), 'All markets')
  assert.equal(scopeLabel('meme'), 'Meme')
})
