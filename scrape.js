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
  const skeleton = await page.evaluate(() => {
    const KEEP_TEXT = new Set(['TH', 'LABEL', 'BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'OPTION', 'LEGEND']);
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, svg, noscript, img, link, meta').forEach((n) => n.remove());
    clone.querySelectorAll('input, textarea').forEach((n) => { n.removeAttribute('value'); n.textContent = ''; });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      const parent = t.parentElement;
      const keep = parent && KEEP_TEXT.has(parent.tagName) && !parent.closest('td');
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
  });
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

// ---------- قراءة الجدول ----------
function matchColumns(headers) {
  const normHeaders = headers.map(normText);
  const map = {};
  for (const [field, names] of Object.entries(config.columns)) {
    const wanted = names.map(normText);
    let idx = normHeaders.findIndex((h) => wanted.includes(h));
    if (idx < 0) idx = normHeaders.findIndex((h) => h && wanted.some((w) => h.includes(w)));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

async function readPage(page) {
  const o = config.orders;
  return page.$$eval(o.table, (tables, sel) => {
    // نختار أكبر جدول في الصفحة
    const t = tables.sort((a, b) => b.querySelectorAll(sel.rows).length - a.querySelectorAll(sel.rows).length)[0];
    if (!t) return { headers: [], rows: [] };
    const clean = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const headers = [...t.querySelectorAll(sel.headerCells)].map(clean);
    const rows = [...t.querySelectorAll(sel.rows)].map((tr) => [...tr.querySelectorAll(sel.cells)].map(clean));
    return { headers, rows };
  }, { rows: o.rows, headerCells: o.headerCells, cells: o.cells });
}

async function readAllOrders(page) {
  log('فتح صفحة أوامر الصرف…');
  await page.goto(config.ordersUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await dumpStructure(page, '2-orders');
  await page.locator(`${config.orders.table} ${config.orders.rows}`).first().waitFor({ timeout: 45_000 });

  const all = [];
  let colMap = null;
  const seen = new Set();
  for (let p = 1; p <= (config.orders.maxPages || 1); p++) {
    const { headers, rows } = await readPage(page);
    if (!colMap) {
      colMap = matchColumns(headers);
      log(`أعمدة الجدول: ${headers.join(' | ')}`);
      const required = ['company', 'invoice', 'amount', 'status'];
      if (config.onlyCategory?.column) required.push(config.onlyCategory.column);
      const missing = required.filter((f) => colMap[f] === undefined);
      if (missing.length) throw new Error(`ما لقيت هذي الأعمدة: ${missing.join(', ')} — عدّل "columns" في config.json`);
    }
    const sig = rows.map((r) => r.join('¦')).join('\n');
    if (seen.has(sig)) break; // نفس الصفحة تكررت = انتهت الصفحات
    seen.add(sig);
    for (const r of rows) {
      const rec = {};
      for (const [field, idx] of Object.entries(colMap)) rec[field] = r[idx] ?? '';
      all.push(rec);
    }
    log(`صفحة ${p}: ${rows.length} صف`);

    if (!config.orders.next) break;
    const next = page.locator(config.orders.next).first();
    if (!(await next.count())) break;
    const disabled = await next.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true'
      || /\bdisabled\b/.test(el.className) || /\bdisabled\b/.test(el.parentElement?.className || ''));
    if (disabled) break;
    await next.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(config.orders.waitAfterNextMs || 1500);
  }
  return all;
}

// ---------- بناء الملف المشفّر ----------
async function build(orders) {
  const salt = need('MASAR_SALT');
  const records = {};
  let skipped = 0;
  for (const o of orders) {
    const d = await deriveRecord(salt, o.company, o.invoice, o.amount);
    if (!d) { skipped++; continue; }
    const payload = { status: o.status || '', date: o.date || '', orderNo: o.orderNo || '' };
    (records[d.id] ||= []).push(await encryptJSON(d.key, payload));
  }
  const data = { v: 1, salt, iterations: KDF_ITERATIONS, updatedAt: new Date().toISOString(), records };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data));
  log(`تم: ${Object.keys(records).length} فاتورة مشفّرة${skipped ? `، وتُجاهل ${skipped} صف ناقص البيانات` : ''}.`);
}

// ---------- التشغيل ----------
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: 'ar-SA', timezoneId: 'Asia/Riyadh', viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  if (!process.env.MASAR_SKIP_LOGIN) await login(page);
  let orders = await readAllOrders(page);
  if (!orders.length) throw new Error('ما انقرأ أي أمر صرف — ما راح نحدّث الصفحة عشان ما تنمسح البيانات القديمة.');
  const only = config.onlyCategory;
  if (only?.column && only.contains?.length) {
    const wanted = only.contains.map(normText);
    const total = orders.length;
    orders = orders.filter((o) => {
      const v = normText(o[only.column]);
      return v && wanted.some((w) => v.includes(w));
    });
    log(`بند الصيانة: ${orders.length} من أصل ${total} أمر صرف.`);
    if (!orders.length) throw new Error('ما لقيت أي أمر صرف تحت بند الصيانة — تأكد من اسم البند في config.json. ما راح نحدّث الصفحة.');
  }
  await build(orders);
} catch (err) {
  console.error('[مسار] خطأ:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
