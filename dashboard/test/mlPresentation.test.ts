import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mlState, aucEvidence } from '../src/lib/mlPresentation.ts'

test('probability gate and scanner-score fallback are independent switches', () => {
  const advisory = mlState({ minProb: 0, useAsScore: false })
  assert.equal(advisory.label, 'Advisory only')
  assert.equal(advisory.gate, false)
  const score = mlState({ minProb: 0, useAsScore: true })
  assert.equal(score.label, 'Score only')
  assert.equal(score.gate, false)
  assert.match(score.detail, /only when the scanner has no score/)
  assert.equal(mlState({ minProb: .6, useAsScore: false }).label, 'Gate only')
  assert.equal(mlState({ minProb: .6, useAsScore: true }).label, 'Gate + score')
  assert.match(mlState({ minProb: .6, useAsScore: false }).detail, /60.0%/)
})

test('missing or invalid settings cannot be displayed as an off gate', () => {
  for (const config of [undefined, null, { minProb: NaN, useAsScore: false }]) {
    assert.equal(mlState(config).label, 'Unknown')
    assert.equal(mlState(config).gate, null)
  }
})

test('missing AUC is distinct from no separation and high AUC is not gate approval', () => {
  assert.match(aucEvidence(undefined), /No held-out/)
  assert.match(aucEvidence(NaN), /No held-out/)
  assert.match(aucEvidence(.5), /No positive ranking separation/)
  assert.match(aucEvidence(.8), /does not establish a profitable gate/)
})
