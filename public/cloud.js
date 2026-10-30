/* Firebase Auth + Firestore cloud adapter for Зміна. Requires firebase-config.js and HTTP(S) hosting. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut, getIdTokenResult } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const gate = document.getElementById('cloud-gate');
const gateMessage = document.getElementById('gate-message');
const config = window.ZMINA_FIREBASE_CONFIG || {};
const valid = ['apiKey', 'authDomain', 'projectId', 'appId'].every(k => typeof config[k] === 'string' && config[k].trim());
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
  const db = getFirestore(app);
  let currentUid = null;
  let unsubscribe = null;
  let ready = false;
  let pendingWrites = 0;
  let writeQueue = Promise.resolve();
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const dataRef = uid => doc(db, 'users', uid, 'data', 'calendar');
  function setCloudStatus(status, message) { emit('zmina-cloud-status', { status, message }); }
  window.ZminaCloud = {
    get user() { return auth.currentUser; },
    async logout() { await signOut(auth); window.location.replace('auth.html'); },
    async save(value) {
      const uid = currentUid;
      if (!ready || !uid || !auth.currentUser || uid !== auth.currentUser.uid) {
        throw Error('Дані ще не завантажено або користувач змінився');
      }
      const snapshot = structuredClone(value);
      pendingWrites++;
      setCloudStatus('pending', navigator.onLine ? 'Синхронізація з Firebase…' : 'Немає мережі · Очікування синхронізації');
      const operation = writeQueue.catch(() => {}).then(() => {
        if (auth.currentUser?.uid !== uid) throw Error('Ви вийшли з облікового запису');
        return setDoc(dataRef(uid), { ...snapshot, updatedAt: serverTimestamp() });
      });
      writeQueue = operation;
      try {
        await operation;
        pendingWrites--;
        if (!pendingWrites) setCloudStatus('saved', 'Збережено у Firebase');
      } catch (error) {
        pendingWrites--;
        setCloudStatus('error', 'Помилка синхронізації з Firebase');
        emit('zmina-cloud-error', { error });
        throw error;
      }
    },
    async begin() { /* onAuthStateChanged starts automatically */ }
  };

  onAuthStateChanged(auth, async (user) => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    ready = false;
    currentUid = user?.uid || null;
    pendingWrites = 0;
    writeQueue = Promise.resolve();
    if (!user) { window.location.replace('auth.html'); return; }
    try {
      const profileRef = doc(db, 'users', user.uid);
      const profile = await getDoc(profileRef);
      if (!profile.exists()) {
        await setDoc(profileRef, {
          email: user.email || '', displayName: user.displayName || user.email?.split('@')[0] || 'Користувач',
          suspended: false, createdAt: serverTimestamp()
        });
      } else if (profile.data().suspended === true) {
        fail('Доступ до хмарних даних цього акаунта призупинено адміністратором.');
        return;
      }
      const token = await getIdTokenResult(user, true);
      emit('zmina-cloud-profile', { email: user.email, displayName: user.displayName || user.email, admin: token.claims.admin === true });
      let initialized = false;
      // Initial snapshot loads the user's cloud document; later server snapshots sync other devices.
      unsubscribe = onSnapshot(dataRef(user.uid), { includeMetadataChanges: true }, (snapshot) => {
        if (!auth.currentUser || auth.currentUser.uid !== user.uid) return;
        // Wait for server certainty before creating new data; a cached "missing" document is insufficient.
        if (!initialized) {
          if (snapshot.metadata.fromCache) {
            setCloudStatus('pending', 'Читаємо дані Firebase…');
            return;
          }
          initialized = true;
          ready = true;
          emit('zmina-cloud-initial', { uid: user.uid, data: snapshot.exists() ? snapshot.data() : null });
          return;
        }
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache || pendingWrites) return;
        if (snapshot.exists()) emit('zmina-cloud-remote', { uid: user.uid, data: snapshot.data() });
      }, error => {
        if (!initialized) fail(`Не вдалося завантажити дані: ${error.message}`);
        emit('zmina-cloud-error', { error });
      });
    } catch (error) {
      fail(`Помилка входу чи доступу до Firestore: ${error.message}`);
      emit('zmina-cloud-error', { error });
    }
  }, error => fail(`Помилка автентифікації: ${error.message}`));
}
