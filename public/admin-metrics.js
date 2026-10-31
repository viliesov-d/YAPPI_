/* Pure team/employee metrics; no network access and no changes to stored Firebase data. */
(function (root, factory) {
  const instance = factory(typeof module !== 'undefined' && module.exports ? require('./logic.js') : root.SalaryLogic);
  if (typeof module !== 'undefined' && module.exports) module.exports = instance;
  root.ZminaAdminMetrics = instance;
})(typeof window !== 'undefined' ? window : globalThis, function (L) {
  'use strict';
  function employee(state, year, month) {
    if (!state) return null;
    const monthStats = L.monthStats(state, year, month);
    const plan = L.monthPlan(state, year, month);
    const ledger = L.monthLedger(state, year, month);
    const daily = [];
    for (let day = 1; day <= L.daysInMonth(year, month); day++) {
      const date = L.iso(year, month, day);
      daily.push({ day, date, cash: L.dayCash(date, state), wage: L.dayAmount(date, state) });
    }
    return { wage:monthStats.total, cash:plan.actual, target:plan.target,
      percent:plan.target ? plan.percent : null, achieved:plan.achieved, bonus:plan.bonus,
      recorded:monthStats.recorded, working:monthStats.working, replacement:monthStats.replacements,
      unpaid:monthStats.unpaid, ledger, daily };
  }
  function team(items, year, month) {
    const daily = Array.from({length:L.daysInMonth(year,month)},(_,idx) => ({day:idx + 1,cash:0,wage:0}));
    const result = {wage:0,cash:0,bonus:0,achieved:0,withTarget:0,loaded:0,missing:0,daily,ranking:[]};
    for (const item of items) {
      if (item.error) { result.missing++; continue; }
      result.loaded++;
      const m = item.metrics;
      if (!m) continue;
      result.wage += m.wage; result.cash += m.cash; result.bonus += m.bonus;
      if (m.target) result.withTarget++;
      if (m.achieved) result.achieved++;
      for (let i=0;i<daily.length;i++) {
        daily[i].cash += m.daily[i].cash;
        daily[i].wage += m.daily[i].wage;
      }
      result.ranking.push(item);
    }
    result.ranking.sort((a,b)=>(b.metrics?.cash||0)-(a.metrics?.cash||0));
    return result;
  }
  return {employee,team};
});
