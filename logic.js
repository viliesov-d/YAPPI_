/* Pure date and salary helpers. All financial values are stored as integer kopiykas. */
(function (root, factory) {
  const logic = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  root.SalaryLogic = logic;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const integerFormatter = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
  const dateFormatter = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  function iso(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function dateParts(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day };
  }
  function utcDay(value) {
    const p = dateParts(value);
    return p ? Date.UTC(p.year, p.month - 1, p.day) / DAY_MS : NaN;
  }
  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  function shiftMonth(year, month, offset) {
    const d = new Date(Date.UTC(year, month - 1 + offset, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  function mod(n, m) { return ((n % m) + m) % m; }
  function isScheduledWork(date, anchorDate, anchorPosition) {
    return mod(utcDay(date) - utcDay(anchorDate) + anchorPosition - 1, 6) < 4;
  }
  function dayType(date, state) {
    const entry = state.days[date];
    if (entry?.override === 'unpaid') return 'unpaid';
    if (entry?.override === 'replacement') return 'replacement';
    return isScheduledWork(date, state.anchorDate, state.anchorPosition) ? 'work' : 'off';
  }
  function isWorking(type) { return type === 'work' || type === 'replacement'; }
  function dayAmount(date, state) {
    if (!isWorking(dayType(date, state))) return 0;
    const amount = state.days[date]?.amount;
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
  }
  function periodTotal(state, year, month, startDay, endDay) {
    let result = 0;
    const max = Math.min(endDay, daysInMonth(year, month));
    for (let day = startDay; day <= max; day++) result += dayAmount(iso(year, month, day), state);
    return result;
  }
  function monthStats(state, year, month) {
    let recorded = 0, working = 0, replacements = 0, unpaid = 0;
    const last = daysInMonth(year, month);
    for (let d = 1; d <= last; d++) {
      const date = iso(year, month, d), type = dayType(date, state);
      if (isWorking(type)) {
        working++;
        if (Object.prototype.hasOwnProperty.call(state.days[date] || {}, 'amount')) recorded++;
        if (type === 'replacement') replacements++;
      }
      if (type === 'unpaid') unpaid++;
    }
    const firstHalf = periodTotal(state, year, month, 1, 15);
    const secondHalf = periodTotal(state, year, month, 16, last);
    return { total: firstHalf + secondHalf, firstHalf, secondHalf, recorded, working, replacements, unpaid };
  }
  function payday(date, state) {
    const p = dateParts(date);
    if (!p || (p.day !== 10 && p.day !== 25)) return null;
    if (p.day === 25) return {
      kind: 25, period: `${iso(p.year, p.month, 1)} — ${iso(p.year, p.month, 15)}`,
      amount: periodTotal(state, p.year, p.month, 1, 15)
    };
    const prev = shiftMonth(p.year, p.month, -1);
    return {
      kind: 10, period: `${iso(prev.year, prev.month, 16)} — ${iso(prev.year, prev.month, daysInMonth(prev.year, prev.month))}`,
      amount: periodTotal(state, prev.year, prev.month, 16, daysInMonth(prev.year, prev.month))
    };
  }
  // Cash register sales are stored independently of wages in state.cash.
  // A past cash entry is preserved if its shift becomes unpaid/off, but only active shifts count toward the plan.
  function dayCash(date, state) {
    if (!isWorking(dayType(date, state))) return 0;
    const cash = state.cash?.[date];
    return Number.isSafeInteger(cash) && cash >= 0 ? cash : 0;
  }
  function monthCashTotal(state, year, month) {
    let sum = 0;
    for (let day = 1; day <= daysInMonth(year, month); day++) sum += dayCash(iso(year, month, day), state);
    return sum;
  }
  function monthLedger(state, year, month) {
    const rows = [];
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      const date = iso(year, month, day);
      const type = dayType(date, state);
      const cashRecorded = Object.prototype.hasOwnProperty.call(state.cash || {}, date);
      const wageRecorded = Object.prototype.hasOwnProperty.call(state.days[date] || {}, 'amount');
      // Include scheduled/extra shifts, unpaid dates, and any date with a saved entry.
      if (!isWorking(type) && type !== 'unpaid' && !cashRecorded && !wageRecorded) continue;
      rows.push({ date, type,
        cash: cashRecorded ? state.cash[date] : 0,
        wage: wageRecorded ? state.days[date].amount : 0,
        cashRecorded, wageRecorded,
        ignoredCash: cashRecorded && !isWorking(type),
        ignoredWage: wageRecorded && !isWorking(type) });
    }
    return rows;
  }
  const PLAN_BONUS_CENTS = 200000;
  function monthPlan(state, year, month) {
    const key = iso(year, month, 1).slice(0, 7);
    const target = state.plans?.[key];
    const validTarget = Number.isSafeInteger(target) && target > 0 ? target : 0;
    const actual = monthCashTotal(state, year, month);
    const achieved = validTarget > 0 && actual >= validTarget;
    return {
      key, target: validTarget, actual,
      percent: validTarget ? actual / validTarget * 100 : 0,
      remaining: validTarget ? Math.max(0, validTarget - actual) : 0,
      achieved,
      bonus: achieved ? PLAN_BONUS_CENTS : 0
    };
  }
  function bonusPayday(date, state) {
    const p = dateParts(date);
    if (!p || p.day !== 15) return null;
    const previous = shiftMonth(p.year, p.month, -1);
    const plan = monthPlan(state, previous.year, previous.month);
    return plan.achieved ? { kind: 15, amount: PLAN_BONUS_CENTS, forMonth: plan.key } : null;
  }
  function formatMoney(cents) {
    const whole = Math.floor(cents / 100);
    const rest = cents % 100;
    return `${integerFormatter.format(whole)}${rest ? ',' + String(rest).padStart(2, '0') : ''} ₴`;
  }
  function formatCompact(cents) {
    const amount = cents / 100;
    if (amount >= 1000000) return `${String((amount / 1000000).toFixed(1)).replace('.', ',')}м`;
    if (amount >= 1000) return `${String((amount / 1000).toFixed(1)).replace('.', ',')}к`;
    return `${Math.floor(amount)}${cents % 100 ? ',' + String(cents % 100).padStart(2, '0') : ''}`;
  }
  function formatDate(date) {
    const p = dateParts(date);
    return p ? dateFormatter.format(new Date(Date.UTC(p.year, p.month - 1, p.day))) : '';
  }
  function parseMoney(value) {
    const normalized = String(value).trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
    if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null;
    const [whole, cents = ''] = normalized.split('.');
    return Number(whole) * 100 + Number((cents + '00').slice(0, 2));
  }
  return { iso, dateParts, utcDay, daysInMonth, shiftMonth, isScheduledWork, dayType, isWorking,
    dayAmount, dayCash, monthCashTotal, monthLedger, periodTotal, monthStats, payday, monthPlan, bonusPayday, PLAN_BONUS_CENTS,
    formatMoney, formatCompact, formatDate, parseMoney };
});
