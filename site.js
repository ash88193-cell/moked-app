// Runs inside the IMS site page (same origin), so requests carry the user's session
// exactly like the site's own AJAX calls. Results go back to the app as JSON.
(function () {
  if (window.__moked) return;

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
        const key = COLS[clean(td.getAttribute('title'))] || COLS[headers[i]];
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
      return it;
    });
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
    return { total: total === null ? items.length : total, items, truncated: total !== null && items.length < total };
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
    let out;
    try {
      const fn = { list, detail, options, status, prepareUpdate, referral }[method];
      if (!fn) throw new Error('unknown method ' + method);
      out = { ok: true, data: await fn(args) };
    } catch (e) {
      if (e instanceof AuthError) formCache = null;
      out = { ok: false, auth: e instanceof AuthError, error: String(e && e.message || e) };
    }
    if (window.MokedBridge) window.MokedBridge.done(reqId, JSON.stringify(out));
    return out;
  }

  window.__moked = { run, list, detail, options, status, prepareUpdate, referral };
})();
