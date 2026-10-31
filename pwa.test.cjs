const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const read = n => fs.readFileSync(path.join(pub, n), 'utf8');

test('PWA manifest is installable and repository-subpath friendly', () => {
 const manifest = JSON.parse(read('manifest.webmanifest'));
 assert.equal(manifest.display, 'standalone');
 assert.equal(manifest.start_url, './index.html');
 assert.equal(manifest.scope, './');
 assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));
 assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512'));
 for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(pub, icon.src)));
});
test('all three app pages register PWA script and manifest',()=>{
 for (const name of ['index.html','auth.html','admin.html']) {
  const html=read(name);
  assert.match(html,/rel="manifest"/);
  assert.match(html,/src="pwa.js"/);
 }
});
test('service worker never intercepts Firestore or Auth API calls',()=>{
 const worker=read('sw.js');
 assert.match(worker,/url\.origin === self\.location\.origin/);
 assert.match(worker,/url\.href\.startsWith\(SDK_ROOT\)/);
 assert.doesNotMatch(worker,/firebaseio\.com|identitytoolkit\.googleapis\.com/);
 assert.match(worker,/version\.json/);
 assert.match(worker,/SKIP_WAITING/);
});
test('GitHub Actions generates version on each push to main',()=>{
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/deploy-pages.yml'),'utf8');
 assert.match(workflow,/branches: \[main\]/);
 assert.match(workflow,/public\/version.json/);
 assert.match(workflow,/s\/__BUILD_ID__/);
 assert.match(workflow,/path: public/);
});
test('Firestore uses persistent IndexedDB with cross-tab support',()=>{
 const cloud=read('cloud.js');
 assert.match(cloud,/persistentLocalCache\(\{tabManager: persistentMultipleTabManager\(\)\}\)/);
 assert.match(cloud,/hasPendingWrites/);
 assert.match(cloud,/fromCache/);
});
