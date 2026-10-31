/* Zmina admin analytics: Firestore is read-only except the explicitly allowed suspended flag. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, getIdTokenResult, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, collection, doc, getDocFromServer, getDocsFromServer, updateDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const $ = id => document.getElementById(id);
const L = window.SalaryLogic;
const M = window.ZminaAdminMetrics;
const config = window.ZMINA_FIREBASE_CONFIG || {};
const valid = ['apiKey', 'authDomain', 'projectId', 'appId'].every(k => typeof config[k] === 'string' && config[k].trim());
const today = new Date();
$('admin-month').value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
let profiles = [];
const records = new Map();
let currentEntries = [];
let selectedId = null;
let dataReady = false;
let requestVersion = 0;
let busy = false;
let db;

const money = amount => L.formatMoney(amount || 0);
const percent = amount => `${new Intl.NumberFormat('uk-UA',{maximumFractionDigits:1}).format(amount)}%`;
const nameOf = item => item.displayName || item.email || 'Без імені';
const shiftNames = {work:'Робоча',replacement:'Заміна',unpaid:'За свій рахунок',off:'Вихідний'};
const statusText = p => p.suspended ? 'Призупинено' : 'Активний';
const max0 = value => Math.max(0,Number.isFinite(value) ? value : 0);
function monthParts() {
  const m = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec($('admin-month').value);
  if (!m) return null;
  return {year:Number(m[1]),month:Number(m[2])};
}
function notify(message, isError=false) {
  $('admin-error').textContent=message;
  $('admin-error').classList.toggle('error',isError);
}
function make(tag,className,text) {
  const node=document.createElement(tag);
  if (className) node.className=className;
  if (text !== undefined) node.textContent=String(text);
  return node;
}
function cleanData(data) {
  if (!data || typeof data!=='object' || !data.days || !data.plans || !data.cash ||
      typeof data.days!=='object' || typeof data.plans!=='object' || typeof data.cash!=='object' ||
      !L.dateParts(data.anchorDate) || !Number.isInteger(data.anchorPosition) || data.anchorPosition<1 || data.anchorPosition>6)
    throw Error('Непідтримуваний формат календаря');
  return data;
}
function entryFor(profile) {
  const record=records.get(profile.id);
  const month=monthParts();
  return {...profile, error:record?.error||null, metrics:record?.state && month ? M.employee(record.state,month.year,month.month):null};
}
function setText(id,value) { $(id).textContent=value; }
function limitPercent(value) { return Math.min(100,max0(value)); }
function displayNameMonth() {
  const parts=monthParts();
  if (!parts) return;
  const date=new Date(Date.UTC(parts.year,parts.month-1,1));
  $('admin-current-month').textContent=new Intl.DateTimeFormat('uk-UA',{month:'long',year:'numeric',timeZone:'UTC'}).format(date);
}
function renderOverview() {
  if (!monthParts()) return;
  const parts=monthParts();
  const t=M.team(currentEntries,parts.year,parts.month);
  setText('admin-team-cash',money(t.cash));
  setText('admin-team-wages',money(t.wage));
  setText('admin-team-plans',`${t.achieved} із ${t.withTarget}`);
  setText('admin-team-bonus',money(t.bonus));
  setText('admin-total-users',String(profiles.length));
  setText('admin-user-status-caption',`Активних: ${profiles.filter(p=>!p.suspended).length} · Призупинено: ${profiles.filter(p=>p.suspended).length}`);
  setText('admin-coverage',t.missing ? `Дані ${t.loaded}/${profiles.length} · є помилки` : `Дані ${t.loaded}/${profiles.length}`);
  renderSpark('admin-team-cash-chart',t.daily,'cash','Каса команди');
  renderSpark('admin-team-wage-chart',t.daily,'wage','Зарплата команди');
  const leaders=$('admin-leader-list'); leaders.replaceChildren();
  const sorted=t.ranking.filter(i=>i.metrics).slice(0,5);
  if (!sorted.length) { leaders.append(make('p','admin-muted','Ще немає внесених даних.')); return; }
  const highest=Math.max(1,...sorted.map(i=>i.metrics.cash));
  for (const [idx,item] of sorted.entries()) {
    const button=make('button','admin-leader'); button.type='button';
    const top=make('div','admin-leader-top');
    const name=make('span','admin-leader-name',`${idx+1}. ${nameOf(item)}`);
    const value=make('strong','',money(item.metrics.cash));
    top.append(name,value);
    const track=make('div','admin-mini-track');const fill=make('div','admin-mini-fill');fill.style.width=`${item.metrics.cash/highest*100}%`;track.append(fill);
    button.append(top,track);
    button.addEventListener('click',()=>chooseUser(item.id,true));
    leaders.append(button);
  }
}
function renderStaff() {
  const query=$('admin-search').value.trim().toLocaleLowerCase('uk-UA');
  const filter=$('admin-filter-status').value;
  const sort=$('admin-sort').value;
  let items=currentEntries.filter(p=>
    `${p.displayName||''} ${p.email||''}`.toLocaleLowerCase('uk-UA').includes(query) &&
    (filter==='all' || (filter==='active' && !p.suspended) || (filter==='paused' && p.suspended)));
  items.sort((a,b)=>{
    const am=a.metrics, bm=b.metrics;
    if(sort==='name') return nameOf(a).localeCompare(nameOf(b),'uk-UA');
    const av=sort==='cash' ? am?.cash : sort==='wage' ? am?.wage : am?.percent;
    const bv=sort==='cash' ? bm?.cash : sort==='wage' ? bm?.wage : bm?.percent;
    return (bv ?? -1)-(av ?? -1) || nameOf(a).localeCompare(nameOf(b),'uk-UA');
  });
  setText('admin-list-count',`Знайдено: ${items.length} із ${profiles.length}`);
  const list=$('admin-user-list');list.replaceChildren();
  if (!items.length) { list.append(make('p','admin-muted admin-empty-list','Нічого не знайдено. Змініть фільтри.'));return; }
  for(const p of items){
    const button=make('button','admin-person-row'+(selectedId===p.id?' active':''));
    button.type='button';button.setAttribute('aria-pressed',String(selectedId===p.id));
    const header=make('div','admin-person-head');const avatar=make('span','admin-avatar',nameOf(p).trim().slice(0,1).toLocaleUpperCase('uk-UA')||'•');
    const identity=make('span','admin-person-ident');identity.append(make('strong','',nameOf(p)),make('small','',p.email||p.id));
    header.append(avatar,identity);
    const status=make('span','admin-employee-status'+(p.suspended?' paused':''),p.suspended?'Пауза':'Активний');header.append(status);
    button.append(header);
    const detail=make('div','admin-person-figures');
    detail.append(make('span','',`Каса: ${p.error?'Помилка':p.metrics?money(p.metrics.cash):'—'}`),
                  make('strong','',p.error?'Недоступно':p.metrics?.target?percent(p.metrics.percent):'План —'));
    button.append(detail);
    const track=make('div','admin-mini-track');const fill=make('div','admin-mini-fill');fill.style.width=`${limitPercent(p.metrics?.percent)}%`;track.append(fill);button.append(track);
    button.addEventListener('click',()=>chooseUser(p.id,false));
    list.append(button);
  }
}
function emptyChart(containerId,message='Немає записів за місяць') {
  const host=$(containerId);host.replaceChildren();host.append(make('div','admin-chart-empty',message));
}
function renderSpark(containerId,data,key,label){
  const host=$(containerId);host.replaceChildren();
  if(!data || !data.some(p=>p[key]>0)) {emptyChart(containerId);return;}
  const values=data.map(p=>Math.max(0,p[key]/100));
  const high=Math.max(1,...values);
  const w=590,h=180,left=42,right=12,top=12,bottom=31;
  const chartWidth=w-left-right,chartHeight=h-top-bottom;
  const pt=(i)=>[left+i/(values.length-1)*chartWidth,top+(1-values[i]/high)*chartHeight];
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  svg.setAttribute('role','img');svg.setAttribute('aria-label',`${label} за днями місяця`);
  svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  const insert=(tag,attrs,text)=>{
    const node=document.createElementNS(ns,tag);for(const [attr,val] of Object.entries(attrs))node.setAttribute(attr,String(val));
    if(text!==undefined)node.textContent=String(text);svg.append(node);return node;
  };
  for(let i=0;i<3;i++){
    const y=top+chartHeight*i/2;
    insert('line',{x1:left,x2:w-right,y1:y,y2:y,stroke:'#e9eef2','stroke-dasharray':'4 5'});
    insert('text',{x:left-6,y:y+3,fill:'#8d9ca9','font-size':10,'text-anchor':'end'},L.formatCompact(Math.round(high*(1-i/2)*100)));
  }
  const stroke=key==='cash'?'#70ab4c':'#8072d4';
  const points=values.map((_,i)=>pt(i));
  const line=points.map((p,i)=>`${i?'L':'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const area=`${line} L ${w-right} ${top+chartHeight} L ${left} ${top+chartHeight} Z`;
  insert('path',{d:area,fill:key==='cash'?'#dff2d3':'#eeeafa',opacity:'.75'});
  insert('path',{d:line,fill:'none',stroke,'stroke-width':2.7,'stroke-linejoin':'round','stroke-linecap':'round'});
  const labelIndices=[0,Math.round((values.length-1)/4),Math.round((values.length-1)/2),Math.round((values.length-1)*.75),values.length-1];
  for(const i of new Set(labelIndices)){
    const x=pt(i)[0];insert('text',{x,y:h-9,'text-anchor':'middle','font-size':10,fill:'#8d9ca9'},i+1);
  }
  host.append(svg);
}
function renderUser() {
  const selected=profiles.find(p=>p.id===selectedId);
  const record=selected ? records.get(selected.id) : null;
  const item=currentEntries.find(p=>p.id===selectedId);
  const m=item?.metrics;
  const empty=()=>{
    for(const id of ['admin-wages','admin-cash','admin-plan','admin-shifts','admin-plan-meta'])setText(id,'—');
    $('admin-plan-bar').style.width='0%';
    emptyChart('admin-person-cash-chart');emptyChart('admin-person-wage-chart');
    const tbody=$('admin-ledger-body');tbody.replaceChildren();const row=tbody.insertRow();const td=row.insertCell();td.colSpan=4;td.textContent='За вибраний місяць записів немає';
    setText('admin-ledger-caption','—');setText('admin-bonus-note','План ще не задано');
  };
  if(!selected){setText('admin-selected-title','Оберіть працівника');setText('admin-user-details','Натисніть на ім’я зліва, щоб переглянути статистику.');setText('admin-person-status','—');
    $('admin-export').disabled=true;$('admin-suspend').disabled=true;empty();return;}
  setText('admin-selected-title',nameOf(selected));
  setText('admin-user-details',selected.email || 'Без email');
  setText('admin-person-status',statusText(selected));
  $('admin-person-status').classList.toggle('paused',!!selected.suspended);
  $('admin-export').disabled=!record?.state;
  $('admin-suspend').disabled=busy;
  $('admin-suspend').textContent=selected.suspended?'Відновити синхронізацію':'Призупинити синхронізацію';
  $('admin-suspend').className=selected.suspended?'admin-success':'admin-danger';
  if(record?.error){empty();setText('admin-bonus-note','Не вдалося завантажити записи цього користувача.');return;}
  if(!m){empty();return;}
  setText('admin-wages',money(m.wage));setText('admin-cash',money(m.cash));
  setText('admin-plan',m.target?percent(m.percent):'Не задано');
  setText('admin-shifts',`${m.recorded} / ${m.working}`);
  setText('admin-plan-meta',m.target?`${money(m.cash)} / ${money(m.target)}`:'Не встановлено');
  $('admin-plan-bar').style.width=`${limitPercent(m.percent)}%`;
  const parts=monthParts();const next=L.shiftMonth(parts.year,parts.month,1);
  setText('admin-bonus-note',m.achieved?`✓ Премія ${money(m.bonus)} · виплата 15.${String(next.month).padStart(2,'0')}.${next.year}`:m.target?`До плану: ${money(Math.max(0,m.target-m.cash))} · премію ще не нараховано`:'План продажів на цей місяць не встановлено');
  renderSpark('admin-person-cash-chart',m.daily,'cash','Каса працівника');
  renderSpark('admin-person-wage-chart',m.daily,'wage','Зарплата працівника');
  setText('admin-ledger-caption',`${m.ledger.length} заповнених днів · ${m.replacement} замін`);
  const body=$('admin-ledger-body');body.replaceChildren();
  if(!m.ledger.length){const row=body.insertRow();const cell=row.insertCell();cell.colSpan=4;cell.textContent='У журналі поки немає днів з касою і зарплатою.';return;}
  for(const day of m.ledger){
    const tr=body.insertRow();
    const cells=[L.formatDate(day.date),shiftNames[day.type]||day.type,money(day.cash),money(day.wage)];
    for(const value of cells)tr.insertCell().textContent=value;
  }
}
function chooseUser(uid,scroll=false){
  selectedId=uid;
  renderStaff();renderUser();
  if(scroll)$('admin-selected-title').scrollIntoView({behavior:'smooth',block:'center'});
}
function renderAll(){
  displayNameMonth();
  currentEntries=profiles.map(entryFor);
  renderOverview();renderStaff();renderUser();
  $('admin-export-team').disabled=!dataReady || busy;
}
function csvEscape(value){
  let string=String(value ?? '');
  // Prevent formula injection when opening an exported report in spreadsheet software.
  if(/^[\s]*[=+@\-]/.test(string)) string="'"+string;
  return `"${string.replaceAll('"','""')}"`;
}
function download(name,contents,type){
  const blob=new Blob([contents],{type});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportTeam(){
  if(!dataReady || !monthParts())return;
  const rows=[['Працівник','Email','Статус','Каса (грн)','Зарплата (грн)','План (грн)','Виконання (%)','Премія (грн)','Заповнено змін']];
  for(const p of currentEntries){
    if(p.error || !p.metrics)continue;
    const m=p.metrics;
    rows.push([nameOf(p),p.email||'',statusText(p),(m.cash/100).toFixed(2),(m.wage/100).toFixed(2),(m.target/100).toFixed(2),m.percent===null?'':m.percent.toFixed(2),(m.bonus/100).toFixed(2),m.recorded]);
  }
  download(`zmina-team-${$('admin-month').value}.csv`,'\ufeff'+rows.map(row=>row.map(csvEscape).join(';')).join('\r\n'),'text/csv;charset=utf-8');
}
async function loadProfiles(){
  if(busy || !db)return;
  busy=true;dataReady=false;const loadId=++requestVersion;
  $('refresh-users').disabled=true;$('admin-export-team').disabled=true;
  notify('Завантажуємо профілі та дані працівників із Firestore…');
  try{
    const response=await getDocsFromServer(collection(db,'users'));
    if(loadId!==requestVersion)return;
    const previous=selectedId;
    profiles=response.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>nameOf(a).localeCompare(nameOf(b),'uk-UA'));
    records.clear();
    selectedId=profiles.some(p=>p.id===previous)?previous:(profiles[0]?.id||null);
    let cursor=0,finished=0,failed=0;
    const worker=async()=>{
      while(true){
        const idx=cursor++;if(idx>=profiles.length)return;
        const profile=profiles[idx];
        try{
          const snapshot=await getDocFromServer(doc(db,'users',profile.id,'data','calendar'));
          if(loadId!==requestVersion)return;
          records.set(profile.id,{state:snapshot.exists()?cleanData(snapshot.data()):null,error:null});
        }catch(error){
          failed++;records.set(profile.id,{state:null,error:error.message||'Невідома помилка'});
        }
        finished++;
        notify(`Завантажено ${finished} із ${profiles.length} акаунтів…`);
      }
    };
    await Promise.all(Array.from({length:Math.min(4,profiles.length)},()=>worker()));
    dataReady=true;renderAll();
    notify(failed ? `Завантажено ${profiles.length-failed} із ${profiles.length} календарів. Частина підсумків неповна.` :
      `Дані оновлено з Firebase · ${profiles.length} профілів · ${new Date().toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}`,failed>0);
  }catch(error){
    notify(`Помилка завантаження Firestore: ${error.message}`,true);
  }finally{
    busy=false;$('refresh-users').disabled=false;
    $('admin-export-team').disabled=!dataReady;
    renderUser();
  }
}
$('admin-month').addEventListener('change',()=>{if(monthParts())renderAll();else notify('Невірно вибраний місяць',true);});
$('admin-search').addEventListener('input',renderStaff);
$('admin-filter-status').addEventListener('change',renderStaff);
$('admin-sort').addEventListener('change',renderStaff);
$('refresh-users').addEventListener('click',loadProfiles);
$('admin-export-team').addEventListener('click',exportTeam);
$('admin-export').addEventListener('click',()=>{
  const record=records.get(selectedId);if(!record?.state || !selectedId)return;
  download(`zmina-user-${selectedId}.json`,JSON.stringify({...record.state,exportedByAdminAt:new Date().toISOString()},null,2),'application/json');
});

if(!valid){notify('Firebase не налаштовано. Заповніть firebase-config.js.',true);}
else{
  const app=initializeApp(config);const auth=getAuth(app);db=getFirestore(app);
  $('admin-logout').addEventListener('click',async()=>{
    await signOut(auth);window.location.replace('auth.html');
  });
  $('admin-suspend').addEventListener('click',async()=>{
    const profile=profiles.find(p=>p.id===selectedId);if(!profile || busy)return;
    const next=!profile.suspended;
    if(!confirm(`${next?'Призупинити':'Відновити'} синхронізацію акаунта ${profile.email || nameOf(profile)}? Це НЕ вимикає вхід через Firebase Authentication.`))return;
    $('admin-suspend').disabled=true;
    try{
      await updateDoc(doc(db,'users',profile.id),{suspended:next});
      profile.suspended=next;renderAll();
      notify(`Синхронізацію для ${nameOf(profile)} ${next?'призупинено':'відновлено'}.`);
    }catch(error){notify(`Не вдалося змінити статус: ${error.message}`,true);}
    finally{$('admin-suspend').disabled=false;}
  });
  onAuthStateChanged(auth,async user=>{
    if(!user){window.location.replace('auth.html');return;}
    try{
      const token=await getIdTokenResult(user,true);
      if(token.claims.admin!==true){notify('Немає прав адміністратора. Потрібен Firebase Custom Claim admin=true.',true);return;}
      $('admin-content').hidden=false;
      await loadProfiles();
    }catch(error){notify(`Не вдалося перевірити права: ${error.message}`,true);}
  },error=>notify(`Помилка входу: ${error.message}`,true));
}
