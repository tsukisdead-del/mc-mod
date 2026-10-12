// Renders the Home Screen icons from the cartoon in public/js/avatar.js.
// Needs Playwright with Chromium:  npx playwright install chromium  (once), then  npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { avatarMarkup } from '../public/js/avatar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
  }
}

const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

const page = (avatarScale, offsetY) => `<!doctype html><html><head><style>${css}
  html, body { margin: 0; background: transparent; }
  .icon { width: 100vw; height: 100vh; position: relative; overflow: hidden;
    background: radial-gradient(120% 90% at 30% 15%, #d9ccff 0%, #a98bff 45%, #7c5cff 100%); }
  .icon .avatar { position: absolute; left: 50%; bottom: ${offsetY}vw; width: ${avatarScale}vw; height: ${avatarScale}vw; transform: translateX(-50%); }
  .mochi *, .mochi .m-all { animation: none !important; }
  .mochi .m-shadow { display: none; }
</style></head><body><div class="icon"><div class="avatar">${avatarMarkup('icon')}</div></div></body></html>`;

const targets = [
  { file: 'apple-touch-icon.png', size: 180, scale: 104, offset: -12 },
  { file: 'icon-192.png', size: 192, scale: 104, offset: -12 },
  { file: 'icon-512.png', size: 512, scale: 104, offset: -12 },
  // Maskable icons get cropped to a circle on Android: keep the face inside the middle 80%.
  { file: 'icon-maskable-512.png', size: 512, scale: 82, offset: -4 },
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
for (const t of targets) {
  const p = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await p.setContent(page(t.scale, t.offset));
  await p.screenshot({ path: path.join(out, t.file), omitBackground: false });
  await p.close();
  console.log('wrote', path.join('public/icons', t.file));
}
await browser.close();

// A standalone SVG (calm face) for places that show it as a plain image.
const staticSvg = avatarMarkup('s').replace(
  '<defs>',
  `<style>.m-mouth,.m-eyes-happy,.m-extra{display:none}.m-mouth-warm{display:inline}.m-cheeks{opacity:.45}.m-shadow{fill:#000;opacity:.08}</style><defs>`,
).replace(/ data-mood="[^"]*" data-state="[^"]*" data-talking="[^"]*"/, '').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
fs.writeFileSync(path.join(out, 'mochi.svg'), staticSvg);
console.log('wrote public/icons/mochi.svg');
