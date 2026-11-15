import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ambiguousScannerNames } from '../src/lib/scannerNames.ts'
test('same-name scanner identities remain distinguishable without merging their cells or evidence', () => {
  assert.deepEqual(
    [
      ...ambiguousScannerNames([
        { id: 'a', name: 'Same' },
        { id: 'a', name: 'Same' },
        { id: 'b', name: 'Same' },
        { id: 'c', name: 'Unique' },
        { id: 'c', name: 'Unique' },
      ]),
    ],
    ['Same'],
  )
})
