import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceDetail, evidenceOf, tCritical } from '../src/lib/evidence.ts'

const s = (avgR: number | null, seR: number | null, rTrades: number, rDays: number) => ({
  avgR,
  seR,
  rTrades,
  rDays,
})

test('an interval above zero with enough trades and days is an edge', () => {
  const e = evidenceOf(s(0.2, 0.05, 60, 10))
  assert.equal(e.verdict, 'edge')
  assert.ok(e.lo! > 0 && Math.abs(e.lo! - (0.2 - tCritical(9) * 0.05)) < 1e-12)
})

test('an interval below zero is losing, and one that spans zero is not proven', () => {
  assert.equal(evidenceOf(s(-0.2, 0.05, 60, 10)).verdict, 'negative')
  assert.equal(evidenceOf(s(0.1, 0.1, 60, 10)).verdict, 'unproven')
})

test('too few trades or too few closing days is never a verdict, however good the average looks', () => {
  assert.equal(evidenceOf(s(0.9, 0.01, 29, 10)).verdict, 'thin')
  assert.equal(evidenceOf(s(0.9, 0.01, 80, 4)).verdict, 'thin')
  assert.equal(evidenceOf(s(0.9, 0.01, 30, 5)).verdict, 'edge', 'the minimum is inclusive')
})

test('no clustered error means no interval, and no R means nothing to judge', () => {
  const one = evidenceOf(s(0.5, null, 40, 1))
  assert.equal(one.verdict, 'thin')
  assert.equal(one.lo, null)
  assert.equal(evidenceOf({ avgR: null, rTrades: 0 }).verdict, 'thin')
  assert.equal(evidenceOf({ avgR: 0.3, rTrades: 40 }).verdict, 'thin', 'a server that predates the field')
})

test('few days widen the interval: the t value, not 1.96', () => {
  assert.equal(tCritical(1), 12.706)
  assert.equal(tCritical(9), 2.262)
  assert.equal(tCritical(30), 2.042)
  assert.equal(tCritical(31), 2.042)
  assert.equal(tCritical(40), 2.042)
  assert.equal(tCritical(60), 2.022)
  assert.equal(tCritical(120), 2.001)
  assert.equal(tCritical(NaN), Infinity)
  assert.equal(tCritical(0), Infinity)
  // the same average and error is an edge over 40 days but not proven over 6
  assert.equal(evidenceOf(s(0.12, 0.05, 80, 40)).verdict, 'edge')
  assert.equal(evidenceOf(s(0.12, 0.05, 80, 6)).verdict, 'unproven')
})

test('the sentence names the average, the interval, the sample and the verdict', () => {
  const t = evidenceDetail(evidenceOf(s(0.1, 0.1, 60, 10)))
  assert.match(t, /\+0\.10R per trade from 60 trades on 10 closing days/)
  assert.match(t, /95% interval −?\+?[\d.−+]+R to/)
  assert.match(t, /includes zero/)
  assert.match(evidenceDetail(evidenceOf(s(0.5, 0.01, 10, 1))), /1 closing day\b/)
})

test('small-cluster correction keeps the five-day boundary sample unproven', () => {
  assert.equal(evidenceOf(s(0.9, Math.sqrt(0.125), 30, 5)).verdict, 'unproven')
  assert.equal(evidenceOf(s(0.9, Math.sqrt(0.125), 300, 5)).verdict, 'unproven')
  assert.equal(evidenceOf(s(NaN, 0.1, 30, 5)).verdict, 'thin')
  assert.equal(evidenceOf(s(0.9, -0.1, 30, 5)).verdict, 'thin')
})
