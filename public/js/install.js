const $ = (s) => document.querySelector(s);
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios|gsa\//i.test(ua);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

if (location.protocol !== 'https:' && !isLocal) $('#warnHttp').hidden = false;
if (isStandalone) $('#inApp').hidden = false;
else if (!isIOS) {
  $('#notIphone').hidden = false;
  $('#pageUrl').textContent = location.href;
  $('#qr').src = '/install-qr.svg';
} else if (!isSafari) {
  $('#notSafari').hidden = false;
}

fetch('/api/me')
  .then((r) => r.json())
  .then(({ name }) => {
    if (!name) return;
    for (const n of document.querySelectorAll('[data-tname]')) n.textContent = name;
  })
  .catch(() => {});
