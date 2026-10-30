import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, getIdTokenResult, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, updateDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
const $ = id => document.getElementById(id);
const L = window.SalaryLogic;
const config = window.ZMINA_FIREBASE_CONFIG || {};
const valid = ['apiKey', 'authDomain', 'projectId', 'appId'].every(k => typeof config[k] === 'string' && config[k].trim());
const now = new Date();
$('admin-month').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
$('admin-current-month').textContent = $('admin-month').value;
let profiles = [];
let selected = null;
let selectedState = null;
const inform = (message, isError = false) => { $('admin-error').textContent = message; $('admin-error').style.color = isError ? '#b4514a' : '#768a9a'; };
function cleanData(data) {
  if (!data || typeof data !== 'object') throw Error('Немає даних');
  if (!data.days || !data.plans || !data.cash || !L.dateParts(data.anchorDate) || !Number.isInteger(data.anchorPosition)) throw Error('Невірний формат записів');
  return data;
}
const shiftLabels = {work:'Робоча', off:'Вихідний', replacement:'Заміна', unpaid:'За свій рахунок'};
function renderList() {
  const q = $('admin-search').value.trim().toLowerCase();
  const list = $('admin-user-list'); list.replaceChildren();
  for (const profile of profiles.filter(p => `${p.displayName||''} ${p.email||''}`.toLowerCase().includes(q))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-user' + (selected?.id === profile.id ? ' active' : '');
    const name = document.createElement('strong'); name.textContent = profile.displayName || 'Без імені';
    const email = document.createElement('small'); email.textContent = profile.email || profile.id;
    const status = document.createElement('small'); status.textContent = profile.suspended ? '● Синхронізацію призупинено' : '● Активний';
    status.style.color = profile.suspended ? '#b25a4c' : '#558345';
    button.append(name,email,status);
    button.addEventListener('click', () => selectUser(profile.id));
    list.appendChild(button);
  }
  if (!list.children.length) { const p = document.createElement('p'); p.className='admin-notice'; p.textContent='Користувачів не знайдено.';list.append(p); }
}
function stats() {
  $('admin-total-users').textContent = String(profiles.length);
  $('admin-active-users').textContent = String(profiles.filter(p => !p.suspended).length);
  $('admin-paused-users').textContent = String(profiles.filter(p => p.suspended).length);
}
function showUser() {
  $('admin-ledger-body').replaceChildren();
  if (!selected || !selectedState) {
    $('admin-wages').textContent = '—'; $('admin-cash').textContent = '—'; $('admin-plan').textContent = '—';
    $('admin-ledger-body').insertRow().insertCell().textContent = 'Немає записів';
    return;
  }
  const [year, month] = $('admin-month').value.split('-').map(Number);
  if (!year || !month || year < 1900 || year > 2100 || month > 12) return;
  const summary = L.monthStats(selectedState,year,month);
  const plan = L.monthPlan(selectedState,year,month);
  $('admin-wages').textContent = L.formatMoney(summary.total);
  $('admin-cash').textContent = L.formatMoney(plan.actual);
  $('admin-plan').textContent = plan.target ? `${new Intl.NumberFormat('uk-UA',{maximumFractionDigits:1}).format(plan.percent)}%` : 'Не задано';
  $('admin-current-month').textContent = $('admin-month').value;
  for (const item of L.monthLedger(selectedState,year,month)) {
    const tr = document.createElement('tr');
    const cells = [L.formatDate(item.date), shiftLabels[item.type], item.cashRecorded ? L.formatMoney(item.cash) : '—', item.wageRecorded ? L.formatMoney(item.wage) : '—'];
    for (const value of cells) { const td = tr.insertCell(); td.textContent = value; }
    $('admin-ledger-body').append(tr);
  }
  if (!$('admin-ledger-body').children.length) { const tr=$('admin-ledger-body').insertRow(); const td=tr.insertCell();td.colSpan=4;td.textContent='За вибраний місяць записів немає'; }
}
async function selectUser(uid) {
  const user = profiles.find(p => p.id === uid);
  if (!user) return;
  selected = user;
  selectedState = null;
  renderList();
  $('admin-selected-title').textContent = user.displayName || user.email || 'Користувач';
  $('admin-user-details').textContent = `${user.email || ''} · UID: ${uid}`;
  $('admin-suspend').disabled = false;
  $('admin-suspend').textContent = user.suspended ? 'Відновити синхронізацію' : 'Призупинити синхронізацію';
  $('admin-suspend').className = user.suspended ? 'admin-success' : 'admin-danger';
  $('admin-export').disabled = true;
  inform('Завантажуємо записи користувача…');
  try {
    const snapshot = await getDoc(doc(db,'users',uid,'data','calendar'));
    if (selected?.id !== uid) return;
    selectedState = snapshot.exists() ? cleanData(snapshot.data()) : null;
    $('admin-export').disabled = !selectedState;
    inform(snapshot.exists() ? 'Дані відкрито в режимі перегляду.' : 'Для цього користувача ще немає календаря.');
    showUser();
  } catch(error) { inform(`Не вдалося отримати дані: ${error.message}`, true); showUser(); }
}
async function loadProfiles() {
  inform('Оновлюємо список користувачів…');
  try {
    const result = await getDocs(collection(db,'users'));
    profiles = result.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>(a.email||'').localeCompare(b.email||''));
    stats(); renderList();
    inform(`Знайдено профілів: ${profiles.length}. Адмінпанель захищена правилами Firestore.`);
    if (selected && profiles.some(p => p.id === selected.id)) await selectUser(selected.id);
  } catch (error) { inform(`Помилка отримання списку: ${error.message}`, true); }
}
$('admin-search').addEventListener('input',renderList);
$('admin-month').addEventListener('change',showUser);
$('refresh-users').addEventListener('click',loadProfiles);
$('admin-export').addEventListener('click',() => {
  if (!selectedState || !selected) return;
  const blob = new Blob([JSON.stringify({ ...selectedState, exportedByAdminAt:new Date().toISOString() },null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`zmina-user-${selected.id}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
if (!valid) {
  inform('Firebase не налаштовано. Внесіть параметри у firebase-config.js.',true);
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);
  var db = getFirestore(app);
  $('admin-logout').onclick=async()=>{ await signOut(auth); window.location.replace('auth.html'); };
  $('admin-suspend').addEventListener('click',async()=>{
    if (!selected) return;
    const wanted = !selected.suspended;
    if (!window.confirm(`${wanted ? 'Призупинити' : 'Відновити'} доступ до синхронізації для ${selected.email || selected.id}? Доступ до Firebase Authentication не вимикається.`)) return;
    $('admin-suspend').disabled = true;
    try {
      await updateDoc(doc(db,'users',selected.id),{suspended:wanted});
      selected.suspended=wanted;
      stats();renderList();
      $('admin-suspend').textContent = wanted ? 'Відновити синхронізацію' : 'Призупинити синхронізацію';
      $('admin-suspend').className = wanted ? 'admin-success' : 'admin-danger';
      inform('Статус синхронізації змінено.');
    } catch(error){inform(`Помилка зміни статусу: ${error.message}`,true);}
    finally {$('admin-suspend').disabled = false;}
  });
  onAuthStateChanged(auth,async user=>{
    if (!user) { window.location.replace('auth.html'); return; }
    try {
      const token = await getIdTokenResult(user,true);
      if (token.claims.admin !== true) { inform('Немає прав адміністратора. Доступ потребує Firebase Custom Claim admin=true.',true); return; }
      $('admin-content').hidden=false;
      await loadProfiles();
    } catch(error){inform(`Помилка перевірки прав: ${error.message}`,true);}
  },error=>inform(error.message,true));
}
