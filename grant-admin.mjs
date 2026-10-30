// Run only in a trusted terminal with GOOGLE_APPLICATION_CREDENTIALS pointing to
// your privately stored Firebase service account JSON. Never ship that JSON in web assets.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
const email = process.argv[2]?.trim();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run grant-admin -- admin@example.com');
  process.exit(1);
}
initializeApp({ credential: applicationDefault() });
const auth = getAuth();
try {
  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, { ...user.customClaims, admin: true });
  console.log('Admin granted to:', user.email, 'UID:', user.uid);
  console.log('User must sign out/in or refresh ID token to access admin panel.');
} catch (error) { console.error('Could not grant role:', error.message); process.exitCode = 1; }
