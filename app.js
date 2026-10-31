/* Salary calendar 4/2 — Firebase cloud edition, keeping all original salary logic. */
(() => {
  'use strict';

  const L = window.SalaryLogic;
  const STORAGE_KEY = 'zminaSalaryCalendarV1';
  const USER_CACHE_PREFIX = 'zminaFirebaseCacheV1:';
  let activeUid = null;
  let cacheSerial = 0;
  let initialized = false;
  const today = new Date();
  const todayISO = L.iso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const monthFormatter = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortDayFormatter = new Intl.DateTimeFormat('uk-UA', { weekday: 'long', timeZone: 'UTC' });
  const el = (id) => document.getElementById(id);
  const view = { year: today.getFullYear(), month: today.getMonth() + 1 };
  let state = { version: 2, anchorDate: todayISO, anchorPosition: 1, days: {}, plans: {}, cash: {} };
  let editingDate = null;
  let selectedCashDate = null;
  let toastTimer = null;
  let storageOK = true;

  function validEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const entry = {};
    if (raw.override === 'replacement' || raw.override === 'unpaid') entry.override = raw.override;
    if (Number.isSafeInteger(raw.amount) && raw.amount >= 0 && raw.amount <= 99999999999) entry.amount = raw.amount;
    if (typeof raw.note === 'string' && raw.note.trim()) entry.note = raw.note.slice(0, 250);
    return entry;
  }
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Невірний формат');
    if (!L.dateParts(raw.anchorDate) || !Number.isInteger(raw.anchorPosition) || raw.anchorPosition < 1 || raw.anchorPosition > 6) {
      throw new Error('Невірні параметри графіка');
    }
    if (!raw.days || typeof raw.days !== 'object' || Array.isArray(raw.days)) throw new Error('Не знайдено днів');
    const entries = Object.entries(raw.days);
    if (entries.length > 10000) throw new Error('Занадто багато записів');
    const days = {};
    for (const [date, rawEntry] of entries) {
      if (!L.dateParts(date) || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error('Некоректний запис дня');
      }
      if (rawEntry.override != null && !['unpaid', 'replacement'].includes(rawEntry.override)) throw new Error('Некоректний статус дня');
      if (rawEntry.amount != null && (!Number.isSafeInteger(rawEntry.amount) || rawEntry.amount < 0 || rawEntry.amount > 99999999999)) {
        throw new Error('Некоректна сума');
      }
      days[date] = validEntry(rawEntry);
    }
    // Keep older backups compatible: the `plans` field did not exist before this update.
    const rawPlans = raw.plans ?? {};
    if (!rawPlans || typeof rawPlans !== 'object' || Array.isArray(rawPlans)) throw new Error('Некоректні плани');
    const planEntries = Object.entries(rawPlans);
    if (planEntries.length > 2400) throw new Error('Занадто багато планів');
    const plans = {};
    for (const [month, cents] of planEntries) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900 || Number(month.slice(0, 4)) > 2100 ||
          !Number.isSafeInteger(cents) || cents <= 0 || cents > 99999999999) {
        throw new Error('Некоректна сума або місяць плану');
      }
      plans[month] = cents;
    }
    // Backward compatible with backups made before the cash journal existed.
    const rawCash = raw.cash ?? {};
    if (!rawCash || typeof rawCash !== 'object' || Array.isArray(rawCash)) throw new Error('Некоректні дані каси');
    if (Object.keys(rawCash).length > 10000) throw new Error('Забагато записів каси');
    const cash = {};
    for (const [date, cents] of Object.entries(rawCash)) {
      if (!L.dateParts(date) || !Number.isSafeInteger(cents) || cents < 0 || cents > 99999999999) {
        throw new Error('Некоректна дата або сума каси');
      }
      cash[date] = cents;
    }
    return { version: 2, anchorDate: raw.anchorDate, anchorPosition: raw.anchorPosition, days, plans, cash };
  }
  function pendingCache(uid) {
    try {
      const raw = localStorage.getItem(USER_CACHE_PREFIX + uid);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function writeCache(pending) {
    if (!activeUid) return;
    const saved = { data: state, pending, serial: ++cacheSerial, savedAt: Date.now() };
    try { localStorage.setItem(USER_CACHE_PREFIX + activeUid, JSON.stringify(saved)); storageOK = true; }
    catch (error) { storageOK = false; console.warn('Local backup unavailable', error); }
  }
  function setIndicator(text, warning = false) {
    const status = el('save-status');
    status.classList.toggle('warning', warning);
    status.replaceChildren();
    const dot = document.createElement('span'); dot.className = 'status-dot';
    status.append(dot, ' ' + text);
    status.title = text;
  }
  function saveLocal() {
    if (!initialized || !activeUid || !window.ZminaCloud) return;
    writeCache(true);
    const serial = cacheSerial;
    setIndicator(navigator.onLine ? 'Синхронізація з Firebase…' : 'Офлайн · Збережено на пристрої');
    window.ZminaCloud.save(state).then(() => {
      // Do not clear pending status for any newer local edit.
      if (serial !== cacheSerial) return;
      writeCache(false);
      setIndicator('Збережено у Firebase');
    }).catch(error => {
      storageOK = false;
      setIndicator('Не вдалося зберегти в хмару', true);
      showToast('Помилка Firebase. Локальна копія збережена. ' + error.message);
    });
  }
  function handleInitialCloud({ uid, data, fromCache = false, hasPendingWrites = false }) {
    activeUid = uid;
    let cloudData = null;
    if (data) {
      try { cloudData = normalize(data); }
      catch (error) { setIndicator('Некоректні дані Firebase', true); showToast('Дані Firebase пошкоджені: ' + error.message); return; }
    }
    const ownCache = pendingCache(uid);
    let pendingData = null;
    if (ownCache?.pending) {
      try { pendingData = normalize(ownCache.data); } catch { /* ignore invalid cache */ }
    }
    let upload = false;
    let discardedLocal = false;
    if (pendingData) {
      // A queued Firestore write already appears in its own IndexedDB snapshot: don't duplicate it.
      if (hasPendingWrites) {
        state = pendingData;
        // The last localStorage edit may be newer than the last IndexedDB write (abrupt close).
        // Queue that complete snapshot again if needed; do not lose unsynced later edits.
        if (!cloudData || JSON.stringify(cloudData) !== JSON.stringify(pendingData)) upload = true;
      }
      else if (fromCache || !cloudData || window.confirm('На цьому пристрої є зміни, що не синхронізувалися. Завантажити їх у Firebase замість хмарних даних?')) {
        state = pendingData; upload = true;
      } else {
        // User selected the cloud version; do not leave a stale pending backup behind.
        state = cloudData; discardedLocal = true;
      }
    }
    if (!upload && !pendingData && cloudData) state = cloudData;
    if (!upload && !cloudData && ownCache?.data) {
      try { state = normalize(ownCache.data); } catch { /* ignore invalid local backup */ }
    }
    if (!upload && !cloudData && !fromCache) {
      // Migration of the previous non-account local version, only when cloud is empty.
      let previous = null;
      try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) previous = normalize(JSON.parse(raw)); } catch { /* ignore */ }
      if (previous && window.confirm('Знайдені записи попередньої локальної версії. Перенести їх у ваш Firebase-акаунт?')) state = previous;
      upload = true;
    }
    initialized = true;
    document.body.classList.remove('cloud-locked');
    el('cloud-gate').hidden = true;
    render();
    if (upload) saveLocal();
    else if (hasPendingWrites || (pendingData && !discardedLocal)) {
      writeCache(true);
      setIndicator('Офлайн-зміни очікують синхронізації');
    } else {
      writeCache(false);
      setIndicator(fromCache ? 'Локальні дані · Перевіряємо Firebase' : 'Збережено у Firebase');
    }
  }
  window.addEventListener('zmina-cloud-profile', ({ detail }) => {
    el('account-name').textContent = detail.displayName || detail.email || 'Профіль';
    el('account-name').title = detail.email || '';
    el('admin-link').hidden = !detail.admin;
  });
  window.addEventListener('zmina-cloud-initial', ({ detail }) => handleInitialCloud(detail));
  window.addEventListener('zmina-cloud-confirmed', ({ detail }) => {
    if (!initialized || detail.uid !== activeUid || window.ZminaCloud?.hasPendingWrites) return;
    const backup = pendingCache(activeUid);
    if (!backup?.pending) return;
    try {
      const server = normalize(detail.data);
      const local = normalize(backup.data);
      if (JSON.stringify(server) === JSON.stringify(local)) {
        // Firestore committed a write queued before this browser session started.
        state = server;
        writeCache(false);
        render();
        setIndicator('Офлайн-зміни синхронізовані з Firebase');
      } else {
        // Do not silently overwrite either a device's offline changes or newer cloud data.
        const restore = window.confirm('Локальні офлайн-зміни відрізняються від даних у Firebase. Замінити хмарну версію локальною? Натисніть «Скасувати», щоб використати хмарну версію. Перед вибором бажано експортувати JSON-копію.');
        if (restore) { state = local; saveLocal(); }
        else { state = server; writeCache(false); render(); setIndicator('Завантажено дані з Firebase'); }
      }
    } catch (error) { console.warn('Помилка перевірки офлайн-змін:', error); }
  });
  window.addEventListener('zmina-cloud-remote', ({ detail }) => {
    if (!initialized || detail.uid !== activeUid || pendingCache(activeUid)?.pending) return;
    try { state = normalize(detail.data); writeCache(false); render(); setIndicator('Оновлено з Firebase'); }
    catch (error) { setIndicator('Некоректне оновлення Firebase', true); console.warn(error); }
  });
  window.addEventListener('zmina-cloud-error', ({ detail }) => {
    setIndicator('Помилка з’єднання з Firebase', true);
    console.warn(detail.error);
  });
  window.addEventListener('zmina-cloud-status', ({ detail }) => {
    if (!initialized) return;
    setIndicator(detail.message, detail.status === 'error');
  });

  function showToast(message) {
    const toast = el('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
  }
  function monthName(year, month) {
    const s = monthFormatter.format(new Date(Date.UTC(year, month - 1, 1))).replace(/\s*р\.$/, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function renderOverview() {
    const stats = L.monthStats(state, view.year, view.month);
    el('overview-period').textContent = monthName(view.year, view.month);
    el('stat-total').textContent = L.formatMoney(stats.total);
    el('stat-first').textContent = L.formatMoney(stats.firstHalf);
    el('stat-second').textContent = L.formatMoney(stats.secondHalf);
    el('stat-shifts').textContent = `${stats.recorded} / ${stats.working}`;
    el('shifts-caption').textContent = `Заміни: ${stats.replacements} · За свій рахунок: ${stats.unpaid}`;
  }
  const percentFormatter = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
  function renderPlan() {
    const progress = L.monthPlan(state, view.year, view.month);
    const next = L.shiftMonth(view.year, view.month, 1);
    const date = L.iso(next.year, next.month, 15);
    el('plan-period').textContent = monthName(view.year, view.month);
    el('plan-input-label').textContent = `План продажів на ${monthName(view.year, view.month).toLowerCase()}, ₴`;
    el('plan-amount').value = progress.target ? String(progress.target / 100).replace('.', ',') : '';
    el('plan-error').hidden = true;
    el('plan-earned').textContent = L.formatMoney(progress.actual);
    el('plan-remaining').textContent = progress.target ? L.formatMoney(progress.remaining) : '—';
    const shownPercent = progress.achieved ? Math.round(progress.percent * 10) / 10 : Math.floor(progress.percent * 10) / 10;
    el('plan-percent').textContent = `${percentFormatter.format(shownPercent)}%`;
    el('plan-progress-fill').style.width = `${Math.min(100, progress.percent)}%`;
    el('plan-progress').setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, shownPercent))));
    el('plan-reward-card').classList.toggle('earned', progress.achieved);
    el('plan-reward-date').textContent = L.formatDate(date);
    el('plan-reward-status').textContent = progress.achieved ? '✓ Премію нараховано' : (progress.target ? 'Поки що не нараховано' : 'Спершу вкажіть план');
    const message = el('plan-message');
    message.classList.toggle('success', progress.achieved);
    message.textContent = progress.achieved
      ? 'План продажів виконано! Премія 2 000 ₴ — 15-го наступного місяця.'
      : progress.target ? `До виконання плану продажів залишилося каси на ${L.formatMoney(progress.remaining)}.`
        : 'Вкажіть план продажів і заносьте касу за зміни, щоб бачити прогрес.';
  }
  function savePlan(event) {
    event.preventDefault();
    const key = L.iso(view.year, view.month, 1).slice(0, 7);
    const raw = el('plan-amount').value.trim();
    if (raw) {
      const amount = L.parseMoney(raw);
      if (amount === null || amount <= 0) {
        el('plan-error').textContent = 'Вкажіть суму плану більше 0 ₴ (до двох знаків після коми).';
        el('plan-error').hidden = false;
        el('plan-amount').focus();
        return;
      }
      state.plans[key] = amount;
    } else {
      delete state.plans[key];
    }
    saveLocal();
    render();
    if (storageOK) showToast(raw ? 'План продажів записано · синхронізуємо' : 'План продажів очищено · синхронізуємо');
  }
  function defaultCashDate() {
    if (view.year === today.getFullYear() && view.month === today.getMonth() + 1) return todayISO;
    for (let d = 1; d <= L.daysInMonth(view.year, view.month); d++) {
      const date = L.iso(view.year, view.month, d);
      if (L.isWorking(L.dayType(date, state))) return date;
    }
    return L.iso(view.year, view.month, 1);
  }
  function renderCashEntry() {
    if (!selectedCashDate || selectedCashDate.slice(0, 7) !== L.iso(view.year, view.month, 1).slice(0, 7)) {
      selectedCashDate = defaultCashDate();
    }
    const dateControl = el('cash-date');
    dateControl.min = L.iso(view.year, view.month, 1);
    dateControl.max = L.iso(view.year, view.month, L.daysInMonth(view.year, view.month));
    dateControl.value = selectedCashDate;
    const shift = L.dayType(selectedCashDate, state);
    const label = { work: 'Робоча зміна', off: 'Вихідний', replacement: 'Заміна', unpaid: 'За свій рахунок' };
    const available = L.isWorking(shift);
    el('cash-status').textContent = label[shift];
    el('cash-status').classList.toggle('unavailable', !available);
    el('cash-amount').disabled = !available;
    el('cash-amount').parentElement.classList.toggle('disabled', !available);
    el('cash-wage').disabled = !available;
    el('cash-wage').parentElement.classList.toggle('disabled', !available);
    el('cash-save').disabled = !available;
    el('cash-save').title = available ? '' : 'Щоб ввести касу, позначте дату як заміну в календарі';
    el('cash-amount').value = Object.prototype.hasOwnProperty.call(state.cash, selectedCashDate)
      ? String(state.cash[selectedCashDate] / 100).replace('.', ',') : '';
    const entry = state.days[selectedCashDate] || {};
    el('cash-wage').value = Object.prototype.hasOwnProperty.call(entry, 'amount')
      ? String(entry.amount / 100).replace('.', ',') : '';
    el('cash-error').hidden = true;
  }
  function saveCash(event) {
    event.preventDefault();
    const date = el('cash-date').value;
    if (!L.dateParts(date) || date.slice(0, 7) !== L.iso(view.year, view.month, 1).slice(0, 7)) {
      el('cash-error').textContent = 'Оберіть дату в поточному місяці.';
      el('cash-error').hidden = false;
      return;
    }
    if (!L.isWorking(L.dayType(date, state))) {
      el('cash-error').textContent = 'Це вихідний. Для внесення каси спочатку позначте зміну в календарі.';
      el('cash-error').hidden = false;
      return;
    }
    const cashText = el('cash-amount').value.trim();
    const wageText = el('cash-wage').value.trim();
    const cashCents = cashText ? L.parseMoney(cashText) : null;
    const wageCents = wageText ? L.parseMoney(wageText) : null;
    if (cashText && cashCents === null) {
      el('cash-error').textContent = 'Вкажіть коректну касу (до двох знаків після коми).';
      el('cash-error').hidden = false;
      el('cash-amount').focus();
      return;
    }
    if (wageText && wageCents === null) {
      el('cash-error').textContent = 'Вкажіть коректну зарплату за день (до двох знаків після коми).';
      el('cash-error').hidden = false;
      el('cash-wage').focus();
      return;
    }
    // Keep cash in its separate dictionary and wages in the same day record as the calendar.
    // A partial record is allowed, but it appears in the journal only after both fields are filled.
    if (cashText) state.cash[date] = cashCents;
    else delete state.cash[date];
    const entry = { ...(state.days[date] || {}) };
    if (wageText) entry.amount = wageCents;
    else delete entry.amount;
    if (Object.keys(entry).length) state.days[date] = entry;
    else delete state.days[date];
    selectedCashDate = date;
    saveLocal();
    render();
    if (storageOK) {
      showToast(cashText && wageText
        ? `Касу та зарплату за ${L.formatDate(date)} записано · синхронізуємо`
        : 'Дані дня збережено · журнал відобразить день після заповнення обох сум');
    }
  }
  function renderLedger() {
    el('ledger-period').textContent = monthName(view.year, view.month);
    const rows = L.monthLedger(state, view.year, view.month);
    // Journal totals reflect only rows actually visible below, not incomplete entries.
    el('ledger-cash-total').textContent = L.formatMoney(rows.reduce((sum, item) => sum + item.cash, 0));
    el('ledger-wage-total').textContent = L.formatMoney(rows.reduce((sum, item) => sum + item.wage, 0));
    const labels = { work: 'Робоча', off: 'Вихідний', replacement: 'Заміна', unpaid: 'За свій рахунок' };
    const body = el('ledger-body');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="ledger-empty">Журнал порожній. Внесіть касу та зарплату за день, щоб додати запис.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((item) => {
      const cash = item.cashRecorded ? L.formatMoney(item.cash) : '—';
      const wage = item.wageRecorded ? L.formatMoney(item.wage) : '—';
      const cashTitle = item.ignoredCash ? ' title="Запис збережено, але не враховується: день неробочий"' : '';
      return `<tr><td>${L.formatDate(item.date)}</td><td><span class="ledger-type ${item.type}">${labels[item.type]}</span></td>` +
        `<td class="${!item.cashRecorded || item.ignoredCash ? 'ledger-muted' : ''}"${cashTitle}>${item.ignoredCash ? `${cash} (не врах.)` : cash}</td>` +
        `<td class="${!item.wageRecorded || item.ignoredWage ? 'ledger-muted' : ''}">${item.ignoredWage ? `${wage} (не врах.)` : wage}</td><td><button type="button" class="ledger-edit" data-ledger-date="${item.date}" aria-label="Змінити ${L.formatDate(item.date)}">Змінити</button></td></tr>`;
    }).join('');
  }
  function renderPayments() {
    const next = L.shiftMonth(view.year, view.month, 1);
    const stats = L.monthStats(state, view.year, view.month);
    el('pay-25-date').textContent = L.formatDate(L.iso(view.year, view.month, 25));
    el('pay-10-date').textContent = L.formatDate(L.iso(next.year, next.month, 10));
    el('pay-25-amount').textContent = L.formatMoney(stats.firstHalf);
    el('pay-10-amount').textContent = L.formatMoney(stats.secondHalf);
    const plan = L.monthPlan(state, view.year, view.month);
    el('pay-15-date').textContent = L.formatDate(L.iso(next.year, next.month, 15));
    el('pay-15-amount').textContent = L.formatMoney(plan.bonus);
    el('pay-15-caption').textContent = plan.achieved ? 'Премію за цей місяць нараховано' : 'За виконання 100% плану у цьому місяці';
  }
  function calendarCell(date, inMonth) {
    const parts = L.dateParts(date);
    if (!inMonth) return `<div class="calendar-day outside" aria-hidden="true"><span class="date-number">${Number(date.slice(8, 10))}</span></div>`;
    const type = L.dayType(date, state);
    const entry = state.days[date] || {};
    const hasAmount = L.isWorking(type) && Object.prototype.hasOwnProperty.call(entry, 'amount');
    const amount = L.dayAmount(date, state);
    const cashRecorded = L.isWorking(type) && Object.prototype.hasOwnProperty.call(state.cash, date);
    const cashAmount = L.dayCash(date, state);
    const payday = L.payday(date, state);
    const bonus = L.bonusPayday(date, state);
    const dayLabels = { work: 'Робоча зміна', off: 'Вихідний', replacement: 'Заміна', unpaid: 'За свій рахунок' };
    const initials = { work: 'Р', off: 'В', replacement: 'З', unpaid: 'С' };
    let money = '<span class="day-income empty">—</span>';
    if (hasAmount) money = `<span class="day-income desktop-income" title="${L.formatMoney(amount)}">${amount >= 1000000 ? L.formatCompact(amount) + ' ₴' : L.formatMoney(amount)}</span><span class="day-income mobile-income" title="${L.formatMoney(amount)}">${L.formatCompact(amount)} ₴</span>`;
    else if (L.isWorking(type)) money = '<span class="day-income empty">+ сума</span>';
    const payHTML = payday ? `<span class="payday-chip" title="Виплата: ${L.formatMoney(payday.amount)}"><span class="pay-desktop">ЗП ${payday.kind} · ${L.formatCompact(payday.amount)} ₴</span><span class="pay-mobile">ЗП ${payday.kind}</span></span>` : '';
    const cashHTML = cashRecorded ? `<span class="cash-chip" title="Каса: ${L.formatMoney(cashAmount)}">Каса ${L.formatCompact(cashAmount)} ₴</span>` : '';
    const bonusHTML = bonus ? `<span class="bonus-chip" title="Премія за ${bonus.forMonth}: ${L.formatMoney(bonus.amount)}"><span class="pay-desktop">Премія · ${L.formatCompact(bonus.amount)} ₴</span><span class="pay-mobile">+2к премія</span></span>` : '';
    const payAria = payday ? `; виплата ${payday.kind} числа — ${L.formatMoney(payday.amount)}` : '';
    const bonusAria = bonus ? `; премія за ${bonus.forMonth} — ${L.formatMoney(bonus.amount)}` : '';
    const aria = `${L.formatDate(date)}; ${dayLabels[type]}; заробіток: ${hasAmount ? L.formatMoney(amount) : 'не внесено'}; каса: ${cashRecorded ? L.formatMoney(cashAmount) : 'не внесено'}${payAria}${bonusAria}`;
    // Date/amount/status data comes only from validated local input and program-generated values.
    return `<button type="button" class="calendar-day ${type}${date === todayISO ? ' today' : ''}${payday ? ' has-payday' : ''}${bonus ? ' has-bonus' : ''}" data-date="${date}" aria-label="${aria}">
      <span class="day-top"><span class="date-number">${parts.day}</span><span class="day-indicator">${initials[type]}</span></span>
      <span class="day-label">${dayLabels[type]}</span>${money}${cashHTML}${payHTML}${bonusHTML}</button>`;
  }
  function renderCalendar() {
    el('month-label').textContent = monthName(view.year, view.month);
    const firstWeekday = new Date(Date.UTC(view.year, view.month - 1, 1)).getUTCDay();
    const offset = (firstWeekday + 6) % 7;
    const last = L.daysInMonth(view.year, view.month);
    const cellCount = Math.ceil((offset + last) / 7) * 7;
    const html = [];
    for (let cell = 0; cell < cellCount; cell++) {
      const dt = new Date(Date.UTC(view.year, view.month - 1, cell - offset + 1));
      const date = L.iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      html.push(calendarCell(date, dt.getUTCFullYear() === view.year && dt.getUTCMonth() + 1 === view.month));
    }
    el('day-grid').innerHTML = html.join('');
    el('previous-month').disabled = view.year === 1900 && view.month === 1;
    el('next-month').disabled = view.year === 2100 && view.month === 12;
  }
  function render() {
    renderOverview();
    renderPlan();
    renderCashEntry();
    renderLedger();
    renderPayments();
    renderCalendar();
    el('anchor-date').value = state.anchorDate;
    el('anchor-position').value = String(state.anchorPosition);
  }
  function goToMonth(offset) {
    const next = L.shiftMonth(view.year, view.month, offset);
    if (next.year < 1900 || next.year > 2100) return;
    view.year = next.year;
    view.month = next.month;
    render();
  }
  function setCurrentMonth() {
    view.year = today.getFullYear();
    view.month = today.getMonth() + 1;
    render();
  }
  function selectedStatus() {
    return document.querySelector('input[name="day-status"]:checked').value;
  }
  function updateAmountAvailability() {
    if (!editingDate) return;
    const status = selectedStatus();
    const workable = status === 'replacement' || (status === 'scheduled' && L.isScheduledWork(editingDate, state.anchorDate, state.anchorPosition));
    el('day-amount').disabled = !workable;
    el('day-cash').disabled = !workable;
    el('day-cash').parentElement.classList.toggle('disabled', !workable);
    el('cash-hint').textContent = workable ? 'Каса впливає тільки на план продажів, а не на ваш заробіток.' : 'Для цього дня каса і заробіток не враховуються у підсумках.';
    el('day-amount').parentElement.classList.toggle('disabled', !workable);
    el('amount-hint').textContent = workable
      ? 'Введіть фактичну суму або залиште поле порожнім, якщо ще не знаєте заробіток.'
      : 'Цей день не оплачується. Щоб внести заробіток, оберіть «Вийшла на заміну».';
  }
  function openDayDialog(date) {
    editingDate = date;
    const entry = state.days[date] || {};
    const p = L.dateParts(date);
    const weekday = shortDayFormatter.format(new Date(Date.UTC(p.year, p.month - 1, p.day)));
    const scheduledWork = L.isScheduledWork(date, state.anchorDate, state.anchorPosition);
    el('dialog-heading').textContent = L.formatDate(date);
    el('dialog-schedule').textContent = `${weekday[0].toUpperCase() + weekday.slice(1)} · За графіком: ${scheduledWork ? 'робоча зміна' : 'вихідний'}`;
    el('scheduled-hint').textContent = scheduledWork ? 'Робочий день' : 'Вихідний';
    document.querySelector(`input[name="day-status"][value="${entry.override || 'scheduled'}"]`).checked = true;
    el('day-amount').value = Object.prototype.hasOwnProperty.call(entry, 'amount') ? String(entry.amount / 100).replace('.', ',') : '';
    el('day-cash').value = Object.prototype.hasOwnProperty.call(state.cash, date) ? String(state.cash[date] / 100).replace('.', ',') : '';
    el('day-note').value = entry.note || '';
    el('day-error').hidden = true;
    updateAmountAvailability();
    el('day-dialog').showModal();
  }
  function closeDayDialog() {
    el('day-dialog').close();
    editingDate = null;
  }
  function saveEditedDay(event) {
    event.preventDefault();
    if (!editingDate) return;
    const status = selectedStatus();
    const entry = { ...(state.days[editingDate] || {}) };
    if (status === 'scheduled') delete entry.override;
    else entry.override = status;
    const isWork = status === 'replacement' || (status === 'scheduled' && L.isScheduledWork(editingDate, state.anchorDate, state.anchorPosition));
    let enteredCash = null;
    let hasCashInput = false;
    if (isWork) {
      const rawCash = el('day-cash').value.trim();
      hasCashInput = Boolean(rawCash);
      enteredCash = hasCashInput ? L.parseMoney(rawCash) : null;
      if (hasCashInput && enteredCash === null) {
        el('day-error').textContent = 'Введіть коректну касу (до двох знаків після коми).';
        el('day-error').hidden = false;
        el('day-cash').focus();
        return;
      }
      const rawAmount = el('day-amount').value.trim();
      if (rawAmount) {
        const cents = L.parseMoney(rawAmount);
        if (cents === null) {
          el('day-error').textContent = 'Введіть коректну суму: невід’ємне число, максимум два знаки після коми.';
          el('day-error').hidden = false;
          el('day-amount').focus();
          return;
        }
        entry.amount = cents;
      } else delete entry.amount;
    }
    if (isWork) {
      if (hasCashInput) state.cash[editingDate] = enteredCash;
      else delete state.cash[editingDate];
    }
    // Wages and cash are retained on unpaid/off days but never counted. Reset clears them completely.
    const note = el('day-note').value.trim();
    if (note) entry.note = note.slice(0, 250);
    else delete entry.note;
    if (Object.keys(entry).length) state.days[editingDate] = entry;
    else delete state.days[editingDate];
    saveLocal();
    closeDayDialog();
    render();
    if (storageOK) showToast('Зміни записано · синхронізуємо');
  }
  function resetEditedDay() {
    if (!editingDate) return;
    delete state.days[editingDate];
    delete state.cash[editingDate];
    saveLocal();
    closeDayDialog();
    render();
    if (storageOK) showToast('День оновлено · синхронізуємо');
  }
  function exportBackup() {
    try {
      const data = { ...state, exportedAt: new Date().toISOString(), app: 'Зміна — зарплата 4/2' };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `zmina-backup-${todayISO}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Резервна копія створена');
    } catch (error) {
      console.warn(error);
      showToast('Не вдалося експортувати дані');
    }
  }
  async function importBackup(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Файл надто великий (максимум 2 МБ)');
      const incoming = normalize(JSON.parse(await file.text()));
      const totalDays = Object.keys(incoming.days).length;
      if (!window.confirm(`Імпортувати ${totalDays} записів? Поточні дані будуть замінені даними з файлу.`)) return;
      state = incoming;
      saveLocal();
      render();
      showToast(storageOK ? 'Дані імпортовано · синхронізуємо' : 'Дані імпортовано, але браузер не дозволив локальну копію');
    } catch (error) {
      showToast(`Помилка імпорту: ${error.message}`);
    } finally {
      input.value = '';
    }
  }

  window.ZminaPwaCanReload = () => {
    if (!initialized || window.ZminaCloud?.hasPendingWrites || pendingCache(activeUid)?.pending || document.querySelector('dialog[open]')) return false;
    const focused = document.activeElement;
    return !(focused?.matches?.('input, textarea, select') && focused.value);
  };
  el('logout-button').addEventListener('click', () => window.ZminaCloud?.logout());
  el('gate-logout').addEventListener('click', () => window.ZminaCloud?.logout());
  el('plan-form').addEventListener('submit', savePlan);
  el('cash-form').addEventListener('submit', saveCash);
  el('cash-date').addEventListener('change', (event) => {
    selectedCashDate = event.target.value;
    if (selectedCashDate && L.dateParts(selectedCashDate)) renderCashEntry();
  });
  el('ledger-body').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-ledger-date]');
    if (button) openDayDialog(button.dataset.ledgerDate);
  });
  el('previous-month').addEventListener('click', () => goToMonth(-1));
  el('next-month').addEventListener('click', () => goToMonth(1));
  el('today-button').addEventListener('click', setCurrentMonth);
  el('month-label').addEventListener('click', setCurrentMonth);
  el('day-grid').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-date]');
    if (button) openDayDialog(button.dataset.date);
  });
  el('schedule-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const anchor = el('anchor-date').value;
    const position = Number(el('anchor-position').value);
    if (!L.dateParts(anchor) || !Number.isInteger(position) || position < 1 || position > 6) {
      showToast('Укажіть правильну опорну дату та день циклу');
      return;
    }
    state.anchorDate = anchor;
    state.anchorPosition = position;
    saveLocal();
    render();
    if (storageOK) showToast('Графік 4/2 оновлено · синхронізуємо');
  });
  document.querySelectorAll('input[name="day-status"]').forEach((radio) => radio.addEventListener('change', updateAmountAvailability));
  el('day-form').addEventListener('submit', saveEditedDay);
  el('reset-day').addEventListener('click', resetEditedDay);
  el('dialog-close').addEventListener('click', closeDayDialog);
  el('day-dialog').addEventListener('click', (event) => { if (event.target === el('day-dialog')) closeDayDialog(); });
  el('day-dialog').addEventListener('close', () => { editingDate = null; });
  el('help-button').addEventListener('click', () => el('help-dialog').showModal());
  el('help-close').addEventListener('click', () => el('help-dialog').close());
  el('help-done').addEventListener('click', () => el('help-dialog').close());
  el('help-dialog').addEventListener('click', (event) => { if (event.target === el('help-dialog')) el('help-dialog').close(); });
  el('export-button').addEventListener('click', exportBackup);
  el('import-button').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', importBackup);
  window.addEventListener('storage', (event) => {
    if (!initialized || event.key !== USER_CACHE_PREFIX + activeUid || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue);
      if (parsed.pending) return;
      state = normalize(parsed.data);
      render();
      showToast('Дані оновлено з іншої вкладки');
    } catch (error) { console.warn('Некоректні дані з іншої вкладки', error); }
  });
})();
