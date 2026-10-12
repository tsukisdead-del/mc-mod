import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReply, plainText } from '../public/js/reply-format.js';
import { renderMarkdown } from '../public/js/markdown.js';
import { inWindow, nextWindowStart, formatStamp, localParts } from '../server/time.js';
import { applySettingsPatch, defaultSettings, withDefaults } from '../server/settings.js';
import { toneBand, settingsBlock } from '../server/prompts.js';
import { buildMobileConfig } from '../server/profile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseReply splits texts and reads the mood and crisis tags', () => {
  const r = parseReply('[[mood:laughing]] lol ok\n|||\nreal talk though [[crisis]]');
  assert.equal(r.mood, 'laughing');
  assert.equal(r.crisis, true);
  assert.deepEqual(r.bubbles, ['lol ok', 'real talk though']);
});

test('parseReply hides half-arrived tags while streaming', () => {
  assert.deepEqual(parseReply('[[mood:wa', { partial: true }).bubbles, []);
  const r = parseReply('[[mood:warm]] hi\n|||\nsecond te', { partial: true });
  assert.deepEqual(r.bubbles, ['hi', 'second te']);
  assert.equal(r.open, true);
  assert.equal(parseReply('[[mood:warm]] hi\n|||\n', { partial: true }).open, false);
});

test('unknown moods are ignored and plainText drops markup', () => {
  assert.equal(parseReply('[[mood:evil]] hey').mood, null);
  assert.equal(plainText('[[mood:warm]] **hey**\n|||\nyou'), 'hey you');
});

test('markdown escapes HTML and links crisis numbers', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> call **988**');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('href="tel:988"'));
  assert.ok(renderMarkdown('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
});

test('check-in window math respects the local timezone', () => {
  const tz = 'America/Los_Angeles';
  const t = Date.UTC(2026, 9, 12, 13, 0); // 6:00 AM in Los Angeles
  assert.equal(localParts(t, tz).hour, 6);
  assert.equal(inWindow(t, tz, 9, 21), false);
  const next = nextWindowStart(t, tz, 9, 21);
  assert.equal(localParts(next, tz).hour, 9);
  assert.ok(next - t <= 3 * 60 * 60 * 1000);
  // Overnight window (10 PM to 2 AM)
  assert.equal(inWindow(Date.UTC(2026, 9, 12, 7, 30), tz, 22, 2), true); // 12:30 AM
  assert.match(formatStamp(t, tz), /^Mon Oct 12, 6:00 AM$/);
});

test('settings patches are validated', () => {
  const s = applySettingsPatch(defaultSettings(), {
    tone: 250,
    therapistName: '  Pip  ',
    timezone: 'Not/AZone',
    checkins: { frequency: 'hourly', startHour: -3, styles: { selfcare: true, bogus: true } },
  });
  assert.equal(s.tone, 100);
  assert.equal(s.therapistName, 'Pip');
  assert.equal(s.timezone, 'America/New_York');
  assert.equal(s.checkins.frequency, 'daily');
  assert.equal(s.checkins.startHour, 0);
  assert.equal(s.checkins.styles.selfcare, true);
  assert.equal('bogus' in s.checkins.styles, false);
  assert.equal(withDefaults({ tone: 10 }).checkins.enabled, true);
});

test('tone bands cover the whole slider', () => {
  assert.equal(toneBand(0).label, 'Gentle & therapeutic');
  assert.equal(toneBand(50).label, 'Balanced');
  assert.equal(toneBand(100).label, 'No filter');
  assert.match(settingsBlock({ ...defaultSettings(), tone: 77, allowCursing: true }, ''), /77\/100, "Real talk"/);
});

test('the iPhone profile is a web clip pointing at the app', () => {
  const icon = fs.readFileSync(path.join(root, 'public/icons/apple-touch-icon.png')).toString('base64');
  const xml = buildMobileConfig({
    url: 'https://mochi.example.com',
    label: 'Dr. <Mochi>',
    iconBase64: icon,
  });
  assert.match(xml, /<string>com\.apple\.webClip\.managed<\/string>/);
  assert.match(xml, /<string>https:\/\/mochi\.example\.com\/<\/string>/);
  assert.match(xml, /Dr\. &lt;Mochi&gt;/);
  assert.match(xml, /<key>FullScreen<\/key>\s*<true\/>/);
  // Same URL, same UUIDs: reinstalling replaces instead of duplicating.
  assert.equal(xml, buildMobileConfig({ url: 'https://mochi.example.com/', label: 'Dr. <Mochi>', iconBase64: icon }));
});
