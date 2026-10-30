const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/logic.js');
const L = globalThis.SalaryLogic;
const state = () => ({version:2,anchorDate:'2026-10-01',anchorPosition:1,days:{},cash:{},plans:{}});
test('4/2 shift cycle continues across months', () => {
  const s=state();
  for(let i=0;i<12;i++){
    const date = new Date(Date.UTC(2026, 9, 1+i));
    const id=L.iso(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate());
    assert.equal(L.isScheduledWork(id,s.anchorDate,s.anchorPosition),i%6<4);
  }
});
test('monthly plan progress follows cash only and gives exactly one bonus at 100%',()=>{
 const s=state(); s.plans['2026-10']=3000000;
 s.cash['2026-10-01']=2999999;
 s.days['2026-10-01']={amount:5000000};
 assert.equal(L.monthPlan(s,2026,10).achieved,false);
 assert.equal(L.monthPlan(s,2026,10).bonus,0);
 s.cash['2026-10-01']=3000000;
 assert.equal(L.monthPlan(s,2026,10).percent,100);
 assert.equal(L.monthPlan(s,2026,10).bonus,200000);
 s.cash['2026-10-02']=1000000;
 assert.equal(L.monthPlan(s,2026,10).bonus,200000);
 assert.equal(L.bonusPayday('2026-11-15',s).amount,200000);
 assert.equal(L.bonusPayday('2026-10-15',s),null);
});
test('salary dates respect halves and December-to-January year boundary',()=>{
 const s=state();s.days['2026-12-10']={override:'replacement',amount:100000};
 s.days['2026-12-20']={override:'replacement',amount:200000};
 assert.equal(L.payday('2026-12-25',s).amount,100000);
 assert.equal(L.payday('2027-01-10',s).amount,200000);
 assert.equal(L.payday('2026-12-10',s).amount,0);
});
test('cash and wages of unpaid shifts retained but excluded',()=>{
 const s=state();s.cash['2026-10-01']=100000;s.days['2026-10-01']={override:'unpaid',amount:60000};
 assert.equal(L.monthCashTotal(s,2026,10),0);
 assert.equal(L.dayAmount('2026-10-01',s),0);
 assert.equal(L.monthLedger(s,2026,10)[0].ignoredCash,true);
});
