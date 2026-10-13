import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCrisis } from '../server/safety.js';
import { scheduleNext, noteActivity, tickAction, MAX_UNANSWERED, HOUR } from '../server/checkins.js';
import { buildTurns, nextHistoryStart } from '../server/history.js';
import { defaultSettings } from '../server/settings.js';
import { inWindow } from '../server/time.js';
import { isPushEndpoint } from '../server/push-payload.js';
import { addressBucket } from '../worker/auth.js';

test('crisis backstop catches risk language but not figures of speech', () => {
  for (const t of ['I want to die', 'thinking about suicide', "I don't want to be alive anymore", 'i keep cutting myself', 'everyone would be better off without me', 'I might overdose', 'gonna kms... I mean kill myself']) {
    assert.equal(looksLikeCrisis(t), true, t);
  }
  for (const t of ["I'm dead 💀 that's so funny", 'this homework is killing me', 'I could die of embarrassment lol', 'my phone died', 'killing it at work today']) {
    assert.equal(looksLikeCrisis(t), false, t);
  }
});

const settings = (over = {}) => ({ ...defaultSettings(), timezone: 'UTC', ...over, checkins: { ...defaultSettings().checkins, ...(over.checkins || {}) } });
const at = (h, m = 0) => Date.UTC(2026, 9, 12, h, m);

test('check-ins are scheduled inside the chosen hours and stop after ignored ones', () => {
  const s = settings({ checkins: { startHour: 9, endHour: 21, frequency: 'twice_daily' } });
  for (let i = 0; i < 50; i++) {
    const next = scheduleNext(s, { unanswered: 0 }, at(20, 30), () => i / 50);
    assert.ok(inWindow(next, 'UTC', 9, 21));
    assert.ok(next > at(20, 30));
  }
  assert.equal(scheduleNext(s, { unanswered: MAX_UNANSWERED }, at(12)), null);
  assert.equal(scheduleNext(settings({ checkins: { enabled: false } }), { unanswered: 0 }, at(12)), null);
});

test('tick decides to send, wait, or reschedule', () => {
  const s = settings({ checkins: { startHour: 9, endHour: 21 } });
  const base = { settings: s, lastUserMessageAt: at(6) };
  assert.equal(tickAction({ ...base, checkin: { nextAt: at(13), unanswered: 0 }, now: at(12) }), 'wait');
  assert.equal(tickAction({ ...base, checkin: { nextAt: at(12), unanswered: 0 }, now: at(12, 5) }), 'send');
  // talked 30 minutes ago: push it back
  assert.deepEqual(tickAction({ ...base, lastUserMessageAt: at(11, 35), checkin: { nextAt: at(12), unanswered: 0 }, now: at(12, 5) }), { reschedule: at(11, 35) });
  // server slept through the slot by hours: pick a new time instead of a stale check-in
  assert.deepEqual(tickAction({ ...base, checkin: { nextAt: at(9), unanswered: 0 }, now: at(13) }), { reschedule: at(13) });
  // outside their hours
  assert.deepEqual(tickAction({ ...base, checkin: { nextAt: at(21, 58), unanswered: 0 }, now: at(22, 1) }), { reschedule: at(22, 1) });
  assert.equal(tickAction({ ...base, settings: settings({ checkins: { enabled: false } }), checkin: { nextAt: at(12), unanswered: 0 }, now: at(12, 5) }), 'wait');
});

test('replying resets the ignored count and pulls in a paused schedule', () => {
  const c = { nextAt: null, unanswered: MAX_UNANSWERED };
  assert.equal(noteActivity(c, at(12)), true);
  assert.equal(c.unanswered, 0);
  const soon = { nextAt: at(12, 30), unanswered: 1 };
  assert.equal(noteActivity(soon, at(12)), true); // too close to a chat: reschedule
  const later = { nextAt: at(12) + 5 * HOUR, unanswered: 0 };
  assert.equal(noteActivity(later, at(12)), false);
});

test('history turns alternate roles, mark check-ins, and the window only drops covered messages', () => {
  const msgs = [
    { id: 'a', role: 'assistant', kind: 'checkin', text: '[[mood:warm]] hey!', attachments: [], createdAt: at(9) },
    { id: 'b', role: 'user', kind: 'chat', text: 'hi', attachments: [], createdAt: at(10) },
    { id: 'c', role: 'user', kind: 'chat', text: '', attachments: ['f1'], createdAt: at(10, 1) },
  ];
  const turns = buildTurns(msgs, { timezone: 'UTC', filePlaceholder: () => '[file]' });
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.match(turns[0].content[0].text, /you texted first to check in/);
  assert.match(buildTurns(msgs.slice(0, 1).map((m) => ({ ...m, kind: 'chat' })), { timezone: 'UTC', filePlaceholder: () => '' })[0].content[0].text, /start of the conversation/);
  assert.ok(turns[2].content.some((p) => p.type === 'files'));
  assert.ok(turns[2].content.some((p) => p.text?.includes('(sent without a message)')));

  const many = Array.from({ length: 90 }, (_, i) => ({ createdAt: i + 1 }));
  assert.equal(nextHistoryStart(many, 0, 90), 51); // keep the newest 40
  assert.equal(nextHistoryStart(many, 0, 30), 31); // never past what the notes cover
  assert.equal(nextHistoryStart(many.slice(0, 50), 0, 50), 0); // under the limit: unchanged
});

test('paused check-ins stay paused even with an old time on the books', () => {
  const settings = { ...defaultSettings(), timezone: 'UTC' };
  settings.checkins = { ...settings.checkins, enabled: true, startHour: 0, endHour: 0 };
  const now = Date.UTC(2026, 9, 12, 15);
  const checkin = { nextAt: now - 60000, lastSentAt: null, unanswered: MAX_UNANSWERED };
  assert.equal(tickAction({ settings, checkin, lastUserMessageAt: null, now }), 'wait');
});

test('push subscriptions must point at a real browser push service', () => {
  assert.ok(isPushEndpoint('https://web.push.apple.com/QGx3abc'));
  assert.ok(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def'));
  assert.ok(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc'));
  assert.ok(!isPushEndpoint('https://evil.example/collect'));
  assert.ok(!isPushEndpoint('https://push.apple.com.evil.example/x'));
  assert.ok(!isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(!isPushEndpoint('https://fcm.googleapis.com:8443/fcm/send/abc'));
  assert.ok(!isPushEndpoint('not a url'));
});

test('login limits count IPv6 users by their /64', () => {
  assert.equal(addressBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(addressBucket('2001:db8:1:2:3:4:5:6'), addressBucket('2001:0db8:0001:0002:ffff::1'));
  assert.equal(addressBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressBucket(null), 'unknown');
});

test('Word XML is read as paragraphs, tabs and line breaks', async () => {
  const { wordXmlText } = await import('../server/attachments.js').catch(() => ({}));
  if (!wordXmlText) return; // needs the Node server's modules
  const xml = '<w:body><w:p><w:r><w:t>Dear diary,</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Today &amp; </w:t><w:tab/><w:t>tomorrow</w:t><w:br/><w:t>&lt;3</w:t></w:r></w:p></w:body>';
  assert.equal(wordXmlText(xml), 'Dear diary,\n\nToday & \ttomorrow\n<3\n\n');
});

test('document search: parts cover the text, common words are ignored, follow-ups reuse the question', async () => {
  const { chunkText, queryTerms, ftsQuery, searchTextFor } = await import('../server/doc-search.js');
  const text = 'One. Two three.\n\n'.repeat(500);
  const parts = chunkText(text, 300);
  assert.equal(parts.map(([a, b]) => text.slice(a, b)).join(''), text);
  assert.ok(parts.every(([a, b]) => b - a <= 300));
  assert.deepEqual(queryTerms('What do you think about my essay on grief?'), ['essay', 'grief']);
  assert.equal(ftsQuery(['grief', 'say "hi"']), '"grief" OR "say hi"');
  const m = (role, text) => ({ role, text });
  assert.equal(searchTextFor([m('user', 'tell me about the ferry'), m('assistant', 'ok'), m('user', 'why?')]), 'tell me about the ferry');
  assert.equal(searchTextFor([m('user', 'tell me about the ferry'), m('assistant', 'ok'), m('user', 'anyway, lunch was great')]), 'anyway, lunch was great');
});

test('speech pieces are joined without the repeats iPhone and Android send', async () => {
  const { assemble, mergePiece, fixName } = await import('../public/js/transcript.js');
  const R = (t, isFinal) => Object.assign([{ transcript: t }], { isFinal: Boolean(isFinal) });
  // WebKit: the list holds earlier finals plus the newest result.
  const webkit = (updates) => {
    const finals = [];
    let last = [];
    for (const [t, fin] of updates) {
      last = [...finals, R(t, fin)];
      if (fin) finals.push(R(t, fin));
    }
    return last;
  };
  const cases = [
    // the reported bug: iPhone sends the final twice
    [webkit([['Hi', 0], ['Hi Dr.', 0], ['Hi Dr. emoji', 0], ['Hi Dr. emoji', 1], ['Hi Dr. emoji', 1]]), 'Hi Dr. emoji'],
    // iPhone: everything so far, again, after a pause
    [webkit([['I had a rough day', 1], ['I had a rough day at work.', 1], ['I had a rough day at work.', 1]]), 'I had a rough day at work.'],
    // iOS 18: pieces restart after a pause, each sent twice
    [webkit([['I had a rough day', 1], ['I had a rough day', 1], ['at work', 1], ['at work', 1]]), 'I had a rough day at work'],
    // a later final corrects an earlier word
    [webkit([['Hi Dr. emoji', 1], ['Hi Dr. Mochi, how are you?', 1]]), 'Hi Dr. Mochi, how are you?'],
    [webkit([['I had a rough day', 1], ['I had a really rough day at work', 1]]), 'I had a really rough day at work'],
    [webkit([['I can not sleep at night', 1], ['I cannot sleep at night anymore', 1]]), 'I cannot sleep at night anymore'],
    // Chrome: separate pieces plus an unfinished part split in two
    [[R('I had a rough day', 1), R(' at work', 1), R(' and then', 0), R(' my boss', 0)], 'I had a rough day at work and then my boss'],
    // real repeats stay
    [[R('I said no', 1), R(' no', 1)], 'I said no no'],
    [[R('I went to the store', 1), R(' the store was closed', 1)], 'I went to the store the store was closed'],
    [[R('I am', 1), R(' I was going', 1)], 'I am I was going'],
    [[R('I feel sad', 1), R(' I want to sleep', 1)], 'I feel sad I want to sleep'],
    // Android: cumulative and duplicate finals
    [[R('hello', 1), R('hello how are you', 1)], 'hello how are you'],
    [[R('hello there', 1), R('hello there', 1)], 'hello there'],
    // stopped before anything was final
    [webkit([['I just', 0], ['I just feel', 0]]), 'I just feel'],
  ];
  for (const [results, want] of cases) assert.equal(assemble(results), want);
  assert.equal(mergePiece('', ''), '');
  assert.equal(fixName('Hi Dr. emoji, how are you', 'Dr. Mochi'), 'Hi Dr. Mochi, how are you');
  assert.equal(fixName('hi doctor moshi', 'Dr. Mochi'), 'hi Dr. Mochi');
  assert.equal(fixName('Hi Dr. emoji', 'Sunny'), 'Hi Dr. emoji');
  assert.equal(fixName('I sent an emoji', 'Dr. Mochi'), 'I sent an emoji');
});
