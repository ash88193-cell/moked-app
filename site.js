// Runs inside the IMS site page (same origin), so requests carry the user's session
// exactly like the site's own AJAX calls. Results go back to the app as JSON.
(function () {
  if (window.__moked) return;

  // Bump on every change: an open site page swaps itself to a newer published copy.
  const VERSION = '2026-11-27.1';
  const SELF_URL = 'https://ash88193-cell.github.io/moked-app/site.js';
  let checkedAt = 0;

  async function newerSelf() {
    if (Date.now() - checkedAt < 60000) return null;
    checkedAt = Date.now();
    try {
      const r = await fetch(SELF_URL + '?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
      const code = r.ok ? await r.text() : '';
      const m = code.match(/const VERSION = '([^']+)'/);
      return code.includes('window.__moked') && m && m[1] !== VERSION ? code : null;
    } catch (e) { return null; }
  }

  const LIST_PAGE = '/ims/system/?view=custom&module=moked-list';
  const ITEMS_URL = '/ims/customs/moked-list/ajax.items.php';
  const parser = new DOMParser();
  let formCache = null;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isLoginPage = (html) => html.includes('id="login_frm"') || html.includes("id='login_frm'");

  class AuthError extends Error {}

  async function getHtml(url, opts) {
    const r = await fetch(url, Object.assign({ credentials: 'include' }, opts));
    const html = await r.text();
    if (isLoginPage(html) || (r.redirected && !new URL(r.url).pathname.startsWith('/ims/'))) {
      throw new AuthError('auth');
    }
    return html;
  }

  async function loadForm() {
    if (formCache) return formCache;
    const doc = parser.parseFromString(await getHtml(LIST_PAGE), 'text/html');
    const form = [...doc.forms].find((f) => f.elements['status[]']);
    if (!form) throw new Error('טופס החיפוש לא נמצא');
    const defaults = [];
    const options = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.tagName === 'SELECT') {
        if (el.multiple) {
          options[el.name.replace('[]', '')] = [...el.options]
            .filter((o) => !['all', 'select-all'].includes(o.value))
            .map((o) => ({ v: o.value, t: clean(o.text) }));
        } else {
          defaults.push([el.name, el.value]);
        }
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) defaults.push([el.name, el.value]);
      } else if (el.type !== 'submit' && el.type !== 'button') {
        defaults.push([el.name, el.value]);
      }
    }
    formCache = { defaults, options };
    return formCache;
  }

  function slaOf(td) {
    const m = clean(td && td.textContent).match(/(-?\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  }

  // Column order can change with the user's display settings, so cells are mapped by header text.
  const COLS = {
    'מס\' פניה': 'id', 'תאריך ושעת פתיחה': 'opened', 'תאריך פתיחה': 'opened', 'סטטוס פנייה': 'status',
    'שם הפונה': 'name', 'טלפון נייד': 'phone', 'כתובת ואתר/מוסד': 'address', 'מחלקה': 'department',
    'נושא': 'subject', 'מדד SLA לפני חריגה': 'sla', 'תיאור': 'description', 'גורם מטפל': 'handler',
    'מקור פניה': 'source', 'מוקדן': 'opener', 'תמונות ומסמכים?': 'files',
  };

  // Loose matching for column names that differ between devices.
  const FUZZY = [
    [/מס.?\s*פני/, 'id'], [/תאריך.*פתיח|נפתח/, 'opened'], [/סטטוס/, 'status'], [/שם\s*(ה)?פונה|^פונה$/, 'name'],
    [/טלפון|נייד/, 'phone'], [/כתובת|רחוב|מיקום/, 'address'], [/מחלק/, 'department'], [/SLA/i, 'sla'],
    [/תיאור/, 'description'], [/נושא|סיווג/, 'subject'], [/יעד/, 'due'], [/גורם\s*מטפל/, 'handler'], [/מקור/, 'source'], [/מוקדן/, 'opener'],
  ];
  function colKey(name) {
    name = clean(name);
    if (!name) return null;
    if (COLS[name]) return COLS[name];
    const hit = FUZZY.find(([re]) => re.test(name));
    return hit ? hit[1] : null;
  }
  let lastDiag = null;

  // "09/11/26 14:15", "09/11/2026", "2026-11-09 14:15" -> ms
  function parseDate(s) {
    let m = String(s).match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})(?:\D+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return new Date(y, m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime();
    }
    m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:\D+(\d{1,2}):(\d{2}))?/);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : null;
  }

  function parseRows(html, headers) {
    const doc = parser.parseFromString('<table>' + html + '</table>', 'text/html');
    const total = doc.querySelector('#total_applications');
    const ths = [...doc.querySelectorAll('#list-table thead th')].map((th) => clean(th.textContent));
    if (ths.length) headers = ths;
    const items = [...doc.querySelectorAll('tr[id^="itemTr"]')].map((tr) => {
      const it = { id: tr.id.replace('itemTr', '') };
      [...tr.children].forEach((td, i) => {
        // Each cell carries its column name in title; header position is only a fallback
        // (on the phone the header row does not line up with the cells).
        // A cell's own title wins; header position is used only when the cell has no title
        // (in the phone layout the header row does not line up with the cells).
        const own = clean(td.getAttribute('title') || td.getAttribute('data-title'));
        const key = own ? colKey(own) : colKey(headers[i]);
        if (!key || key === 'id') return;
        if (key === 'sla') it.sla = slaOf(td);
        else if (key === 'status') {
          it.status = clean(td.textContent);
          const s = td.querySelector('.status-str');
          it.statusColor = s ? s.style.backgroundColor : '';
        } else if (key === 'phone') {
          const a = td.querySelector('a[href^="tel:"]');
          it.phone = a ? a.getAttribute('href').slice(4) : clean(td.textContent);
        } else if (key === 'subject') {
          it.subject = clean(td.textContent).replace(/\s*\\\s*/g, '/');
        } else it[key] = clean(td.textContent);
      });
      // The phone layout's "סיווג" starts with the department name ("מנהלי אזור"); drop it.
      if (it.subject) it.subject = it.subject.replace(/^\s*מנהלי\s+א[וי]?זור[\s\-–>›»\/:|,]*/, '').trim() || it.subject;
      // The phone layout has no SLA column, only opened + due dates: SLA = share of the time used.
      if (it.sla == null && it.opened && it.due) {
        const o = parseDate(it.opened), d = parseDate(it.due);
        if (o && d && d > o) { it.sla = Math.round(((Date.now() - o) / (d - o)) * 100); it.slaComputed = true; }
      }
      return it;
    });
    const first = doc.querySelector('tr[id^="itemTr"]');
    if (first) {
      // What this device actually receives, for the diagnostics screen (no resident data: lengths only).
      lastDiag = {
        headers,
        cells: [...first.children].map((td, i) => ({
          title: clean(td.getAttribute('title')), header: headers[i] || '', key: (clean(td.getAttribute('title')) ? colKey(td.getAttribute('title')) : colKey(headers[i])) || '',
          len: clean(td.textContent).length, tags: [...td.querySelectorAll('*')].slice(0, 4).map((e) => e.tagName.toLowerCase()).join(','),
        })),
      };
    }
    return { total: total ? parseInt(total.value, 10) : null, items, headers };
  }

  // params: { status: [...], subSubject: [...], neighborhood: [...], dateStart, dateEnd,
  //           dateStart_close, dateEnd_close, description, num, maxPages }
  async function list(params) {
    const { defaults } = await loadForm();
    const base = new URLSearchParams();
    for (const [k, v] of defaults) if (!k.endsWith('[]')) base.append(k, v);
    for (const [k, v] of Object.entries(params || {})) {
      if (k === 'maxPages') continue;
      if (Array.isArray(v)) {
        base.delete(k + '[]');
        v.forEach((x) => base.append(k + '[]', x));
      } else if (v !== undefined && v !== null) base.set(k, v);
    }
    const maxPages = (params && params.maxPages) || 30;
    let headers = [];
    let total = null;
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = new URLSearchParams(base);
      if (page > 1) body.set('page', String(page));
      const html = await getHtml(ITEMS_URL + '?time=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: body.toString(),
      });
      const res = parseRows(html, headers);
      headers = res.headers;
      if (res.total !== null) total = res.total;
      items.push(...res.items);
      if (!res.items.length || (total !== null && items.length >= total)) break;
    }
    await fixClosedSla(items, params || {});
    return { total: total === null ? items.length : total, items, truncated: total !== null && items.length < total, diag: lastDiag, siteVersion: VERSION };
  }

  // The phone layout has no SLA column, so SLA is computed from the dates. For a closed case the
  // clock stops at the close time, which only the case page shows ("תאריך סגירה/הסתרה").
  const CLOSED_RE = /סגור|לא נמצאה|החלט|הקפא|תכנית/;
  const closeCache = {};
  async function closeTime(id) {
    const key = 'mokedClose:' + id;
    if (closeCache[id]) return closeCache[id];
    try { const s = localStorage.getItem(key); if (s) return (closeCache[id] = s); } catch (e) {}
    const html = await getHtml('/ims/system/?view=custom&module=moked-page&id=' + encodeURIComponent(id));
    const m = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/תאריך סגירה\/הסתרה:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2})/);
    if (!m) return null;
    closeCache[id] = m[1];
    try { localStorage.setItem(key, m[1]); } catch (e) {}
    return m[1];
  }
  async function fixClosedSla(items, params) {
    const closedQuery = (params.status || []).includes('-2') || !!params.dateStart_close;
    const todo = items.filter((it) => it.slaComputed && (closedQuery || CLOSED_RE.test(it.status || ''))).slice(0, 60);
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (it) => {
        try {
          const c = parseDate(await closeTime(it.id)), o = parseDate(it.opened), d = parseDate(it.due);
          if (c && o && d && d > o) { it.sla = Math.round(((c - o) / (d - o)) * 100); it.closedAt = c; }
        } catch (e) {}
      }));
    }
  }

  // Weekly summary: everything opened and everything closed between two times (ms).
  // Every closed case gets its close time (case page, cached) and its SLA share at closing.
  const isoDay = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const KEEP = ['id', 'subject', 'address', 'status', 'statusColor', 'opened', 'due', 'sla', 'name', 'phone', 'closedAt'];
  const slim = (it) => { const o = {}; KEEP.forEach((k) => { if (it[k] != null) o[k] = it[k]; }); o.openedAt = parseDate(it.opened); return o; };
  async function weekly(a) {
    const from = +a.from, to = +(a.to || Date.now());
    const end = isoDay(to + 864e5); // the site's end date may be exclusive
    const closedRes = await list({ status: ['-2'], dateStart_close: isoDay(from), dateEnd_close: end, maxPages: 80 });
    const openedRes = await list({ status: [], dateStart: isoDay(from), dateEnd: end, maxPages: 80 });
    const todo = closedRes.items.filter((it) => !it.closedAt);
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (it) => {
        try {
          const c = parseDate(await closeTime(it.id));
          if (!c) return;
          it.closedAt = c;
          const o = parseDate(it.opened), d = parseDate(it.due);
          if (o && d && d > o) it.sla = Math.round(((c - o) / (d - o)) * 100);
        } catch (e) { if (e instanceof AuthError) throw e; }
      }));
    }
    const closed = closedRes.items.filter((it) => it.closedAt && it.closedAt >= from && it.closedAt < to).map(slim);
    const opened = openedRes.items.map(slim).filter((it) => it.openedAt && it.openedAt >= from && it.openedAt < to);
    return {
      from, to, closed, opened,
      noCloseTime: closedRes.items.filter((it) => !it.closedAt).length,
      truncated: closedRes.truncated || openedRes.truncated,
    };
  }

  // Hides the resident's details on the page about to be photographed: the text itself is
  // replaced (so nothing can be recovered from the image) and the spot is blurred.
  // Synchronous; returns how many places were hidden.
  function mask(a) {
    a = a || {};
    const LETTER = 'A-Za-z֐-׿';
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [];
    const name = clean(a.name);
    if (name) {
      parts.push(escRe(name).replace(/ /g, '\\s+'));
      const w = name.split(' ');
      if (w.length > 1) parts.push(escRe([...w].reverse().join(' ')).replace(/ /g, '\\s+'));
    }
    const digits = String(a.phone || '').replace(/\D/g, '').replace(/^972/, '0');
    if (digits.length >= 7) parts.push(digits.split('').map(escRe).join('[\\s\\-]?'));
    // Any Israeli phone number, with or without dashes / +972.
    parts.push('(?:\\+?972[\\s\\-]?|0)(?:5\\d|7\\d|[23489])[\\s\\-]?\\d{3}[\\s\\-]?\\d{4}');
    const re = new RegExp('(?<![' + LETTER + '0-9])(?:' + parts.join('|') + ')(?![' + LETTER + '0-9])', 'g');
    const dots = (s) => s.replace(/\S/g, '●');

    if (!document.getElementById('__mkStyle')) {
      const st = document.createElement('style');
      st.id = '__mkStyle';
      st.textContent = '.__mk{filter:blur(5px)!important;-webkit-user-select:none}';
      (document.head || document.documentElement).appendChild(st);
    }
    let n = 0;
    const hide = (el) => { if (el && el.nodeType === 1 && !el.classList.contains('__mk')) { el.classList.add('__mk'); n++; } };
    const hideText = (el) => {
      if (!el) return;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) t.nodeValue = dots(t.nodeValue);
      hide(el);
    };

    // 1. The name / phone wherever it appears in the text.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let t; (t = walker.nextNode());) {
      const p = t.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
      re.lastIndex = 0;
      if (re.test(t.nodeValue)) hits.push(t);
    }
    hits.forEach((t) => {
      re.lastIndex = 0;
      t.nodeValue = t.nodeValue.replace(re, dots);
      hide(t.parentElement);
    });
    // 2. Phone links and form fields.
    document.querySelectorAll('a[href^="tel:"], a[href^="mailto:"], a[href*="wa.me"], a[href*="whatsapp"]').forEach((el) => {
      el.removeAttribute('href'); hideText(el);
    });
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.type === 'hidden' || !el.value) return;
      re.lastIndex = 0;
      if (re.test(el.value) || /phone|tel|mobile|fname|lname|name|email|tz/i.test(el.name + ' ' + el.id)) {
        el.value = dots(el.value); hide(el);
      }
    });
    // 3. "Label: value" pairs about the resident (name, phone, ID, e-mail).
    const LABEL = /^(שם\s*(ה)?פונה|שם\s*פרטי|שם\s*משפחה|שם\s*מלא|טלפון(\s*\S+)?|נייד|טל['׳]?|ת\.?\s*ז\.?|תעודת\s*זהות|דוא["״]?ל|אימייל|מייל|e-?mail)\s*:?$/i;
    document.querySelectorAll('body *').forEach((el) => {
      if (el.children.length > 2 || el.classList.contains('__mk')) return;
      const own = clean([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join(' '));
      const all = clean(el.textContent);
      if (LABEL.test(all)) {
        // The label alone: the value is the next cell / element.
        let v = el.nextElementSibling;
        if (!v && el.parentElement && el.parentElement.children.length <= 3) v = el.parentElement.nextElementSibling;
        if (v && clean(v.textContent).length < 80) hideText(v);
        let s = el.nextSibling;
        while (s && s.nodeType === 3 && !clean(s.nodeValue)) s = s.nextSibling;
        if (s && s.nodeType === 3) { s.nodeValue = dots(s.nodeValue); hide(el.parentElement); }
      } else if (own) {
        const m = own.match(/^(שם\s*(ה)?פונה|שם\s*מלא|טלפון(\s*נייד)?|נייד|ת\.?\s*ז\.?|דוא["״]?ל)\s*:\s*(.+)$/i);
        if (m && own.length < 80) hideText(el);
      }
    });
    return n;
  }

  async function detail(id) {
    const doc = parser.parseFromString(await getHtml('/ims/system/?view=custom&module=moked-page&id=' + encodeURIComponent(id)), 'text/html');
    const box = doc.querySelector('#container_description');
    if (box) box.querySelector('h2') && box.querySelector('h2').remove();
    return { id, description: clean(box && box.textContent) };
  }

  async function options() {
    const { options } = await loadForm();
    return options;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms) {
    for (let t = 0; t < ms; t += 250) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  // Opens the site's own "הוספת עדכון טיפול" popup and fills it in. It never submits:
  // the user checks the form and presses the site's own button, so all the site's checks
  // (photo, location) run as usual.
  async function prepareUpdate(a) {
    if (!window.jQuery) throw new Error('not ready');
    const id = String(a.id).replace(/\D/g, '');
    const old = document.getElementById('add-history');
    if (old) jQuery.magnificPopup && jQuery.magnificPopup.close();
    await waitFor(() => !document.getElementById('add-history'), 3000);
    const link = document.createElement('a');
    link.className = 'ajax-open';
    link.style.display = 'none';
    link.href = '/ims/customs/ajax/add.history.php?id=' + id + '&status_container=status_container' + id;
    document.body.appendChild(link);
    link.click();
    const form = await waitFor(() => document.getElementById('add-history'), 20000);
    link.remove();
    if (!form) throw new Error('טופס העדכון לא נפתח');
    if (form.elements['id'] && form.elements['id'].value !== id) throw new Error('נפתח טופס של פנייה אחרת');

    const st = form.elements['statusId'];
    if (![...st.options].some((o) => o.value === String(a.status))) throw new Error('הסטטוס לא קיים באתר');
    jQuery(st).val(String(a.status)).trigger('change');
    if (a.text) jQuery(form.elements['do2']).val(a.text).trigger('input').trigger('change');

    if (a.photo) {
      const bin = atob(a.photo);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], a.photoName || 'photo.jpg', { type: 'image/jpeg' });
      const input = form.elements['file1'];
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      jQuery(input).trigger('change'); // the site's own upload handler
      const uploaded = await waitFor(() => form.elements['file_url1'].value, 60000);
      if (!uploaded) throw new Error('העלאת התמונה לא הסתיימה');
    }
    const send = document.getElementById('send');
    if (send) send.scrollIntoView({ block: 'center' });
    return { ready: true };
  }

  // Switches the open form to "return to the call center" with the given text (site's own button).
  async function referral(a) {
    const form = document.getElementById('add-history');
    if (!form) throw new Error('טופס העדכון לא פתוח');
    jQuery('#referral').trigger('click');
    await sleep(400);
    jQuery(form.elements['do2']).val(a.text).trigger('input').trigger('change');
    const send = document.getElementById('send');
    if (send) send.scrollIntoView({ block: 'center' });
    return { ready: true };
  }

  // Let the app know about the site's messages (e.g. the location check) while the user closes a case.
  if (!window.__alertHooked) {
    window.__alertHooked = true;
    const orig = window.alert;
    window.alert = function (msg) {
      try { window.MokedBridge && window.MokedBridge.alert(String(msg)); } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  function status() {
    // A 2FA step has no login form either, so only the logout link proves a full session.
    return { loggedIn: !!document.querySelector('a[href*="do=logout"]') };
  }

  async function run(reqId, method, args) {
    if (method === 'list') {
      const code = await newerSelf();
      if (code) {
        const old = window.__moked;
        try {
          delete window.__moked;
          (0, eval)(code);
          if (window.__moked && window.__moked.run !== run) return window.__moked.run(reqId, method, args);
        } catch (e) {}
        window.__moked = old;
      }
    }
    let out;
    try {
      const fn = { list, detail, options, status, prepareUpdate, referral, weekly }[method];
      if (!fn) throw new Error('unknown method ' + method);
      out = { ok: true, data: await fn(args) };
    } catch (e) {
      if (e instanceof AuthError) formCache = null;
      out = { ok: false, auth: e instanceof AuthError, error: String(e && e.message || e) };
    }
    if (window.MokedBridge) window.MokedBridge.done(reqId, JSON.stringify(out));
    return out;
  }

  window.__moked = { run, list, detail, options, status, prepareUpdate, referral, weekly, mask, version: VERSION };
})();
