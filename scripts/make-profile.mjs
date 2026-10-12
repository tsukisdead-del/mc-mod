// Writes an iPhone configuration profile for an app you've already deployed.
// Usage: npm run profile -- https://your-app.example.com ["Dr. Mochi"]
// (The running server also serves one at /app.mobileconfig, so this is only needed if you want the file itself.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMobileConfig, defaultIconPath } from '../server/profile.js';

const [url, label = 'Dr. Mochi'] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error('Usage: npm run profile -- https://your-app.example.com ["Dr. Mochi"]');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = `${label.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'therapist'}.mobileconfig`;
fs.writeFileSync(file, buildMobileConfig({ url, label, iconPath: defaultIconPath(path.join(root, 'public')) }));
console.log(`Wrote ${file}. AirDrop or email it to your iPhone, open it, then install it from Settings.`);
