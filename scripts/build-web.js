/**
 * Copies renderer/ and lib/providers.js into www/ for Capacitor Android builds.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = path.join(root, 'www');
const wwwLib = path.join(www, 'lib');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(wwwLib, { recursive: true });

for (const file of ['styles.css', 'app.js', 'mobile-bridge.js']) {
  fs.copyFileSync(path.join(root, 'renderer', file), path.join(www, file));
}

fs.copyFileSync(path.join(root, 'lib', 'providers.js'), path.join(wwwLib, 'providers.js'));

let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
// Allow HTTPS/HTTP API calls in Android WebView
html = html.replace(/connect-src 'self'(?!\s+https:)/, "connect-src 'self' https: http:");
// Load mobile bridge before providers.js and point providers.js to local lib/
html = html.replace(
  '<script src="../lib/providers.js"></script>',
  '<script src="mobile-bridge.js"></script>\n  <script src="lib/providers.js"></script>'
);
fs.writeFileSync(path.join(www, 'index.html'), html, 'utf8');

console.log('[build-web] Built www/ for Capacitor');
