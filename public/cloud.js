/* Firebase Auth + persistent Firestore cache; app.js owns the user-facing local backup. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut, getIdTokenResult } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, serverTimestamp, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const gate = document.getElementById('cloud-gate');
const gateMessage = document.getElementById('gate-message');
const config = window.ZMINA_FIREBASE_CONFIG || {};
const valid = ['apiKey','authDomain','projectId','appId'].every(k => typeof config[k] === 'string' && config[k].trim());
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, {detail}));
function fail(message) {
  if (gate) gate.hidden = false;
  if (gateMessage) gateMessage.textContent = message;
  console.warn('[Зміна]', message);
}
if (!valid) {
  fail('Firebase ще не налаштований. Заповніть firebase-config.js за інструкцією README.md.');
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);
  // Firestore's default web cache is memory-only. Persist it in IndexedDB for offline reads/writes.
  let db;
  try {
    db = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});
  } catch (error) {
    console.warn('Persistent Firestore cache unavailable; using memory cache', error);
    db = getFirestore(app);
    emit('zmina-cloud-status', {status:'error', message:'Постійний кеш Firestore недоступний у цьому браузері'});
  }
  let currentUid = null;
  let unsubscribe = null;
  let ready = false;
  let pendingWrites = 0;
  const dataRef = uid => doc(db, 'users', uid, 'data', 'calendar');
  const setCloudStatus = (status, message) => emit('zmina-cloud-status', {status, message});
  const hasOwnBackup = uid => {
    try { return !!localStorage.getItem('zminaFirebaseCacheV1:' + uid); }
    catch { return false; }
  };

  window.ZminaCloud = {
    get user() { return auth.currentUser; },
    get hasPendingWrites() { return pendingWrites > 0; },
    async logout() {
      if (window.ZminaPwaCanReload?.() === false && !window.confirm('Є зміни, які ще не синхронізувалися з Firebase. Вийти? Вони залишаться лише на цьому пристрої.')) return;
      await signOut(auth);
      window.location.replace('auth.html');
    },
    async save(value) {
      const uid = currentUid;
      if (!ready || !uid || !auth.currentUser || uid !== auth.currentUser.uid)
        throw Error('Календар ще не завантажено або користувач змінився');
      const snapshot = structuredClone(value);
      pendingWrites++;
      setCloudStatus('pending', navigator.onLine ? 'Запис у Firebase…' : 'Збережено на пристрої · Очікування мережі');
      // Do not serialize on the *acknowledgement* Promise: offline acknowledgements stay
      // pending, while every new edit must still enter Firestore's durable local queue.
      const operation = setDoc(dataRef(uid), {...snapshot, updatedAt: serverTimestamp()});
      try {
        await operation;
        pendingWrites--;
        if (!pendingWrites) setCloudStatus('saved', 'Збережено у Firebase');
      } catch (error) {
        pendingWrites--;
        setCloudStatus('error', 'Помилка синхронізації · Дані на пристрої');
        emit('zmina-cloud-error', {error});
        throw error;
      }
    }
  };

  window.addEventListener('offline', () => setCloudStatus('pending', 'Офлайн · Збереження на пристрої'));
  window.addEventListener('online', () => {
    setCloudStatus('pending', 'Мережа відновлена · Перевіряємо Firebase…');
  });
  onAuthStateChanged(auth, async (user) => {
    unsubscribe?.();
    unsubscribe = null;
    ready = false;
    currentUid = user?.uid || null;
    pendingWrites = 0;
    if (!user) { window.location.replace('auth.html'); return; }
    try {
      const profileRef = doc(db, 'users', user.uid);
      let profile = null;
      try { profile = await getDoc(profileRef); }
      catch (error) {
        // Existing signed-in users may continue using their own local backup offline.
        if (!hasOwnBackup(user.uid) || error.code === 'permission-denied') throw error;
        console.info('Using cached profile while offline:', error.message);
      }
      if (profile && !profile.exists()) {
        if (!navigator.onLine) {
          fail('Потрібен інтернет для першого входу в цей акаунт.');
          return;
        }
        await setDoc(profileRef, {
          email: user.email || '', displayName: user.displayName || user.email?.split('@')[0] || 'Користувач',
          suspended: false, createdAt: serverTimestamp()
        });
      } else if (profile?.data()?.suspended === true) {
        fail('Доступ до хмарних даних цього акаунта призупинено адміністратором.');
        return;
      }
      let admin = false;
      try { admin = (await getIdTokenResult(user, navigator.onLine)).claims.admin === true; }
      catch {
        try { admin = (await getIdTokenResult(user)).claims.admin === true; } catch { /* offline token */ }
      }
      emit('zmina-cloud-profile', {email:user.email, displayName:user.displayName || user.email, admin});
      let initialized = false;
      unsubscribe = onSnapshot(dataRef(user.uid), {includeMetadataChanges:true}, snapshot => {
        if (auth.currentUser?.uid !== user.uid) return;
        const cached = snapshot.metadata.fromCache;
        const hasPendingWrites = snapshot.metadata.hasPendingWrites;
        // Cached records are useful immediately; a cache miss cannot prove a new account is empty.
        if (!initialized) {
          if (cached && !snapshot.exists() && !hasOwnBackup(user.uid)) {
            setCloudStatus('pending', 'Очікуємо Firebase · Для першого завантаження потрібен інтернет');
            return;
          }
          initialized = true;
          ready = true;
          emit('zmina-cloud-initial', {
            uid:user.uid, data:snapshot.exists() ? snapshot.data() : null,
            fromCache:cached, hasPendingWrites
          });
          if (cached || hasPendingWrites) setCloudStatus('pending', 'Локальні дані · Очікування синхронізації');
          return;
        }
        if (hasPendingWrites) {
          setCloudStatus('pending', 'Зміни збережені на пристрої · Очікуємо Firebase');
          return;
        }
        if (cached || pendingWrites) return;
        if (snapshot.exists()) {
          emit('zmina-cloud-confirmed', {uid:user.uid, data:snapshot.data()});
          emit('zmina-cloud-remote', {uid:user.uid, data:snapshot.data()});
        }
        if (!pendingWrites) setCloudStatus('saved', 'Синхронізовано з Firebase');
      }, error => {
        if (!initialized) fail(`Не вдалося завантажити дані: ${error.message}`);
        emit('zmina-cloud-error', {error});
      });
    } catch (error) {
      fail(`Помилка входу чи доступу до Firestore: ${error.message}`);
      emit('zmina-cloud-error', {error});
    }
  }, error => fail(`Помилка автентифікації: ${error.message}`));
}
