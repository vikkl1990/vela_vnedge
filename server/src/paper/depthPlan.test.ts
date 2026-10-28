import{test}from'node:test';import assert from'node:assert/strict';import{depthPlan}from'./depthPlan.ts';
test('depth risk sizing reduces quantity and prices the final quantity, with no best-quote subsidy',()=>{
 const qs:number[]=[];
 const r=depthPlan({qty:10,riskAmount:20,leverage:2},100,'long',q=>{qs.push(q);return {price:q>8?102:101};},p=>({qty:p===102?8:9,riskAmount:p===102?24:27,leverage:3}));
 assert.ok('size'in r);assert.deepEqual(qs,[10,8]);assert.equal(r.price,101);assert.equal(r.size.qty,8);assert.equal(r.size.riskAmount,24);
 const short=depthPlan({qty:2,riskAmount:4,leverage:1},100,'short',()=>({price:101}),()=>({qty:2,riskAmount:4,leverage:1}));assert.ok('price'in short);assert.equal(short.price,100);
});
test('missing depth and untradeable risk cannot become invented fills',()=>{
 assert.ok('reject'in depthPlan({qty:2,riskAmount:4,leverage:1},100,'long',()=>({reject:'missing'}),()=>({qty:2,riskAmount:4,leverage:1})));
 assert.ok('reject'in depthPlan({qty:2,riskAmount:4,leverage:1},100,'long',()=>({price:102}),()=>({qty:0,riskAmount:0,leverage:0})));
});
