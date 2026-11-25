// مِسَار — الدوال المشتركة بين صفحة الاستعلام (المتصفح) وسكربت السحب (Node).
// أي تعديل هنا يطبق على الطرفين، فلازم يبقى نفس الملف للاثنين.

export const KDF_ITERATIONS = 200000;

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toLatinDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d));
}

// توحيد النص العربي: حذف التشكيل والتطويل، توحيد الألف والياء والتاء المربوطة.
export function normText(s) {
  return toLatinDigits(s)
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// اسم الشركة: نفس التوحيد + حذف الكلمات العامة مثل "شركة" و"مؤسسة".
const GENERIC_WORDS = new Set(['شركه', 'مؤسسه', 'company', 'co', 'est', 'ltd', 'llc']);
export function normCompany(s) {
  return normText(s)
    .split(' ')
    .filter((w) => w && !GENERIC_WORDS.has(w))
    .join(' ');
}

// رقم الفاتورة: أحرف وأرقام فقط، بدون مسافات أو شرطات.
export function normInvoice(s) {
  return toLatinDigits(s).toUpperCase().replace(/[^A-Z0-9\p{L}]/gu, '');
}

// المبلغ: رقم بخانتين عشريتين. يقبل الفواصل والأرقام العربية وكلمة "ريال".
export function normAmount(s) {
  const cleaned = toLatinDigits(s)
    .replace(/٫/g, '.')
    .replace(/[٬,\s]/g, '')
    .replace(/[^0-9.]/g, '');
  if (!cleaned) return '';
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// من اسم الشركة + المبلغ نشتق: معرّف للبحث + مفتاح تشفير. بدونهم صح ما ينفتح شيء.
export async function deriveRecord(salt, company, amount, iterations = KDF_ITERATIONS) {
  const c = normCompany(company);
  const a = normAmount(amount);
  if (!c || !a) return null;
  const material = await crypto.subtle.importKey('raw', enc.encode(`${c}|${a}`), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, material, 512),
  );
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id: toHex(bits.slice(32, 48)), key };
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}
