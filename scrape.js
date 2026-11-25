// مِسَار — يدخل فنار، يقرأ أوامر الصرف، ويكتب site/data.json مشفّر.
// تنبيه: سجلات GitHub Actions قد تكون مكشوفة، لذلك ما نطبع أي بيانات فواتير، فقط أعداد.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KDF_ITERATIONS, deriveRecord, encryptJSON, normText, toLatinDigits,
} from '../site/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(process.env.MASAR_CONFIG || path.join(ROOT, 'config.json'), 'utf8'));
const DEBUG = process.env.MASAR_DEBUG === '1';
const DEBUG_DIR = path.join(ROOT, 'debug');
const OUT = process.env.MASAR_OUT || path.join(ROOT, 'site', 'data.json');

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`المتغير ${name} غير موجود. أضفه في Settings → Secrets → Actions.`);
  return v;
}

const log = (...a) => console.log('[مسار]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- وضع الفحص: نحفظ هيكل الصفحة بدون أي بيانات ----------
async function dumpStructure(page, name) {
  if (!DEBUG) return;
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const keepWords = [...Object.values(config.fields || {}), ...(config.orders?.tabs || []),
    config.orders?.showDetailsText, config.orders?.hideDetailsText].filter(Boolean);
  const skeleton = await page.evaluate((keepWords) => {
    const KEEP_WORDS = new Set(keepWords);
    const KEEP_TEXT = new Set(['TH', 'LABEL', 'BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'OPTION', 'LEGEND']);
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, svg, noscript, img, link, meta').forEach((n) => n.remove());
    clone.querySelectorAll('input, textarea').forEach((n) => { n.removeAttribute('value'); n.textContent = ''; });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      const parent = t.parentElement;
      const raw = t.textContent.trim().replace(/[:：]$/, '').trim();
      const keep = KEEP_WORDS.has(raw) || (parent && KEEP_TEXT.has(parent.tagName) && !parent.closest('td') && !/\d{3,}/.test(raw));
      if (!t.textContent.trim()) continue;
      t.textContent = keep ? t.textContent.trim().slice(0, 40) : '•';
    }
    // نحذف الخصائص اللي ممكن تحمل بيانات
    clone.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (/^(title|alt|href|data-(?!testid|test|col|field|name))/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    });
    return clone.outerHTML;
  }, keepWords);
  const file = path.join(DEBUG_DIR, `${name}.html`);
  await fs.writeFile(file, `<!-- URL path: ${new URL(page.url()).pathname} -->\n${skeleton}`);
  log(`حُفظ هيكل الصفحة (بدون بيانات): debug/${name}.html`);
}

// ---------- رمز التحقق عبر GitHub Issue ----------
async function gh(apiPath, opts = {}) {
  const repo = need('GITHUB_REPOSITORY');
  const res = await fetch(`https://api.github.com/repos/${repo}${apiPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${need('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function askForOtp() {
  const owner = process.env.GITHUB_REPOSITORY_OWNER || '';
  const minutes = config.otp.waitMinutes || 8;
  const issue = await gh('/issues', {
    method: 'POST',
    body: JSON.stringify({
      title: '🔐 مِسَار يحتاج رمز التحقق من فنار',
      body: `${owner ? `@${owner} ` : ''}فنار طلب رمز تحقق.\n\nاكتب الرمز اللي وصلك **كتعليق هنا** خلال ${minutes} دقائق، والأداة تكمل لحالها.`,
    }),
  });
  log(`أُنشئت تذكرة لطلب الرمز: #${issue.number}`);
  const deadline = Date.now() + minutes * 60_000;
  try {
    while (Date.now() < deadline) {
      await sleep(10_000);
      const comments = await gh(`/issues/${issue.number}/comments`);
      for (const c of comments) {
        if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association)) continue;
        const m = toLatinDigits(c.body).match(/\b\d{4,8}\b/);
        if (m) return m[0];
      }
    }
    throw new Error('ما وصل رمز التحقق في الوقت المحدد.');
  } finally {
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }).catch(() => {});
  }
}

// ---------- الدخول ----------
async function firstVisible(page, selector, timeout) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  await loc.waitFor({ state: 'visible', timeout });
  return loc;
}

async function login(page) {
  log('فتح صفحة الدخول…');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await dumpStructure(page, '1-login');
  const loginHref = page.url();

  await (await firstVisible(page, config.login.username, 30_000)).fill(need('FANAR_USER'));
  await (await firstVisible(page, config.login.password, 10_000)).fill(need('FANAR_PASS'));
  await (await firstVisible(page, config.login.submit, 10_000)).click();

  const loggedIn = config.login.loggedInSelector
    ? page.locator(config.login.loggedInSelector).first().waitFor({ timeout: 45_000 })
    : page.waitForURL((u) => u.href !== loginHref, { timeout: 45_000 });

  const result = await Promise.any([
    loggedIn.then(() => 'ok'),
    page.locator(config.otp.input).filter({ visible: true }).first().waitFor({ timeout: 45_000 }).then(() => 'otp'),
  ]).catch(() => 'fail');

  if (result === 'fail') {
    await dumpStructure(page, '1b-login-failed');
    throw new Error('فشل تسجيل الدخول. تأكد من اسم المستخدم وكلمة المرور، أو شغّل وضع الفحص.');
  }
  if (result === 'otp') {
    log('فنار طلب رمز تحقق…');
    await dumpStructure(page, '1c-otp');
    const code = await askForOtp();
    await (await firstVisible(page, config.otp.input, 10_000)).fill(code);
    const submit = page.locator(config.otp.submit).filter({ visible: true }).first();
    if (await submit.count()) await submit.click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(3000);
  }
  log('تم الدخول.');
}

// ---------- قراءة بطاقات أوامر الصرف ----------
const O = config.orders;
const F = config.fields;
const LABELS = Object.values(F);
let detailsDumped = false;

// في وضع الفحص: نسجّل شكل ردود الـ API (أسماء الحقول وأنواعها فقط، بدون قيم)
const apiShapes = {};
function shapeOf(v, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [`len=${v.length}`, shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return v === null ? 'null' : typeof v;
}
function watchApi(page) {
  if (!DEBUG) return;
  page.on('response', async (res) => {
    try {
      if (!/json/i.test(res.headers()['content-type'] || '')) return;
      const u = new URL(res.url());
      apiShapes[`${res.request().method()} ${u.pathname}`] = shapeOf(await res.json());
    } catch { /* تجاهل */ }
  });
}

async function countToggles(page) {
  return page.evaluate((o) => [...document.querySelectorAll('button, a, [role=button]')]
    .filter((b) => { const t = b.innerText || ''; return t.includes(o.showDetailsText) || t.includes(o.hideDetailsText); }).length, O);
}

async function loadAllCards(page) {
  let last = -1;
  let stable = 0;
  for (let k = 0; k < 300 && stable < 3; k++) {
    const n = await countToggles(page);
    if (n === last) stable++; else { stable = 0; last = n; }
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('*').forEach((el) => { if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight; });
      window.dispatchEvent(new Event('scroll'));
    });
    const more = page.getByRole('button', { name: /عرض المزيد|تحميل المزيد|المزيد/ }).first();
    if ((await more.count()) && (await more.isVisible())) await more.click().catch(() => {});
    await sleep(700);
  }
  return last;
}

async function clickTab(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || '').replace(/[0-9٠-٩]/g, '').replace(/\s+/g, ' ').trim();
    const btn = [...document.querySelectorAll('button, [role=tab], a')].find((b) => norm(b.innerText) === norm(label));
    if (!btn) return { found: false };
    const m = (btn.innerText || '').match(/[0-9]+/);
    btn.click();
    return { found: true, count: m ? Number(m[0]) : null };
  }, label);
}

async function dumpFirstDetails(page) {
  if (!DEBUG || detailsDumped) return;
  detailsDumped = true;
  const btn = page.getByText(O.showDetailsText, { exact: false }).first();
  if (!(await btn.count())) return;
  await btn.click().catch(() => {});
  await sleep(2500);
  await dumpStructure(page, '3-details');
  const hide = page.getByText(O.hideDetailsText, { exact: false }).first();
  if (await hide.count()) await hide.click().catch(() => {});
  await sleep(500);
}

// يفتح تفاصيل كل بطاقة ويقرأ الخانات حسب عناوينها (مو حسب تصميم الصفحة)
async function readCards(page, deadline) {
  await dumpFirstDetails(page);
  return page.evaluate(async ({ o, labels, deadline }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const toggles = () => [...document.querySelectorAll('button, a, [role=button]')]
      .filter((b) => { const t = b.innerText || ''; return t.includes(o.showDetailsText) || t.includes(o.hideDetailsText); });
    const cardOf = (btn) => {
      let el = btn;
      while (el.parentElement && !(el.innerText || '').includes(o.cardMarker)) el = el.parentElement;
      return el;
    };
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // نقرأ كل خانة من أصغر عنصر يحمل عنوانها، سواء كانت "العنوان: القيمة" أو عنوان وتحته القيمة
    const extract = (card) => {
      const els = [card, ...card.querySelectorAll('*')];
      const texts = els.map((e) => (e.innerText || '').trim());
      const out = {};
      for (const lab of labels) {
        const re = new RegExp(`^${esc(lab)}\\s*[:：]\\s*([^\\n]+)`);
        let best = null;
        const offer = (v) => {
          v = (v || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
          if (v && (best === null || v.length < best.length)) best = v;
        };
        els.forEach((e, i) => {
          const t = texts[i];
          if (!t || t.length > 400) return;
          if (t === lab || t === `${lab}:` || t === `${lab} :`) {
            const sib = e.nextElementSibling && (e.nextElementSibling.innerText || '').trim();
            if (sib) return offer(sib);
            const p = (e.parentElement && e.parentElement.innerText || '').trim();
            if (p.startsWith(lab)) offer(p.slice(lab.length).replace(/^[\s:：]+/, ''));
            return;
          }
          const m = t.match(re);
          if (m) offer(m[1]);
        });
        if (best !== null) out[lab] = best;
      }
      return out;
    };
    const results = [];
    let failed = 0;
    let timedOut = false;
    const n = toggles().length;
    for (let i = 0; i < n; i++) {
      if (Date.now() > deadline) { timedOut = true; break; }
      const btn = toggles()[i];
      if (!btn) break;
      if (!cardOf(btn).innerText.includes(o.detailsMarker)) {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        for (let w = 0; w < 60; w++) {
          const t = toggles()[i];
          if (t && cardOf(t).innerText.includes(o.detailsMarker)) break;
          await sleep(150);
        }
      }
      const t = toggles()[i];
      if (!t) break;
      const card = cardOf(t);
      if (!card.innerText.includes(o.detailsMarker)) failed++;
      results.push(extract(card));
      if ((t.innerText || '').includes(o.hideDetailsText)) t.click();
      await sleep(40);
    }
    return { results, failed, timedOut, total: n };
  }, { o: O, labels: LABELS, deadline });
}

function toRecord(d, tab) {
  const r = {};
  for (const [key, label] of Object.entries(F)) r[key] = d[label] ?? '';
  if (!r.status) r.status = tab || '';
  return r;
}

async function readAllOrders(page) {
  watchApi(page);
  log('فتح صفحة أوامر الصرف…');
  await page.goto(config.ordersUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(2000);
  await dumpStructure(page, '2-orders');

  const deadline = Date.now() + (O.maxMinutes || 20) * 60_000;
  const byId = new Map();
  let usedTabs = false;

  const collect = async (tab) => {
    await loadAllCards(page);
    const res = await readCards(page, deadline);
    res.results.forEach((d, i) => {
      const rec = toRecord(d, tab);
      byId.set(rec.orderNo || `${tab}#${i}`, rec);
    });
    log(`${tab || 'الصفحة'}: ${res.results.length} أمر${res.failed ? ` (${res.failed} ما انفتحت تفاصيلها)` : ''}`);
    return res.timedOut;
  };

  for (const tab of O.tabs || []) {
    if (Date.now() > deadline) { log('انتهى الوقت المسموح، نكمل باللي انقرأ.'); break; }
    const r = await clickTab(page, tab);
    if (!r.found) { log(`ما لقيت تبويب: ${tab}`); continue; }
    usedTabs = true;
    if (r.count === 0) { log(`${tab}: 0`); continue; }
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
    if (await collect(tab)) { log('انتهى الوقت المسموح، نكمل باللي انقرأ.'); break; }
  }
  if (!usedTabs) await collect('');

  if (DEBUG) {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(path.join(DEBUG_DIR, 'api-shapes.json'), JSON.stringify(apiShapes, null, 2));
    const all = [...byId.values()];
    const filled = Object.fromEntries(Object.keys(F).map((k) => [k, all.filter((r) => r[k]).length]));
    log(`الخانات المقروءة (عدد الأوامر اللي فيها قيمة): ${JSON.stringify(filled)}`);
  }
  return [...byId.values()];
}

// ---------- بناء الملف المشفّر ----------
async function build(orders) {
  const salt = need('MASAR_SALT');
  const records = {};
  let skipped = 0;
  for (const o of orders) {
    const d = await deriveRecord(salt, o.company, o.amount);
    if (!d) { skipped++; continue; }
    const payload = {
      status: o.status, updated: o.updated, orderNo: o.orderNo, description: o.description, department: o.department,
    };
    (records[d.id] ||= []).push(await encryptJSON(d.key, payload));
  }
  const data = { v: 2, salt, iterations: KDF_ITERATIONS, updatedAt: new Date().toISOString(), records };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data));
  log(`تم: ${orders.length - skipped} أمر صرف مشفّر${skipped ? `، وتُجاهل ${skipped} ناقص اسم الشركة أو المبلغ` : ''}.`);
}

// ---------- التشغيل ----------
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: 'ar-SA', timezoneId: 'Asia/Riyadh', viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  if (!process.env.MASAR_SKIP_LOGIN) await login(page);
  let orders = await readAllOrders(page);
  if (!orders.length) throw new Error('ما انقرأ أي أمر صرف — ما راح نحدّث الصفحة عشان ما تنمسح البيانات القديمة.');
  const only = config.onlyMaintenance;
  if (only?.field && only.contains?.length) {
    const wanted = only.contains.map(normText);
    const total = orders.length;
    orders = orders.filter((o) => {
      const v = normText(o[only.field]);
      return v && wanted.some((w) => v.includes(w));
    });
    log(`بند الصيانة: ${orders.length} من أصل ${total} أمر صرف.`);
    if (!orders.length) throw new Error('ما لقيت أي أمر صرف فيه صيانة في «بيانات الصرف». ما راح نحدّث الصفحة.');
  }
  await build(orders);
} catch (err) {
  console.error('[مسار] خطأ:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
