// مِسَار — يدخل فنار، يقرأ أوامر الصرف، ويكتب site/data.json مشفّر.
// تنبيه: سجلات GitHub Actions قد تكون مكشوفة، لذلك ما نطبع أي بيانات فواتير، فقط أعداد.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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

// يضغط زر الإرسال: أولاً حسب الإعدادات، بعدين حسب النص المكتوب على الزر، وأخيراً Enter
async function submitForm(page, selector, field) {
  const byCss = page.locator(selector).filter({ visible: true }).first();
  if (await byCss.count()) return byCss.click();
  const byText = page.getByRole('button', { name: /دخول|تسجيل|متابعة|تحقق|تأكيد|إرسال|login|log in|sign in|submit|continue|verify/i })
    .filter({ visible: true }).first();
  if (await byText.count()) return byText.click();
  log('ما لقيت زر الدخول، نضغط Enter.');
  return field.press('Enter');
}

async function login(page) {
  log('فتح صفحة الدخول…');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await dumpStructure(page, '1-login');
  const loginHref = page.url();

  await (await firstVisible(page, config.login.username, 30_000)).fill(need('FANAR_USER'));
  const pass = await firstVisible(page, config.login.password, 10_000);
  await pass.fill(need('FANAR_PASS'));
  await submitForm(page, config.login.submit, pass);

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
    const otpField = await firstVisible(page, config.otp.input, 10_000);
    await otpField.fill(code);
    await submitForm(page, config.otp.submit, otpField);
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
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByText(new RegExp(`${esc(O.showDetailsText)}|${esc(O.hideDetailsText)}`)).count();
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
  await clickToggle(btn).catch(() => {});
  await sleep(2500);
  await dumpStructure(page, '3-details');
  const hide = page.getByText(O.hideDetailsText, { exact: false }).first();
  if (await hide.count()) await clickToggle(hide).catch(() => {});
  await sleep(500);
}

// "عرض التفاصيل" في فنار نص ما ينضغط؛ اللي ينضغط هو رأس البطاقة (role=button). نضغطه، وإذا ما فيه نضغط النص بالقوة
async function clickToggle(t) {
  await t.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const header = t.locator('xpath=ancestor::*[@role="button" or self::button][1]');
  if (await header.count()) return header.click({ timeout: 5000 });
  return t.click({ timeout: 5000, force: true });
}

// يفتح تفاصيل كل بطاقة ويقرأ الخانات حسب عناوينها (مو حسب تصميم الصفحة)
async function readCards(page, deadline) {
  await dumpFirstDetails(page);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // أصغر عنصر مكتوب عليه "عرض التفاصيل" أو "إخفاء التفاصيل" — نضغطه بضغطة ماوس حقيقية
  const toggles = page.getByText(new RegExp(`${esc(O.showDetailsText)}|${esc(O.hideDetailsText)}`));
  const n = await toggles.count();
  const results = [];
  let failed = 0;
  let timedOut = false;

  const inCard = (el, { o, labels, mode }) => {
    // البطاقة = أكبر عنصر فوق الزر ما فيه إلا زر تفاصيل واحد (عشان نشمل التفاصيل اللي تنفتح تحت رأس البطاقة)
    const toggleCount = (x) => ((x.innerText || '').split(o.showDetailsText).length - 1)
      + ((x.innerText || '').split(o.hideDetailsText).length - 1);
    let card = el;
    while (card.parentElement && card.parentElement !== document.body && toggleCount(card.parentElement) <= 1) card = card.parentElement;
    if (mode === 'has') return (card.innerText || '').includes(o.detailsMarker);
    const esc2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const els = [card, ...card.querySelectorAll('*')];
    const texts = els.map((e) => (e.innerText || '').trim());
    const out = {};
    for (const lab of labels) {
      const re = new RegExp(`^${esc2(lab)}\\s*[:：]\\s*([^\\n]+)`);
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
  const args = (mode) => ({ o: O, labels: LABELS, mode });

  for (let i = 0; i < n; i++) {
    if (Date.now() > deadline) { timedOut = true; break; }
    const t = toggles.nth(i);
    try {
      let open = await t.evaluate(inCard, args('has'));
      for (let attempt = 0; attempt < 2 && !open; attempt++) {
        if ((await t.innerText()).includes(O.showDetailsText)) await clickToggle(t);
        for (let w = 0; w < 40 && !open; w++) {
          await sleep(150);
          open = await t.evaluate(inCard, args('has'));
        }
      }
      if (!open) failed++;
      results.push(await t.evaluate(inCard, args('read')));
      if (open && (await t.innerText()).includes(O.hideDetailsText)) await clickToggle(t).catch(() => {});
    } catch {
      failed++;
    }
    // إذا أول 5 بطاقات كلها ما انفتحت، نوقف بدل ما نضيّع الوقت
    if (i === 4 && failed === 5) throw new Error('ما قدرت أفتح «عرض التفاصيل» في أول 5 أوامر. شغّل وضع الفحص وأرسل ملف masar-debug.');
  }
  return { results, failed, timedOut, total: n };
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

// ---------- حفظ جلسة الدخول (مشفّرة بكلمة المرور) عشان ما يُطلب رمز التحقق كل مرة ----------
const SESSION_FILE = path.join(ROOT, '.masar-session.enc');
const sessionKey = () => crypto.scryptSync(need('FANAR_PASS'), 'masar-session-v1', 32);

async function loadSession() {
  try {
    const box = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

async function saveSession(context) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sessionKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(await context.storageState()), 'utf8'), c.final()]);
  await fs.writeFile(SESSION_FILE, JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }));
}

async function onLoginPage(page) {
  if (/\/login\b/i.test(new URL(page.url()).pathname)) return true;
  return (await page.locator(config.login.password).filter({ visible: true }).count()) > 0;
}

// ---------- التشغيل ----------
const browser = await chromium.launch({ headless: true });
try {
  const saved = await loadSession();
  const context = await browser.newContext({
    locale: 'ar-SA', timezoneId: 'Asia/Riyadh', viewport: { width: 1400, height: 900 }, ...(saved ? { storageState: saved } : {}),
  });
  const page = await context.newPage();
  let needLogin = !process.env.MASAR_SKIP_LOGIN;
  if (saved && needLogin) {
    await page.goto(config.ordersUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2000);
    needLogin = await onLoginPage(page);
    log(needLogin ? 'الجلسة المحفوظة انتهت، ندخل من جديد.' : 'دخلنا بالجلسة المحفوظة بدون رمز تحقق.');
  }
  if (needLogin) await login(page);
  await saveSession(context);
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
