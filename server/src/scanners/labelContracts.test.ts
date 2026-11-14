import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractEvents} from './extractor.ts';
import {labelStyleContractError,type LabelStyleSides} from './readerFixes.ts';
import {readingOf} from './reading.ts';
import {strategyIdentity} from './identity.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {planSnapshot,validateExecutionPlans} from '../paper/executionPlans.ts';

const styles:LabelStyleSides={'⯁':{style_label_up:'long',style_label_down:'short'}};
test('same-glyph contracts preserve both sides, creation times, exclusions and unknown-style refusal',()=>{
 const options={scannerId:'zone-shift-author-retests',reader:2,sources:['label'] as const,labelStyles:styles,
  drawn:['style_label_up','style_label_down','label_center',undefined].map((style,i)=>({text:'⯁',style,y:100,time:(i+1)*900000,createdAt:(i+2)*900000}))};
 const run=(over:object={})=>extractEvents([],[],{...options,sources:[...options.sources],...over});
 assert.deepEqual(run().map(e=>[e.side,e.barTime]),[['long',1800000],['short',2700000]]);
 assert.equal(run({reader:1}).length,0,'no global glyph vocabulary change');
 assert.equal(run({sides:{'⯁':'none'}}).length,0,'an explicit non-entry contract wins');
 assert.equal(run({sources:[]}).length,0);
 assert.equal(run({sinceBarTime:3600000}).length,0);
 assert.equal(run({drawn:[{text:'⯁',style:'style_label_up',y:100,time:900000}]}).length,0,'creation time cannot be invented');
});

test('style readings travel through source/plan identities without changing unrelated readings',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG),id='zone-shift-author-retests';
 cfg.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'levels',reader:2,sources:['label']};
 const before=strategyIdentity('source',cfg,id),other=strategyIdentity('source',cfg,'untouched');
 const read=readingOf(cfg.scanners[id],id,900000);
 cfg.scanners[id].labelStyles=styles;
 assert.equal(read.extract.labelStyles,undefined);
 assert.deepEqual(readingOf(cfg.scanners[id],id,900000).extract.labelStyles,styles);
 assert.notEqual(strategyIdentity('source',cfg,id),before);
 assert.equal(strategyIdentity('source',cfg,'untouched'),other);
 assert.equal(validateConfig(cfg).filter(e=>e.includes(id)).length,0);
 const p={id:'style-study',revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000,readingOverride:{version:1,reader:2 as const,labelStyles:styles}};
 assert.deepEqual(validateExecutionPlans([p],{'15m':900}),[]);
 const snapshot=planSnapshot(cfg,p,'source');
 assert.deepEqual(snapshot.reading?.labelStyles,styles);
 p.readingOverride.labelStyles={'⯁':{style_label_up:'short',style_label_down:'long'}};
 assert.notEqual(planSnapshot(cfg,p,'source').signature,snapshot.signature);
 assert.deepEqual(snapshot.reading?.labelStyles,styles,'old snapshots are not mutated');
});

test('style contract validation rejects malformed or ambiguous mappings',()=>{
 assert.equal(labelStyleContractError(2,styles),null);
 for(const bad of [[],true,{'⯁':'long'},{'⯁':{style_label_up:['long']}},{'⯁':{style_label_up:null}},{'⯁':{style_label_up:'buy'}},{'⯁':{'':'long'}},{'A':{style_label_up:'long'},' a ':{style_label_up:'short'}}])assert.ok(labelStyleContractError(2,bad));
 assert.ok(labelStyleContractError(1,styles));assert.ok(labelStyleContractError(3,styles));
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners.x={enabled:false,symbols:null,timeframes:null,exitMode:'levels',reader:1,labelStyles:styles};
 assert.ok(validateConfig(cfg).some(e=>e.includes('labelStyles requires reader 2')));
});
