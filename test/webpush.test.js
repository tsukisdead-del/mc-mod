import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import ece from 'http_ece';
import { generateVapidKeys, sendWebPush, b64url, fromB64url } from '../worker/webpush.js';

// Plays the browser: makes subscription keys, receives the push, and decrypts it with the
// reference implementation (http_ece, the library the web-push package itself uses).
test('push messages decrypt with the reference implementation and carry a valid VAPID JWT', async () => {
  const browser = nodeCrypto.createECDH('prime256v1');
  browser.generateKeys();
  const authSecret = nodeCrypto.randomBytes(16);

  let received;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const endpoint = `http://localhost:${server.address().port}/push/abc`;

  const vapid = await generateVapidKeys();
  const subscription = { endpoint, keys: { p256dh: b64url(browser.getPublicKey()), auth: b64url(authSecret) } };
  const message = { title: 'Dr. Mochi', body: 'hey, how are you doing today? 💛', tag: 'checkin' };
  const result = await sendWebPush(subscription, message, { vapid, subject: 'mailto:test@example.org', topic: 'check-in!' });
  server.close();

  assert.equal(result.ok, true);
  assert.equal(received.headers['content-encoding'], 'aes128gcm');
  assert.equal(received.headers.topic, 'check-in');
  assert.ok(Number(received.headers.ttl) > 0);

  const plain = ece.decrypt(received.body, { version: 'aes128gcm', privateKey: browser, authSecret });
  assert.deepEqual(JSON.parse(plain.toString('utf8')), message);

  // Authorization: vapid t=<jwt>, k=<public key>
  const [, jwt, k] = received.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [h, p, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(fromB64url(p)).toString());
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(claims.sub, 'mailto:test@example.org');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  const pub = fromB64url(vapid.publicKey);
  const key = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)) }, format: 'jwk' });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(sig))));
});

test('VAPID keys interoperate with the web-push package format', async () => {
  const webpush = (await import('web-push')).default;
  const keys = await generateVapidKeys();
  // web-push validates lengths/encodings of both keys; this throws if the format is wrong.
  webpush.setVapidDetails('mailto:test@example.org', keys.publicKey, keys.privateKey);
  assert.equal(fromB64url(keys.publicKey).length, 65);
  assert.equal(fromB64url(keys.privateKey).length, 32);
});
