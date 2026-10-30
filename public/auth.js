import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const $ = id => document.getElementById(id);
let mode = 'login';
let authenticating = false;
const config = window.ZMINA_FIREBASE_CONFIG || {};
const ready = ['apiKey','authDomain','projectId','appId'].every(k => typeof config[k] === 'string' && config[k].trim());
function errorMessage(error) {
  const labels = {
    'auth/invalid-email': 'Неправильна електронна адреса.',
    'auth/email-already-in-use': 'Користувач із такою поштою вже існує.',
    'auth/weak-password': 'Пароль надто слабкий. Спробуйте довший.',
    'auth/invalid-credential': 'Невірна пошта або пароль.',
    'auth/user-disabled': 'Цей обліковий запис вимкнено.',
    'auth/too-many-requests': 'Забагато спроб входу. Спробуйте пізніше.',
    'auth/network-request-failed': 'Немає підключення до інтернету.',
    'permission-denied': 'Немає доступу до Firestore. Перевірте правила безпеки.'
  };
  return labels[error.code] || error.message || 'Невідома помилка';
}
function showError(message) { $('auth-error').textContent = message; $('auth-error').hidden = false; }
function setMode(next) {
  mode = next;
  $('auth-error').hidden = true;
  $('name-wrap').classList.toggle('form-hidden', mode !== 'signup');
  $('confirm-wrap').classList.toggle('form-hidden', mode !== 'signup');
  $('login-tab').classList.toggle('active', mode === 'login');
  $('signup-tab').classList.toggle('active', mode === 'signup');
  $('login-tab').setAttribute('aria-selected', String(mode === 'login'));
  $('signup-tab').setAttribute('aria-selected', String(mode === 'signup'));
  $('auth-title').textContent = mode === 'signup' ? 'Створити акаунт' : 'З поверненням!';
  $('auth-subtext').textContent = mode === 'signup' ? 'Створіть профіль і зберігайте свої дані у хмарі.' : 'Увійдіть, щоб відкрити календар і хмарні записи.';
  $('auth-submit').textContent = mode === 'signup' ? 'Зареєструватися ↗' : 'Увійти ↗';
  $('reset-password').hidden = mode === 'signup';
  $('auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
}
$('login-tab').onclick = () => setMode('login');
$('signup-tab').onclick = () => setMode('signup');
if (!ready) {
  showError('Firebase не налаштовано. Заповніть firebase-config.js своїми параметрами з Firebase Console. Див. README.md.');
  $('auth-submit').disabled = true;
  $('reset-password').disabled = true;
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  onAuthStateChanged(auth, user => { if (user && !authenticating) window.location.replace('index.html'); });
  $('auth-form').onsubmit = async event => {
    event.preventDefault();
    if (authenticating) return;
    $('auth-error').hidden = true;
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password || password.length < 6) return showError('Заповніть пошту і пароль довжиною від 6 символів.');
    if (mode === 'signup' && password !== $('auth-confirm').value) return showError('Паролі не збігаються.');
    const name = $('auth-name').value.trim();
    if (mode === 'signup' && !name) return showError('Вкажіть ім’я.');
    authenticating = true;
    $('auth-submit').disabled = true;
    try {
      if (mode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: name });
        await setDoc(doc(db, 'users', credential.user.uid), { email: credential.user.email || email, displayName: name, suspended: false, createdAt: serverTimestamp() });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      window.location.replace('index.html');
    } catch (error) {
      showError(errorMessage(error));
      // If account creation succeeded but profile write failed, allow recovery on next sign-in.
    } finally { authenticating = false; $('auth-submit').disabled = false; }
  };
  $('reset-password').onclick = async () => {
    const email = $('auth-email').value.trim();
    if (!email) return showError('Спочатку введіть електронну адресу.');
    $('auth-error').hidden = true;
    try { await sendPasswordResetEmail(auth, email); showError('Якщо цей акаунт існує, на пошту надійде лист для скидання пароля.'); }
    catch (error) { showError(errorMessage(error)); }
  };
}
