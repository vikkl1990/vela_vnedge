import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_GROUPS, ASSET_SECTORS, baseAsset, classifySymbol, matchesClass } from '../../shared/assetClass.ts';

const c = (symbol: string, tags: string[] = [], topTag: string | null = null) => classifySymbol(symbol, { tags, topTag });

test('base asset strips the quote and the contract multiplier', () => {
  assert.equal(baseAsset('BTCUSD'), 'BTC');
  assert.equal(baseAsset('1000PEPEUSD'), 'PEPE');
  assert.equal(baseAsset('1MBABYDOGEUSD'), 'BABYDOGE');
  assert.equal(baseAsset('BNBUSD'), 'BNB');
  assert.equal(baseAsset('ETHUSDT'), 'ETH');
});

test('the four majors are Majors whatever Delta tags them', () => {
  assert.deepEqual(c('BTCUSD', ['layer_1']), { group: 'majors', sector: 'store_of_value', tags: ['store_of_value'] });
  assert.equal(c('ETHUSD', ['smart_contracts', 'layer_1']).group, 'majors');
  assert.equal(c('SOLUSD', ['smart_contracts', 'layer_1', 'sol_ecosystem']).group, 'majors');
  assert.deepEqual(c('XRPUSD'), { group: 'majors', sector: 'payments', tags: ['payments'] });
});

test('meme coins come from the tag, and from the name when tags are not loaded', () => {
  assert.equal(c('1000PEPEUSD', ['meme']).group, 'meme');
  assert.equal(c('DOGEUSD', ['meme']).sector, 'meme');
  assert.equal(classifySymbol('DOGEUSD').group, 'meme');
  assert.equal(classifySymbol('1MBABYDOGEUSD').group, 'meme');
  // an AI meme coin is a meme coin first and still found under AI
  const g = c('GRIFFAINUSD', ['ai', 'meme']);
  assert.equal(g.group, 'meme');
  assert.deepEqual(g.tags.sort(), ['ai', 'meme']);
  assert.ok(matchesClass(g, 'meme', null));
  assert.ok(matchesClass(g, null, 'ai'));
  assert.ok(!matchesClass(g, 'alts', null));
});

test('large-cap alts are split from the rest of the alts, and a sector is read from the tags', () => {
  assert.deepEqual(c('BNBUSD', ['smart_contracts', 'layer_1']), { group: 'large_alts', sector: 'layer_1', tags: ['layer_1'] });
  assert.equal(c('LINKUSD', ['smart_contracts', 'defi']).group, 'large_alts');
  assert.equal(c('LINKUSD', ['smart_contracts', 'defi']).sector, 'defi');
  assert.deepEqual(c('AKEUSD', ['ai']), { group: 'alts', sector: 'ai', tags: ['ai'] });
  assert.equal(c('ARIAUSD', ['gaming']).sector, 'gaming');
  assert.equal(c('EVAAUSD', ['defi']).sector, 'defi');
  assert.equal(c('INITUSD', ['smart_contracts', 'layer_1']).sector, 'layer_1');
  assert.equal(c('STRKUSD', ['smart_contracts', 'layer_2']).sector, 'layer_2');
  // untagged crypto is still an alt, never "other"
  assert.deepEqual(c('TIAUSD'), { group: 'alts', sector: 'other', tags: ['other'] });
});

test('stocks, metals and oil are their own group', () => {
  assert.deepEqual(c('AAPLBUSD', ['xStock'], 'tradfi'), { group: 'tradfi', sector: 'stocks', tags: ['stocks'] });
  assert.equal(c('PAXGUSD', ['metal'], 'tradfi').sector, 'metals');
  assert.equal(c('OILUSD', [], 'tradfi').sector, 'energy');
  assert.equal(classifySymbol('XAUTUSD').sector, 'metals');
  assert.equal(classifySymbol('OILUSD').sector, 'energy');
  assert.equal(classifySymbol('AAPLBUSD').group, 'tradfi');
  // BNB ends in B before USD but is a crypto coin
  assert.equal(classifySymbol('BNBUSD').group, 'large_alts');
});

test('anything that is not a USD perpetual symbol is Other', () => {
  assert.deepEqual(classifySymbol('FOO'), { group: 'other', sector: 'other', tags: [] });
  assert.equal(classifySymbol('').group, 'other');
});

test('group and sector filters', () => {
  const x = c('AKEUSD', ['ai']);
  assert.ok(matchesClass(x, undefined, undefined));
  assert.ok(matchesClass(x, 'alts', 'ai'));
  assert.ok(!matchesClass(x, 'majors', null));
  assert.ok(!matchesClass(x, null, 'defi'));
});

test('every group and sector a classification can return is declared', () => {
  const groups = new Set(ASSET_GROUPS.map(g => g.key)), sectors = new Set(ASSET_SECTORS.map(s => s.key));
  for (const [s, tags] of [['BTCUSD', []], ['DOGEUSD', ['meme']], ['BNBUSD', ['layer_1']], ['AKEUSD', ['ai']], ['PAXGUSD', ['metal']], ['FOO', []], ['TIAUSD', []]] as const) {
    const r = c(s, [...tags]);
    assert.ok(groups.has(r.group), r.group);
    assert.ok(sectors.has(r.sector), r.sector);
    for (const t of r.tags) assert.ok(sectors.has(t), t);
  }
});
