// PC test harness: injected into a logged-in IMS tab in Chrome. Shows the app screens in a
// phone-sized frame with real data. Never writes to the site: closeCase only reports, and
// share/copy are logged instead of sent.
(async () => {
  const BASE = window.__HARNESS_BASE || 'https://ash88193-cell.github.io/moked-app/';
  const get = (f) => fetch(BASE + f + '?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.text());
  const [html, siteJs] = await Promise.all([get('index.html'), get('site.js')]);

  delete window.__moked;
  (0, eval)(siteJs);

  window.__harnessLog = [];
  const log = (m, a) => window.__harnessLog.push({ t: new Date().toISOString().slice(11, 19), m, a });

  const reply = (win, id, obj) => win.onNative(id, JSON.stringify(obj));
  window.__harnessCall = async (id, method, argsJson, win) => {
    const a = JSON.parse(argsJson || 'null') || {};
    log(method, method === 'share' || method === 'copy' ? { text: a.text, images: a.images } : a);
    try {
      let data = null;
      switch (method) {
        case 'list': case 'detail': case 'options':
          data = await window.__moked[method](method === 'detail' ? a.id || a : a); break;
        case 'start':
          data = { loggedIn: window.__moked.status().loggedIn, needsUser: false, savedUser: 'בדיקה' }; break;
        case 'status': data = window.__moked.status(); break;
        case 'settings':
          data = { notify: true, slots: '06:00, 10:00, 14:00, 18:00', lastCheckAt: Date.now(),
            lastCheckMsg: 'מצב בדיקה במחשב', savedUser: 'בדיקה' }; break;
        case 'pickPhoto':
          data = { thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#8BC"/></svg>') }; break;
        case 'closeCase':
          return reply(win, id, { ok: false, error: 'מצב בדיקה במחשב – הסגירה לא נשלחת' });
        default: data = null; // share, copy, showSite, setNotify, checkNow, testNotify, logout
      }
      reply(win, id, { ok: true, data });
    } catch (e) {
      reply(win, id, { ok: false, auth: String(e && e.message) === 'auth', error: String(e && e.message || e) });
    }
  };

  const shim = '<script>window.Native={call:function(i,m,a){parent.__harnessCall(i,m,a,window)}};<\/script>';
  const doc = html.replace('<script>', shim + '<script>');

  document.getElementById('__harness') && document.getElementById('__harness').remove();
  const wrap = document.createElement('div');
  wrap.id = '__harness';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#333;display:flex;justify-content:center;align-items:flex-start;padding-top:8px';
  const frame = document.createElement('iframe');
  frame.id = '__harnessFrame';
  frame.style.cssText = 'width:390px;height:calc(100vh - 16px);max-height:844px;border:0;border-radius:18px;background:#fff';
  frame.srcdoc = doc;
  wrap.appendChild(frame);
  document.body.appendChild(wrap);
  return 'harness ready';
})();
