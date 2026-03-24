require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { isTwilioWhatsAppConfigured, sendWhatsAppOtpTemplate } = require('./twilioWhatsApp');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { PrismaClient } = require('@prisma/client');
const {
  startRestaurantHoursScheduler,
  parseTimeToMinutes,
  getCurrentMinutesIst,
  isWithinServingWindow,
} = require('./restaurantHoursScheduler');
const {
  signAdminAccessToken,
  signPartnerAccessToken,
  requireAdmin,
  requirePartner,
  assertPartnerOwnsRestaurant,
  adminBearerIsValid,
} = require('./authMiddleware');
const { isPaytmReady, initiatePaytmForOrder, handlePaytmCallback } = require('./paytmPayment');
const { sendTelegramNotification, escapeTelegramMarkdown } = require('./telegramNotify');
const { attachLiveChatSocket } = require('./liveChatSocket');

const app = express();
/** JSON + form body parsers must run before any `/api` route (e.g. Paytm initiate) to avoid empty-body checksum errors. */
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '25mb' }));

const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

/** Universal OTP store: key `${normalizedRole}:${canonicalMobile}` → { otp, expiresAt } */
const UNIVERSAL_OTP_TTL_MS = 10 * 60 * 1000;
const universalOtpByKey = new Map();

/** Comma-separated 10-digit numbers; last 10 digits matched. Default: registered admin mobile. */
function buildAdminAllowedPhones() {
  const raw = (process.env.ADMIN_PHONE || process.env.ADMIN_ALLOWED_PHONES || "8299393771").trim();
  const set = new Set();
  for (const part of raw.split(",")) {
    const d = String(part || "").replace(/\D/g, "");
    if (d.length >= 10) set.add(d.slice(-10));
  }
  if (set.size === 0) set.add("8299393771");
  return set;
}
const ADMIN_ALLOWED_PHONES = buildAdminAllowedPhones();

function isAdminRegisteredPhone(p10) {
  return ADMIN_ALLOWED_PHONES.has(p10);
}

const menuDigitizeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 16 },
});

/**
 * Gemini often returns ```json\n[...]\n``` or prose + fenced block — old ^...$ regex failed.
 * Pull the outermost JSON array substring after stripping fences.
 */
function extractJsonArrayFromAiText(text) {
  let t = String(text || '').trim();
  if (!t) return t;

  // Repeatedly peel ```json ... ``` blocks (non-greedy), prefer the largest valid-looking array inside
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  let bestFromFence = '';
  while ((m = fenceRe.exec(t)) !== null) {
    const inner = String(m[1] || '').trim();
    const start = inner.indexOf('[');
    const end = inner.lastIndexOf(']');
    if (start !== -1 && end > start) {
      const slice = inner.slice(start, end + 1);
      if (slice.length > bestFromFence.length) bestFromFence = slice;
    }
  }
  if (bestFromFence) return bestFromFence;

  // Inline: starts with ```json [  (no closing fence yet / broken fence)
  t = t.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) return t.slice(start, end + 1);
  return t.trim();
}

/** Root schema for menu digitize — forces valid JSON array from Gemini (avoids unterminated strings / bad escapes). */
const MENU_DIGITIZE_ITEM_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING, description: 'Dish name as plain text' },
    fullPrice: { type: SchemaType.NUMBER, description: 'Numeric price' },
    description: {
      type: SchemaType.STRING,
      description: 'Short one-line description, max ~120 chars, no raw newlines',
    },
    isVeg: { type: SchemaType.BOOLEAN },
    category: { type: SchemaType.STRING },
  },
  required: ['name', 'fullPrice', 'description', 'isVeg', 'category'],
};

const MENU_DIGITIZE_RESPONSE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: MENU_DIGITIZE_ITEM_SCHEMA,
};

/**
 * Parse model output: structured JSON is often the whole body; legacy path uses fenced / sliced array.
 */
function parseMenuDigitizeAiJson(rawText) {
  const t = String(rawText || '').trim();
  if (!t) {
    const err = new SyntaxError('Empty AI response');
    throw err;
  }

  function normalizeToArray(p) {
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') {
      if (Array.isArray(p.items)) return p.items;
      if (Array.isArray(p.menuItems)) return p.menuItems;
    }
    return null;
  }

  let lastErr;
  const attempts = [() => JSON.parse(t), () => JSON.parse(extractJsonArrayFromAiText(t))];
  for (const fn of attempts) {
    try {
      const parsed = fn();
      const arr = normalizeToArray(parsed);
      if (arr) return arr;
      lastErr = new SyntaxError('AI response must be a JSON array of menu items');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new SyntaxError('Could not parse menu JSON');
}

/**
 * Gemini sometimes omits .text() when safety blocks or parts are empty — read parts manually.
 */
function extractTextFromGeminiResponse(response) {
  if (!response) return '';
  try {
    const direct = response.text();
    if (direct && String(direct).trim()) return direct;
  } catch (e) {
    const msg = e?.message || String(e);
    const cand = response.candidates?.[0];
    const parts = cand?.content?.parts;
    if (Array.isArray(parts) && parts.length) {
      const joined = parts.map((p) => p?.text || '').join('');
      if (joined.trim()) return joined;
    }
    const reason = cand?.finishReason || 'UNKNOWN';
    throw new Error(`${msg} (finishReason: ${reason})`);
  }
  const cand = response.candidates?.[0];
  const parts = cand?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts.map((p) => p?.text || '').join('');
    if (joined.trim()) return joined;
  }
  const reason = cand?.finishReason || 'NO_TEXT';
  throw new Error(`Gemini returned no text (finishReason: ${reason})`);
}

/**
 * Hardcoded IDs differ by account/region and go stale → 404. We call ListModels and only try
 * models that support generateContent for this API key. Minimal fallback if ListModels fails.
 */
const GEMINI_MINIMAL_FALLBACK = ['gemini-2.0-flash', 'gemini-2.0-flash-001'];

let geminiListModelsCache = { at: 0, ids: null };
const GEMINI_LIST_CACHE_MS = 60 * 60 * 1000;

/** Strip junk; map legacy names that often 404 to safer defaults */
function sanitizeGeminiModelId(raw) {
  let m = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  m = m.replace(/^models\//i, '').trim();
  const lower = m.toLowerCase();
  if (lower === 'gemini-1.5-flash') return 'gemini-1.5-flash-latest';
  // gemini-1.5-pro-latest often 404 on consumer API — prefer 2.0 Flash
  if (lower === 'gemini-1.5-pro' || lower === 'gemini-1.5-pro-latest') return 'gemini-2.0-flash';
  return m;
}

/** Models your key can call (official list — no guessing IDs). */
async function fetchGeminiGenerateContentModelIds(apiKey) {
  const now = Date.now();
  if (geminiListModelsCache.ids && now - geminiListModelsCache.at < GEMINI_LIST_CACHE_MS) {
    return geminiListModelsCache.ids;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) {
      console.warn('[digitize-bulk] ListModels HTTP', r.status, text.slice(0, 300));
      return [];
    }
    const j = JSON.parse(text);
    const list = Array.isArray(j.models) ? j.models : [];
    const ids = list
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent'),
      )
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => id && !/embed/i.test(id));
    const rank = (id) => {
      const x = id.toLowerCase();
      if (x.includes('gemini-2.0') && x.includes('flash')) return 100;
      if (x.includes('gemini-2.5') && x.includes('flash')) return 95;
      if (x.includes('gemini-2') && x.includes('flash')) return 90;
      if (x.includes('gemini-1.5') && x.includes('flash')) return 80;
      if (x.includes('flash')) return 70;
      if (x.includes('gemini') && x.includes('pro')) return 50;
      return 40;
    };
    ids.sort((a, b) => rank(b) - rank(a));
    geminiListModelsCache = { at: now, ids };
    console.log(
      '[digitize-bulk] ListModels:',
      ids.length,
      'generateContent models; first:',
      ids.slice(0, 5).join(', '),
    );
    return ids;
  } catch (e) {
    console.warn('[digitize-bulk] ListModels error:', e?.message || e);
    return [];
  }
}

async function buildGeminiModelTryOrder(apiKey) {
  const seen = new Set();
  const out = [];
  const push = (id) => {
    const n = sanitizeGeminiModelId(id);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  const fromEnv = process.env.GEMINI_MODEL;
  if (fromEnv && String(fromEnv).trim()) {
    String(fromEnv)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => push(s));
  }
  for (const id of await fetchGeminiGenerateContentModelIds(apiKey)) {
    push(id);
  }
  GEMINI_MINIMAL_FALLBACK.forEach((id) => push(id));
  return out;
}

function menuDigitizeGenerationConfig(useStructuredJson) {
  const base = { temperature: 0.15, maxOutputTokens: 16384 };
  if (!useStructuredJson) return base;
  return {
    ...base,
    responseMimeType: 'application/json',
    responseSchema: MENU_DIGITIZE_RESPONSE_SCHEMA,
  };
}

async function generateMenuDigitizeWithGemini(apiKey, contentParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = await buildGeminiModelTryOrder(apiKey);
  if (!models.length) {
    throw new Error('No Gemini models to try (ListModels empty and no GEMINI_MODEL)');
  }
  console.log('[digitize-bulk] Gemini try order:', models.slice(0, 12).join(' → '), models.length > 12 ? '…' : '');
  let lastErr = null;
  for (const modelNameRaw of models) {
    const modelName = sanitizeGeminiModelId(modelNameRaw);
    if (modelName !== modelNameRaw) {
      console.warn('[digitize-bulk] remapped model id:', JSON.stringify(modelNameRaw), '→', modelName);
    }
    for (const structured of [true, false]) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: menuDigitizeGenerationConfig(structured),
        });
        const result = await model.generateContent(contentParts);
        const response = result.response;
        if (!response.candidates || !response.candidates.length) {
          lastErr = new Error(`Model ${modelName}: no candidates`);
          if (!structured) break;
          continue;
        }
        const rawText = extractTextFromGeminiResponse(response);
        if (rawText && rawText.trim()) {
          console.log(
            '[digitize-bulk] success with model:',
            modelName,
            structured ? '(structured JSON)' : '(freeform)'
          );
          return rawText;
        }
        lastErr = new Error(`Model ${modelName}: empty text`);
      } catch (e) {
        lastErr = e;
        console.error(
          `[digitize-bulk] Gemini try ${modelName}${structured ? ' [structured]' : ''}:`,
          e?.message || e
        );
      }
      if (!structured) break;
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

/** Normalize phone for loose matching (91 prefix, spaces, etc.) */
function digitsOnlyPhone(p) {
  return String(p || '').replace(/\D/g, '');
}

/** Indian mobile: compare by last 10 digits so 8299…, 08299…, 918299… all match one rider */
function canonicalMobile(p) {
  const d = digitsOnlyPhone(p);
  if (!d) return '';
  if (d.length >= 10) return d.slice(-10);
  return d;
}

async function findRestaurantByPhone(phone) {
  const raw = String(phone || '').trim();
  const d = digitsOnlyPhone(raw);
  if (!d) return null;
  let r = await prisma.restaurant.findFirst({ where: { phone: raw } });
  if (r) return r;
  r = await prisma.restaurant.findFirst({ where: { phone: d } });
  if (r) return r;
  const candidates = await prisma.restaurant.findMany();
  return candidates.find((x) => x.phone && digitsOnlyPhone(x.phone) === d) || null;
}

async function findRiderByPhone(phone) {
  const target = canonicalMobile(phone);
  if (!target || target.length < 10) return null;
  const candidates = await prisma.rider.findMany();
  return candidates.find((x) => x.phone && canonicalMobile(x.phone) === target) || null;
}

async function findUserByPhone(phone) {
  const raw = String(phone || "").trim();
  const d = digitsOnlyPhone(raw);
  if (!d) return null;
  let u = await prisma.user.findUnique({ where: { phone: raw } }).catch(() => null);
  if (u) return u;
  u = await prisma.user.findFirst({ where: { phone: d } });
  if (u) return u;
  const candidates = await prisma.user.findMany();
  return candidates.find((x) => x.phone && digitsOnlyPhone(x.phone) === d) || null;
}

/** Maps client role to internal bucket for OTP + verify */
function normalizeAuthRole(role) {
  const r = String(role || "").toUpperCase().trim();
  if (r === "CUSTOMER" || r === "USER") return "USER";
  if (r === "PARTNER" || r === "RESTAURANT") return "PARTNER";
  if (r === "RIDER") return "RIDER";
  if (r === "ADMIN") return "ADMIN";
  return "";
}

function universalOtpStorageKey(role, phone) {
  const bucket = normalizeAuthRole(role);
  const p = canonicalMobile(phone);
  return `${bucket}:${p}`;
}

/** Digits for USER/PARTNER/RIDER WhatsApp OTP — must match frontend VITE_OTP_LENGTH and Twilio template. */
function getOtpCodeLength() {
  const n = parseInt(process.env.OTP_CODE_LENGTH || "4", 10);
  if (Number.isFinite(n) && n >= 4 && n <= 8) return n;
  return 4;
}

function generateOtpCode() {
  const len = getOtpCodeLength();
  const min = 10 ** (len - 1);
  const max = 10 ** len - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

function normalizeEmailInput(e) {
  const s = String(e || "").trim().toLowerCase();
  return s || null;
}

/** Store bankDetails as normalized JSON string */
function normalizeBankDetailsForStore(input) {
  if (input == null || input === "") return null;
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return null;
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return t;
    }
  }
  return JSON.stringify(input);
}

function jsonFieldComparable(str) {
  if (str == null || str === "") return "";
  try {
    return JSON.stringify(JSON.parse(str));
  } catch {
    return String(str).trim();
  }
}

function orderDetailBody(order) {
  const items = (order.items || [])
    .map((i) => `${i.menuItem?.name || "Item"} ×${i.quantity} @ ₹${i.priceAtOrder}`)
    .join("; ");
  return [
    `Order: ${order.orderNumber || order.id?.slice(-8)}`,
    `Restaurant: ${order.restaurant?.name || "—"} (${order.restaurant?.phone || "—"})`,
    `Customer: ${order.user?.name || "—"} · ${order.user?.phone || "—"}`,
    `Deliver to: ${order.deliveryAddress || "—"}`,
    `Amount: ₹${order.totalAmount} · ${order.paymentMethod || "COD"} · ${order.paymentStatus || ""}`,
    `Rider: ${order.rider?.name || "Unassigned"}`,
    `Status: ${order.status}`,
    `Items: ${items || "—"}`,
  ].join("\n");
}

async function createNotification(row) {
  try {
    return await prisma.notification.create({ data: row });
  } catch (e) {
    console.error("Notification create failed:", e.message);
    return null;
  }
}

/** Haversine distance in km (WGS84). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/** Keep Rider.activeOrdersCount in sync with non-terminal assigned orders. */
async function syncRiderActiveOrdersCount(riderId) {
  if (!riderId) return;
  try {
    const active = await prisma.order.count({
      where: {
        riderId,
        status: { notIn: ["DELIVERED", "REJECTED", "CANCELLED"] },
      },
    });
    await prisma.rider.update({
      where: { id: riderId },
      data: { activeOrdersCount: active },
    });
  } catch (e) {
    console.error("syncRiderActiveOrdersCount:", e.message);
  }
}

/**
 * Enterprise dispatch: only riders with activeOrdersCount === 0, on duty, approved.
 * Nearest to restaurant first; notification body includes "~X km from pickup".
 */
async function pingEligibleRidersForNewOrder(order, restaurant) {
  if (!restaurant || !order?.id) return;
  const rLat = restaurant.latitude != null ? Number(restaurant.latitude) : NaN;
  const rLng = restaurant.longitude != null ? Number(restaurant.longitude) : NaN;
  const restHasGeo = Number.isFinite(rLat) && Number.isFinite(rLng);

  const candidates = await prisma.rider.findMany({
    where: {
      approvalStatus: "APPROVED",
      onDuty: true,
      activeOrdersCount: 0,
    },
  });

  const withDist = candidates.map((rd) => {
    const lat = rd.latitude != null ? Number(rd.latitude) : NaN;
    const lng = rd.longitude != null ? Number(rd.longitude) : NaN;
    const ok = restHasGeo && Number.isFinite(lat) && Number.isFinite(lng);
    return {
      rd,
      km: ok ? haversineKm(rLat, rLng, lat, lng) : null,
    };
  });

  withDist.sort((a, b) => {
    if (a.km == null && b.km == null) return 0;
    if (a.km == null) return 1;
    if (b.km == null) return -1;
    return a.km - b.km;
  });

  const baseBody = orderDetailBody(order);
  const restName = restaurant.name || "Restaurant";

  for (const { rd, km } of withDist) {
    const distLine =
      km != null
        ? `You are ~${km.toFixed(1)} km from ${restName} (pickup).`
        : `New delivery request near ${restName}. Add your location in the rider app to see pickup distance.`;
    const title =
      km != null ? `New order · ~${km.toFixed(1)} km from pickup` : `New delivery request · ${restName}`;

    await createNotification({
      audience: "RIDER",
      customerUserId: null,
      riderId: rd.id,
      restaurantId: null,
      type: "ORDER_DISPATCH_PING",
      title,
      body: `${distLine}\n\n${baseBody}`,
      orderId: order.id,
    });
  }
}

/**
 * Restaurant kitchen, rider pool, and dispatch may only see orders that are paid online or non-online (e.g. COD).
 * Online + PENDING or FAILED must never appear in rider or kitchen lists.
 */
function isPaymentVerifiedForDispatch(order) {
  const orderStatus = String(order?.status || "").toUpperCase();
  if (orderStatus === "PAYMENT_FAILED") return false;
  const paymentStatus = String(order?.paymentStatus || "").toUpperCase();
  if (paymentStatus === "FAILED") return false;
  const paymentMethod = String(order?.paymentMethod || "COD").toUpperCase();
  if (paymentMethod === "ONLINE") return paymentStatus === "PAID";
  return true;
}

/** @deprecated Use isPaymentVerifiedForDispatch — kept for inline grep stability */
const orderPassesPartnerKitchenPaymentGate = isPaymentVerifiedForDispatch;

function prismaWherePaymentVerifiedForDispatch() {
  return {
    AND: [
      { status: { not: "PAYMENT_FAILED" } },
      { paymentStatus: { not: "FAILED" } },
      {
        OR: [
          { NOT: { paymentMethod: { equals: "ONLINE", mode: "insensitive" } } },
          { paymentStatus: { equals: "PAID", mode: "insensitive" } },
        ],
      },
    ],
  };
}

const prismaWherePartnerKitchenPaymentEligible = prismaWherePaymentVerifiedForDispatch;

/** Restaurant dashboard + rider dispatch ping for a paid / COD order (not used for unpaid online). */
async function notifyRestaurantKitchenNewOrder(order) {
  const title = `New order ${order.orderNumber || ""}`;
  const body = orderDetailBody(order);
  await createNotification({
    audience: "RESTAURANT",
    customerUserId: null,
    riderId: null,
    restaurantId: order.restaurantId,
    type: "ORDER_RESTAURANT",
    title: "New order — start preparing",
    body,
    orderId: order.id,
  });
  const rest = order.restaurant || (await prisma.restaurant.findUnique({ where: { id: order.restaurantId } }));
  if (rest) await pingEligibleRidersForNewOrder(order, rest);
}

async function notifyNewOrder(order) {
  const title = `New order ${order.orderNumber || ""}`;
  const body = orderDetailBody(order);
  await createNotification({
    audience: "ADMIN",
    customerUserId: null,
    riderId: null,
    restaurantId: null,
    type: "ORDER_NEW",
    title,
    body,
    orderId: order.id,
  });
  await createNotification({
    audience: "CUSTOMER",
    customerUserId: order.userId,
    riderId: null,
    restaurantId: null,
    type: "ORDER_CONFIRMED",
    title: "Order placed successfully",
    body,
    orderId: order.id,
  });
  if (isPaymentVerifiedForDispatch(order)) {
    await notifyRestaurantKitchenNewOrder(order);
  }
}

async function notifyOrderRiderEvent(order, type, title) {
  const body = orderDetailBody(order);
  await createNotification({
    audience: "ADMIN",
    customerUserId: null,
    riderId: null,
    restaurantId: null,
    type,
    title,
    body,
    orderId: order.id,
  });
  await createNotification({
    audience: "CUSTOMER",
    customerUserId: order.userId,
    riderId: null,
    restaurantId: null,
    type,
    title,
    body,
    orderId: order.id,
  });
  await createNotification({
    audience: "RESTAURANT",
    customerUserId: null,
    riderId: null,
    restaurantId: order.restaurantId,
    type,
    title,
    body,
    orderId: order.id,
  });
  if (order.riderId) {
    await createNotification({
      audience: "RIDER",
      customerUserId: null,
      riderId: order.riderId,
      restaurantId: null,
      type,
      title,
      body,
      orderId: order.id,
    });
  }
}

app.get('/', (req, res) => res.send('VYAHARAM backend is live.'));

/** Live support — forwards to admin Telegram (VYAHARAM). */
app.post('/api/support/live-chat', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const phone = String(req.body?.phone || '').trim().slice(0, 32);
    const role = String(req.body?.role || '').trim().slice(0, 64);
    const message = String(req.body?.message || '').trim().slice(0, 3800);
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const n = escapeTelegramMarkdown(name || '—');
    const p = escapeTelegramMarkdown(phone || '—');
    const r = escapeTelegramMarkdown(role || '—');
    const m = escapeTelegramMarkdown(message);
    const text =
      `🚀 *VYAHARAM Support Alert!*\n\n` +
      `*From:* ${n} (${r})\n` +
      `*Contact:* ${p}\n` +
      `*Issue:* ${m}`;
    await sendTelegramNotification(text);
    res.json({ ok: true });
  } catch (e) {
    const code = e?.code || '';
    if (code === 'TELEGRAM_NOT_CONFIGURED') {
      return res.status(503).json({ error: e.message || 'Telegram is not configured on the server.' });
    }
    console.error('[POST /api/support/live-chat]', e?.message || e);
    res.status(502).json({ error: e?.message || 'Could not deliver support message.' });
  }
});

// ⏰ Anti-Sleep Alarm
setInterval(async () => {
  try {
    await prisma.restaurant.count();
    console.log("⚡ Database is awake!");
  } catch (err) {
    console.log("💤 Waking up database...");
  }
}, 4 * 60 * 1000); 

// ==========================================
// 👤 USER & AUTH APIs
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, name } = req.body;
    const user = await prisma.user.upsert({
      where: { phone },
      update: { name: name || undefined }, 
      create: { phone, name: name || "Customer", role: "CUSTOMER" },
    });
    res.json({ message: "Login Successful", user });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/**
 * Universal OTP — stored in memory.
 * If Twilio WhatsApp env is set, sends OTP via approved WhatsApp template; else logs to console (dev).
 */
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { phone, role } = req.body || {};
    const bucket = normalizeAuthRole(role);
    if (!bucket) {
      return res.status(400).json({ error: "role must be USER, PARTNER, RIDER, or ADMIN" });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    const p10 = canonicalMobile(phone);
    if (!p10 || p10.length < 10) {
      return res.status(400).json({ error: "Valid 10-digit mobile required" });
    }

    if (bucket === "ADMIN") {
      if (!isAdminRegisteredPhone(p10)) {
        return res.status(403).json({ error: "This mobile is not registered for admin access." });
      }
    } else if (bucket === "PARTNER") {
      const r = await findRestaurantByPhone(phone);
      if (!r) return res.status(404).json({ error: "Restaurant not found for this phone" });
    } else if (bucket === "RIDER") {
      const rider = await findRiderByPhone(phone);
      if (!rider) return res.status(404).json({ error: "Rider not found for this phone" });
    }
    // USER: no pre-registration required

    const otp = generateOtpCode();
    const key = universalOtpStorageKey(role, phone);
    universalOtpByKey.set(key, { otp, expiresAt: Date.now() + UNIVERSAL_OTP_TTL_MS });

    const useWa = isTwilioWhatsAppConfigured();
    if (useWa) {
      try {
        const sid = await sendWhatsAppOtpTemplate({ phoneDigits10: p10, otp4: otp });
        console.log("[send-otp] WhatsApp OTP sent", { role: bucket, phone: p10, messageSid: sid });
        return res.json({
          message: "OTP sent to your WhatsApp",
          role: bucket,
          channel: "whatsapp",
        });
      } catch (waErr) {
        console.error("[send-otp] Twilio WhatsApp failed:", waErr?.message || waErr);
        universalOtpByKey.delete(key);
        return res.status(502).json({
          error: "Could not send OTP via WhatsApp",
          detail: String(waErr?.message || waErr),
        });
      }
    }

    console.log("OTP for", role, phone, "is:", otp, "(dev: Twilio not configured — check server log)");
    return res.json({
      message: "OTP sent (dev mode: see server console; set Twilio env for WhatsApp)",
      role: bucket,
      channel: "console",
    });
  } catch (error) {
    console.error("send-otp:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp, role } = req.body || {};
    const code = String(otp ?? "").trim();
    const bucket = normalizeAuthRole(role);
    if (!bucket) {
      return res.status(400).json({ error: "role must be USER, PARTNER, RIDER, or ADMIN" });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    if (!code) return res.status(400).json({ error: "otp is required" });

    const p10 = canonicalMobile(phone);
    if (!p10 || p10.length < 10) {
      return res.status(400).json({ error: "Valid 10-digit mobile required" });
    }

    if (bucket === "ADMIN") {
      if (!isAdminRegisteredPhone(p10)) {
        return res.status(403).json({ error: "Invalid admin phone" });
      }
      const adminOtpLen = getOtpCodeLength();
      if (!new RegExp(`^\\d{${adminOtpLen}}$`).test(code)) {
        return res.status(400).json({ error: `Enter the ${adminOtpLen}-digit OTP` });
      }
      const adminKey = universalOtpStorageKey(role, phone);
      const adminEntry = universalOtpByKey.get(adminKey);
      if (!adminEntry || Date.now() > adminEntry.expiresAt) {
        universalOtpByKey.delete(adminKey);
        return res.status(400).json({ error: "OTP expired or not sent. Request a new code." });
      }
      if (adminEntry.otp !== code) {
        return res.status(400).json({ error: "Invalid OTP" });
      }
      universalOtpByKey.delete(adminKey);
      const adminToken = signAdminAccessToken(p10);
      return res.json({
        message: "Admin verified",
        role: "ADMIN",
        token: adminToken,
        data: {
          id: "eater-admin",
          role: "ADMIN",
          phone: p10,
          name: "Platform Admin",
        },
      });
    }

    const otpLen = getOtpCodeLength();
    if (!new RegExp(`^\\d{${otpLen}}$`).test(code)) {
      return res.status(400).json({ error: `Enter the ${otpLen}-digit OTP` });
    }

    const key = universalOtpStorageKey(role, phone);
    const entry = universalOtpByKey.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      universalOtpByKey.delete(key);
      return res.status(400).json({ error: "OTP expired or not sent. Request a new code." });
    }
    if (entry.otp !== code) {
      return res.status(400).json({ error: "Invalid OTP" });
    }
    universalOtpByKey.delete(key);

    if (bucket === "USER") {
      let u = await findUserByPhone(phone);
      if (!u) {
        try {
          u = await prisma.user.create({
            data: { phone: p10, name: "Customer", role: "CUSTOMER", isPhoneVerified: true },
          });
        } catch {
          u = await findUserByPhone(phone);
          if (!u) {
            return res.status(500).json({ error: "Could not register user" });
          }
          u = await prisma.user.update({
            where: { id: u.id },
            data: { isPhoneVerified: true, otpCode: null, otpExpiry: null },
          });
        }
      } else {
        u = await prisma.user.update({
          where: { id: u.id },
          data: { isPhoneVerified: true, otpCode: null, otpExpiry: null },
        });
      }
      return res.json({ message: "Phone verified", role: bucket, data: u });
    }

    if (bucket === "PARTNER") {
      const r = await findRestaurantByPhone(phone);
      if (!r) return res.status(404).json({ error: "Restaurant not found" });
      if (r.approvalStatus === "REJECTED") {
        return res.status(403).json({ error: "Registration rejected. Contact support." });
      }
      const updated = await prisma.restaurant.update({
        where: { id: r.id },
        data: { isPhoneVerified: true, otpCode: null, otpExpiry: null },
      });
      const partnerToken = signPartnerAccessToken(updated.id, p10);
      return res.json({ message: "Phone verified", role: bucket, token: partnerToken, data: updated });
    }

    const rider = await findRiderByPhone(phone);
    if (!rider) return res.status(404).json({ error: "Rider not found" });
    if (rider.approvalStatus === "REJECTED") {
      return res.status(403).json({ error: "Application rejected. Contact support." });
    }
    const updated = await prisma.rider.update({
      where: { id: rider.id },
      data: { isPhoneVerified: true, otpCode: null, otpExpiry: null },
    });
    return res.json({ message: "Phone verified", role: bucket, data: updated });
  } catch (error) {
    console.error("verify-otp:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🏪 RESTAURANT APIs 
// ==========================================

// 1. Partner Registration API (Status goes to PENDING)
app.post('/api/restaurants', async (req, res) => {
  try {
    const { name, ownerName, phone, email, address, fssaiNo, gstNo } = req.body;
    const phoneNorm = digitsOnlyPhone(phone) || String(phone || "").trim() || null;
    const newResto = await prisma.restaurant.create({ 
      data: { 
        name, ownerName, phone: phoneNorm, email, address, fssaiNo: fssaiNo || "",
        gstNo: gstNo == null || gstNo === "" ? null : String(gstNo).trim(),
        approvalStatus: "PENDING", isActive: true 
      } 
    });
    res.status(201).json({ message: "Registration submitted for review!", data: newResto });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. Customer App — approved & active outlets (online and offline; customer UI splits by isOnline)
app.get('/api/restaurants', async (req, res) => {
  try {
    const customerRestaurantWhere = { approvalStatus: "APPROVED", isActive: true };
    const [restaurants, outletOnlineCount, outletOfflineCount] = await Promise.all([
      prisma.restaurant.findMany({ where: customerRestaurantWhere }),
      prisma.restaurant.count({ where: { ...customerRestaurantWhere, isOnline: true } }),
      prisma.restaurant.count({ where: { ...customerRestaurantWhere, isOnline: false } }),
    ]);
    res.json({
      data: restaurants,
      meta: { outletOnlineCount, outletOfflineCount },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Partner / Admin API (सबको डेटा भेजेंगे)
app.get('/api/restaurants/all', async (req, res) => {
    try { 
      const restaurants = await prisma.restaurant.findMany();
      res.json({ data: restaurants }); 
    } catch (error) { res.status(500).json({ error: error.message }); }
});

/** Partner: daily hours (IST) + automatic online/offline. */
app.post("/api/restaurants/timings", requirePartner, async (req, res) => {
  try {
    const body = req.body || {};
    const restaurantId = String(body.restaurantId || "").trim();
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;

    const previousRestaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!previousRestaurant) return res.status(404).json({ error: "Restaurant not found" });

    const restaurantOpeningTime =
      body.openingTime != null ? String(body.openingTime).trim() : previousRestaurant.openingTime;
    const restaurantClosingTime =
      body.closingTime != null ? String(body.closingTime).trim() : previousRestaurant.closingTime;
    const restaurantAutoScheduleEnabled =
      body.isAutoToggleEnabled !== undefined
        ? Boolean(body.isAutoToggleEnabled)
        : previousRestaurant.isAutoToggleEnabled;

    const openingMinutes = parseTimeToMinutes(restaurantOpeningTime);
    const closingMinutes = parseTimeToMinutes(restaurantClosingTime);
    if (openingMinutes == null || closingMinutes == null) {
      return res.status(400).json({ error: "Opening and closing times must look like 10:00 or 22:30 (24-hour clock)." });
    }

    const updatePayload = {
      openingTime: restaurantOpeningTime,
      closingTime: restaurantClosingTime,
      isAutoToggleEnabled: restaurantAutoScheduleEnabled,
    };
    if (restaurantAutoScheduleEnabled) {
      const currentMinutesIst = getCurrentMinutesIst();
      updatePayload.isOnline = isWithinServingWindow(currentMinutesIst, openingMinutes, closingMinutes);
    }

    const updatedRestaurant = await prisma.restaurant.update({
      where: { id: restaurantId },
      data: updatePayload,
    });
    res.json({ message: "Timings saved.", data: updatedRestaurant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Partner: manual online/offline when automatic scheduling is off. */
app.post("/api/partner/outlet-live-status", requirePartner, async (req, res) => {
  try {
    const body = req.body || {};
    const restaurantId = String(body.restaurantId || "").trim();
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;
    if (body.isOnline === undefined) return res.status(400).json({ error: "isOnline is required" });

    const previousRestaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!previousRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    if (previousRestaurant.isAutoToggleEnabled) {
      return res.status(400).json({
        error: "Automatic open and close is on. Turn it off under timings to switch manually.",
      });
    }

    const updatedRestaurant = await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isOnline: Boolean(body.isOnline) },
    });
    res.json({ message: "Live status updated.", data: updatedRestaurant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🍔 MENU APIs (Updated for Advance Fields)
// ==========================================
app.post('/api/menu', requirePartner, async (req, res) => {
  try {
    const { restaurantId, name, fullPrice, halfPrice, hasHalf, quantityText, photoUrl, description, isVeg, category, price } = req.body;
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;
    
    // पुराने और नए फ्रंटएंड दोनों के लिए सपोर्ट (Fallback Logic)
    const finalFullPrice = fullPrice ? parseFloat(fullPrice) : parseFloat(price);

    /** Partner-originated catalog rows always enter moderator review (even if outlet is live). */
    const menuReviewStatus = "PENDING";

    const newItem = await prisma.menuItem.create({ 
      data: { 
        restaurantId, 
        name, 
        description: description || "", 
        fullPrice: finalFullPrice, 
        halfPrice: halfPrice ? parseFloat(halfPrice) : null,
        hasHalf: hasHalf || false,
        quantityText: quantityText || "1 Portion",
        photoUrl: photoUrl || "",
        category: category || "General", 
        isVeg: isVeg !== undefined ? isVeg : true,
        isAvailable: true,
        menuReviewStatus,
      } 
    });
    res.status(201).json({ message: "Menu Item Added!", data: newItem });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/** Update dish; re-queues menu for moderator review. */
app.put("/api/menu/:id", requirePartner, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const body = req.body || {};
    const restaurantId = String(body.restaurantId || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;

    const existing = await prisma.menuItem.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Menu item not found" });
    if (existing.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "This menu item does not belong to the given restaurant" });
    }

    const {
      name,
      fullPrice,
      halfPrice,
      hasHalf,
      quantityText,
      photoUrl,
      description,
      isVeg,
      category,
      isAvailable,
    } = body;

    const finalFullPrice =
      fullPrice !== undefined
        ? parseFloat(fullPrice)
        : existing.fullPrice;

    const updated = await prisma.menuItem.update({
      where: { id },
      data: {
        name: name !== undefined ? String(name) : existing.name,
        description: description !== undefined ? String(description || "") : existing.description,
        fullPrice: Number.isFinite(finalFullPrice) ? finalFullPrice : existing.fullPrice,
        halfPrice:
          halfPrice === null || halfPrice === ""
            ? null
            : halfPrice !== undefined
              ? parseFloat(halfPrice)
              : existing.halfPrice,
        hasHalf: hasHalf !== undefined ? Boolean(hasHalf) : existing.hasHalf,
        quantityText:
          quantityText !== undefined ? String(quantityText || "1 Portion") : existing.quantityText,
        photoUrl: photoUrl !== undefined ? String(photoUrl || "") : existing.photoUrl,
        category: category !== undefined ? String(category || "General") : existing.category,
        isVeg: isVeg !== undefined ? Boolean(isVeg) : existing.isVeg,
        isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : existing.isAvailable,
        menuReviewStatus: "PENDING",
      },
    });
    res.json({ message: "Menu item updated; pending review", data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/menu/:restaurantId', async (req, res) => {
  try { 
    const menu = await prisma.menuItem.findMany({ where: { restaurantId: req.params.restaurantId } });
    res.json(menu); 
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/menu/:id', requirePartner, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const restaurantId = req.query.restaurantId ? String(req.query.restaurantId).trim() : "";
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;
    const existing = await prisma.menuItem.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Menu item not found" });
    if (restaurantId && existing.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await prisma.menuItem.delete({ where: { id } });
    res.json({ message: "Item deleted successfully" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const menuDigitizeMulter = menuDigitizeUpload.array("files", 16);

app.post("/api/menu/digitize-bulk", (req, res, next) => {
  menuDigitizeMulter(req, res, (err) => {
    if (err) {
      console.error("digitize-bulk multer:", err.message);
      return res.status(400).json({ error: err.message || "File upload error" });
    }
    next();
  });
}, requirePartner, async (req, res) => {
  try {
    const restaurantId = req.body?.restaurantId ? String(req.body.restaurantId).trim() : "";
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;

    const files = req.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded (use field name: files)" });
    }

    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(503).json({ error: "GEMINI_API_KEY is not configured on the server" });
    }

    const prompt =
      "Extract menu items from these images. Output a JSON array only. " +
        "Each object: name (string), fullPrice (number), description (string, short one line under 120 chars, no quotes inside text), " +
        "isVeg (boolean), category (string). " +
        "If not using strict JSON mode: first character '[' last ']'; no markdown fences or commentary.";

    const contentParts = [{ text: prompt }];

    for (const file of files) {
      const mime = file.mimetype || "application/octet-stream";
      const b64 = file.buffer.toString("base64");
      if (mime.startsWith("image/")) {
        contentParts.push({ inlineData: { mimeType: mime, data: b64 } });
      } else if (mime === "application/pdf") {
        contentParts.push({ inlineData: { mimeType: "application/pdf", data: b64 } });
      } else if (
        mime.includes("xml") ||
        (file.originalname && String(file.originalname).toLowerCase().endsWith(".xml"))
      ) {
        const xmlText = file.buffer.toString("utf8");
        const snippet = xmlText.length > 12000 ? xmlText.slice(0, 12000) + "\n…[truncated]" : xmlText;
        contentParts.push({
          text: `Menu XML file "${file.originalname || "menu.xml"}":\n${snippet}`,
        });
      }
    }

    if (contentParts.length <= 1) {
      return res.status(400).json({
        error: "No supported files. Upload images (JPEG/PNG/WebP), PDF, or XML.",
      });
    }

    let rawText;
    try {
      rawText = await generateMenuDigitizeWithGemini(apiKey, contentParts);
    } catch (geminiErr) {
      console.error("Gemini digitize-bulk:", geminiErr);
      const hint =
        !process.env.GEMINI_API_KEY || !String(process.env.GEMINI_API_KEY).trim()
          ? "Set GEMINI_API_KEY in eater-backend/.env and restart the server."
          : "Backend now uses Google ListModels for your API key. Remove GEMINI_MODEL from .env to auto-pick a working model, or set GEMINI_MODEL=gemini-2.0-flash. Restart: npm run start. Check server logs for [digitize-bulk] ListModels.";
      return res.status(502).json({
        error: "Gemini API error",
        detail: geminiErr.message || String(geminiErr),
        hint,
      });
    }

    let parsed;
    try {
      parsed = parseMenuDigitizeAiJson(rawText);
    } catch (parseErr) {
      console.error(
        "digitize-bulk JSON parse:",
        parseErr.message,
        "len=",
        String(rawText || "").length,
        rawText?.slice(0, 400)
      );
      return res.status(502).json({
        error: "AI returned invalid JSON",
        detail: parseErr.message,
        preview: String(rawText).slice(0, 600),
      });
    }

    if (!Array.isArray(parsed)) {
      return res.status(502).json({
        error: "AI response must be a JSON array",
        preview: String(rawText).slice(0, 600),
      });
    }

    const created = [];
    for (const item of parsed) {
      const name = String(item?.name ?? "").trim();
      if (!name) continue;

      const fullPrice = Math.max(0, Number(item.fullPrice));
      const safePrice = Number.isFinite(fullPrice) ? fullPrice : 0;
      const description = String(item.description ?? "").trim().slice(0, 2000);
      const isVeg = item.isVeg !== false && item.isVeg !== "false" && item.isVeg !== 0;
      const category = String(item.category ?? "General").trim().slice(0, 120) || "General";

      try {
        const row = await prisma.menuItem.create({
          data: {
            restaurantId,
            name,
            description: description || null,
            fullPrice: safePrice,
            halfPrice: null,
            hasHalf: false,
            quantityText: "1 Portion",
            photoUrl: "",
            category,
            isVeg: Boolean(isVeg),
            isAvailable: true,
            menuReviewStatus: "PENDING",
          },
        });
        created.push(row);
      } catch (createErr) {
        console.error("digitize-bulk MenuItem create:", createErr.message, name);
      }
    }

    if (!created.length) {
      return res.status(422).json({
        error: "No menu rows could be created from AI output (check names/prices)",
        parsedCount: parsed.length,
      });
    }

    return res.status(201).json({
      message: `Created ${created.length} menu item(s)`,
      data: created,
    });
  } catch (error) {
    console.error("digitize-bulk:", error);
    return res.status(500).json({ error: error.message || "Digitize failed" });
  }
});

// ==========================================
// 📦 ORDER APIs 
// ==========================================

/** Rider remittance = delivery line (rider + handling) + GST attributable to that slice (matches customer bill). */
function computeRiderPayoutFromBreakdown(bb, roundMoney) {
  if (!bb || typeof bb !== "object") return 0;
  const deliveryFeeTotal = roundMoney(Number(bb.deliveryFeeTotal) || 0);
  const gstOnServiceFees = roundMoney(Number(bb.gstOnServiceFees) || 0);
  const taxableServiceFees = roundMoney(Number(bb.taxableServiceFees) || 0);
  const riderFee = roundMoney(Number(bb.riderFee) || 0);
  const deliveryHandlingFee = roundMoney(Number(bb.deliveryHandlingFee) || 0);
  const riderTaxBase = riderFee + deliveryHandlingFee;
  if (taxableServiceFees > 0 && gstOnServiceFees > 0 && riderTaxBase > 0) {
    return roundMoney(deliveryFeeTotal + (gstOnServiceFees * riderTaxBase) / taxableServiceFees);
  }
  return deliveryFeeTotal > 0 ? deliveryFeeTotal : 0;
}

app.post('/api/orders', async (req, res) => {
  try {
    const { userId, restaurantId, totalAmount, items, paymentMethod, paymentStatus, deliveryAddress, latitude, longitude } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: "Restaurant is required." });
    }

    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) {
      return res.status(400).json({ error: "This restaurant is not live for ordering." });
    }
    if (restaurant.approvalStatus !== "APPROVED") {
      return res.status(400).json({ error: "This restaurant is not approved for orders yet." });
    }
    if (!restaurant.isActive) {
      return res.status(400).json({ error: "This restaurant is not taking orders right now." });
    }
    if (!restaurant.isOnline) {
      const restaurantDisplayName = restaurant.name && String(restaurant.name).trim() ? String(restaurant.name).trim() : "This restaurant";
      return res.status(400).json({
        error: `⚠️ Order Failed. ${restaurantDisplayName} is currently offline and cannot accept orders. Check back during opening hours.`,
      });
    }

    const incomingItems = Array.isArray(items) ? items : [];
    if (!incomingItems.length) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const roundMoney = (n) => Math.round(Number(n) * 100) / 100;

    const parsed = incomingItems
      .map((it) => {
        const quantity = Math.max(1, Math.min(99, Number(it.quantity) || 1));
        const price = Number(it.price || it.fullPrice || it.unitPrice || 0);
        const menuItemId = String(it.menuItemId || it.id || "");
        const portion = String(it.portion || "FULL").toUpperCase() === "HALF" ? "HALF" : "FULL";
        return {
          menuItemId,
          quantity,
          clientUnitPrice: Number.isFinite(price) ? roundMoney(price) : 0,
          name: it.name || "Custom Item",
          portion,
        };
      })
      .filter((it) => it.menuItemId);

    // Merge duplicate lines (same dish + portion) — enterprise cart hygiene
    const mergeMap = new Map();
    for (const it of parsed) {
      const key = `${it.menuItemId}::${it.portion}`;
      if (!mergeMap.has(key)) mergeMap.set(key, { ...it });
      else {
        const cur = mergeMap.get(key);
        cur.quantity = Math.min(99, cur.quantity + it.quantity);
      }
    }
    const normalizedItems = [...mergeMap.values()];

    if (!normalizedItems.length) {
      return res.status(400).json({ error: "Invalid cart items." });
    }

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      await prisma.user.create({
        data: { id: userId, name: req.body.userName || "Guest", phone: req.body.userPhone || "0000000000", role: "CUSTOMER" }
      });
    }

    // Rule 9 — persist GPS pin as Address (optional; order flow continues if this fails)
    const latNum = latitude !== undefined && latitude !== null && latitude !== "" ? Number(latitude) : NaN;
    const lngNum = longitude !== undefined && longitude !== null && longitude !== "" ? Number(longitude) : NaN;
    const hasValidCoords =
      Number.isFinite(latNum) &&
      Number.isFinite(lngNum) &&
      latNum >= -90 &&
      latNum <= 90 &&
      lngNum >= -180 &&
      lngNum <= 180;
    if (hasValidCoords && userId) {
      const addrText =
        deliveryAddress && String(deliveryAddress).trim()
          ? String(deliveryAddress).trim()
          : `GPS pin (${latNum.toFixed(5)}, ${lngNum.toFixed(5)})`;
      try {
        await prisma.address.create({
          data: {
            userId,
            type: "GPS_PIN",
            fullAddress: addrText,
            latitude: latNum,
            longitude: lngNum,
          },
        });
      } catch (addrErr) {
        console.error("GPS Address create failed (order still proceeds):", addrErr.message);
      }
    }

    const existingRows = await prisma.menuItem.findMany({
      where: { id: { in: normalizedItems.map((it) => it.menuItemId) }, restaurantId },
      select: { id: true },
    });
    const knownMenuItemIds = new Set(existingRows.map((x) => x.id));

    // Some frontend flows can send demo/generated menu IDs; create placeholder items to keep order API resilient.
    for (const item of normalizedItems) {
      if (!knownMenuItemIds.has(item.menuItemId)) {
        await prisma.menuItem.create({
          data: {
            id: item.menuItemId,
            restaurantId,
            name: item.name,
            fullPrice: item.clientUnitPrice || 0,
            description: "Auto-created placeholder item from checkout flow.",
            isVeg: true,
            category: "General",
            isAvailable: true,
          },
        });
      }
    }

    const menuRows = await prisma.menuItem.findMany({
      where: { id: { in: normalizedItems.map((it) => it.menuItemId) }, restaurantId },
      select: { id: true, fullPrice: true, halfPrice: true, hasHalf: true, name: true },
    });
    const menuById = new Map(menuRows.map((m) => [m.id, m]));

    const pricedItems = normalizedItems.map((it) => {
      const row = menuById.get(it.menuItemId);
      let unit = it.clientUnitPrice;
      if (row) {
        const useHalf = it.portion === "HALF" && row.hasHalf && row.halfPrice != null && Number(row.halfPrice) > 0;
        unit = roundMoney(useHalf ? Number(row.halfPrice) : Number(row.fullPrice || 0));
      } else {
        unit = roundMoney(it.clientUnitPrice);
      }
      return {
        menuItemId: it.menuItemId,
        quantity: it.quantity,
        priceAtOrder: unit,
        name: it.name,
      };
    });

    const computedTotal = roundMoney(pricedItems.reduce((sum, it) => sum + it.priceAtOrder * it.quantity, 0));
    const clientTotal = roundMoney(Number(totalAmount) || 0);
    const safeTotalAmount = clientTotal > 0 && Math.abs(clientTotal - computedTotal) <= 0.05 * computedTotal + 1
      ? clientTotal
      : computedTotal;

    let finalTotalAmount = safeTotalAmount;
    let finalTaxAmount = roundMoney(safeTotalAmount * 0.05);
    let billBreakdownStored = null;

    const rawBb = req.body.billBreakdown;
    if (rawBb && typeof rawBb === "object") {
      const foodFromClient = roundMoney(Number(rawBb.foodSubtotal));
      const tolerance = Math.max(2, 0.1 * Math.max(computedTotal, 1));
      if (Number.isFinite(foodFromClient) && Math.abs(foodFromClient - computedTotal) <= tolerance) {
        const grand = roundMoney(Number(rawBb.grandTotal));
        if (Number.isFinite(grand) && grand >= computedTotal * 0.5) {
          finalTotalAmount = grand;
        }
        const gst = roundMoney(Number(rawBb.gstOnServiceFees));
        if (Number.isFinite(gst) && gst >= 0) {
          finalTaxAmount = gst;
        }
        const riderPayout = computeRiderPayoutFromBreakdown(rawBb, roundMoney);
        const enriched = {
          ...rawBb,
          version: Number(rawBb.version) || 1,
          serverFoodSubtotal: computedTotal,
          riderPayout,
        };
        billBreakdownStored = JSON.stringify(enriched);
      }
    }

    const initialEta = new Date(Date.now() + 45 * 60 * 1000);

    const newOrder = await prisma.order.create({
      data: {
        orderNumber: 'ETR-' + Math.floor(100000 + Math.random() * 900000),
        userId,
        restaurantId,
        totalAmount: finalTotalAmount,
        taxAmount: finalTaxAmount,
        paymentMethod: paymentMethod || "COD",
        paymentStatus: paymentStatus || "PENDING",
        deliveryAddress: deliveryAddress || "", // 👈 Address will be saved
        status: "PENDING",
        prepTime: 0,
        deliveryETA: initialEta,
        billBreakdown: billBreakdownStored,
        items: {
          create: pricedItems.map((it) => ({
            menuItemId: it.menuItemId,
            quantity: it.quantity,
            priceAtOrder: it.priceAtOrder,
          })),
        },
      },
      include: { items: true },
    });

    const fullOrder = await prisma.order.findUnique({
      where: { id: newOrder.id },
      include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
    });
    if (fullOrder) await notifyNewOrder(fullOrder);

    res.status(201).json(newOrder);
  } catch (error) { 
    console.error("🚨 Order Error:", error);
    res.status(500).json({ error: error.message }); 
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const partnerKitchen =
      req.query.partnerKitchen === "1" || String(req.query.partnerKitchen || "").toLowerCase() === "true";
    const scopeRestaurantId = String(req.query.restaurantId || "").trim();

    const clauses = [];
    if (scopeRestaurantId) {
      clauses.push({ restaurantId: scopeRestaurantId });
    }
    if (partnerKitchen) {
      clauses.push(prismaWherePartnerKitchenPaymentEligible());
    }

    const where = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { AND: clauses };

    const allOrders = await prisma.order.findMany({
      where,
      include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(allOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Rider app: same payment gate as kitchen — no ONLINE PENDING/FAILED orders in the pool. */
app.get("/api/orders/rider-requests", async (req, res) => {
  try {
    const riderVisibleOrders = await prisma.order.findMany({
      where: prismaWherePaymentVerifiedForDispatch(),
      include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(riderVisibleOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Customer poll: single order by id (must match `userId` query). Used after Paytm to confirm `paymentStatus` from verified callback. */
app.get("/api/orders/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "").trim();
    const userId = String(req.query.userId || "").trim();
    if (!orderId || !userId) {
      return res.status(400).json({ error: "orderId and userId are required" });
    }
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== userId) return res.status(403).json({ error: "Forbidden" });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Customer: mark an online order as failed if Paytm never completes (no restaurant alerts were sent for unpaid online). */
app.post("/api/orders/report-payment-failure", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const userId = String(req.body?.userId || "").trim();
    if (!orderId || !userId) {
      return res.status(400).json({ error: "orderId and userId are required" });
    }
    const existingOrder = await prisma.order.findUnique({ where: { id: orderId } });
    if (!existingOrder) return res.status(404).json({ error: "Order not found" });
    if (existingOrder.userId !== userId) return res.status(403).json({ error: "Forbidden" });
    if (String(existingOrder.paymentMethod || "").toUpperCase() !== "ONLINE") {
      return res.status(400).json({ error: "Only online checkout orders use this action" });
    }
    if (String(existingOrder.paymentStatus || "").toUpperCase() === "PAID") {
      return res.json({ ok: true, skipped: true, message: "Already paid" });
    }
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "PAYMENT_FAILED",
        paymentStatus: "FAILED",
      },
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/update-status', async (req, res) => {
  try {
    const { orderId, status, riderId } = req.body;
    const prev = await prisma.order.findUnique({ where: { id: orderId } });
    if (!prev) return res.status(404).json({ error: "Order not found" });

    const updateData = { status };
    if (riderId) updateData.riderId = riderId;
    if (req.body.prepTime != null && req.body.prepTime !== "") {
      const pt = parseInt(String(req.body.prepTime), 10);
      if (Number.isFinite(pt) && pt >= 0) updateData.prepTime = Math.min(240, pt);
    }

    await prisma.order.update({ where: { id: orderId }, data: updateData });
    const full = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
    });

    const ridersToSync = new Set();
    if (prev.riderId) ridersToSync.add(prev.riderId);
    if (full?.riderId) ridersToSync.add(full.riderId);
    for (const rid of ridersToSync) await syncRiderActiveOrdersCount(rid);

    if (full) {
      const tag = riderId ? " · Rider assigned/updated" : "";
      await notifyOrderRiderEvent(full, "ORDER_UPDATE", `Order ${full.orderNumber || full.id?.slice(-6)} → ${status}${tag}`);
    }
    res.json(full);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Partner / ops: extend promised delivery by 5 minutes */
app.post("/api/orders/extend-eta", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId is required" });
    const o = await prisma.order.findUnique({ where: { id: orderId } });
    if (!o) return res.status(404).json({ error: "Order not found" });
    const base = o.deliveryETA ? new Date(o.deliveryETA) : new Date();
    const next = new Date(base.getTime() + 5 * 60 * 1000);
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { deliveryETA: next },
    });
    res.json({
      message: "Delivery time extended by 5 minutes",
      deliveryETA: updated.deliveryETA,
      orderId: updated.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Customer: `cancelType: CUSTOMER_NO_REFUND` — no payment-gateway refund; paymentStatus unchanged.
 * Admin: valid admin Bearer — cancel until not OUT_FOR_DELIVERY/DELIVERED; clears riderId; syncs rider counts.
 */
app.post("/api/orders/cancel", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId is required" });
    const o = await prisma.order.findUnique({ where: { id: orderId } });
    if (!o) return res.status(404).json({ error: "Order not found" });

    const statusUpper = String(o.status || "").toUpperCase();
    const riderIdBefore = o.riderId;

    if (adminBearerIsValid(req)) {
      if (statusUpper === "OUT_FOR_DELIVERY" || statusUpper === "DELIVERED") {
        return res.status(400).json({
          error: "Cannot cancel: order is already out for delivery or delivered.",
        });
      }
      if (statusUpper === "CANCELLED") {
        return res.status(400).json({ error: "Order is already cancelled." });
      }
      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          riderId: null,
        },
      });
      if (riderIdBefore) await syncRiderActiveOrdersCount(riderIdBefore);
      return res.json({ ok: true, message: "Order cancelled by admin.", admin: true });
    }

    const cancelType = String(req.body?.cancelType || "").trim();
    if (cancelType !== "CUSTOMER_NO_REFUND") {
      return res.status(400).json({ error: "Invalid cancellation request." });
    }
    const userId = String(req.body?.userId || "").trim();
    if (!userId || userId !== o.userId) {
      return res.status(403).json({ error: "You can only cancel your own orders." });
    }
    const blockedCustomer = ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "REJECTED"];
    if (blockedCustomer.includes(statusUpper)) {
      return res.status(400).json({
        error: "This order can’t be cancelled here. Please contact support for help.",
      });
    }
    const allowedCustomer = ["PENDING", "ACCEPTED", "PREPARING", "READY"];
    if (!allowedCustomer.includes(statusUpper)) {
      return res.status(400).json({
        error: "This order can’t be cancelled here. Please contact support for help.",
      });
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "CANCELLED",
        riderId: null,
      },
    });
    if (riderIdBefore) await syncRiderActiveOrdersCount(riderIdBefore);

    res.json({
      ok: true,
      message: "Order cancelled.",
      noRefundPolicy: true,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🛵 RIDER REGISTRATION API
// ==========================================
app.post('/api/riders/register', async (req, res) => {
  try {
    const { name, phone, vehicleNumber } = req.body;
    const phoneCanonical = canonicalMobile(phone);
    if (!phoneCanonical || phoneCanonical.length !== 10) {
      return res.status(400).json({ error: "Valid 10-digit mobile number required." });
    }
    const existingRider = await findRiderByPhone(phoneCanonical);
    if (existingRider) {
      return res.status(400).json({
        error: "This number is already registered — open the Login tab and sign in.",
        hint: "LOGIN",
        messageEn: "This number is already registered — open the Login tab and sign in.",
      });
    }

    const newRider = await prisma.rider.create({
      data: { name, phone: phoneCanonical, vehicleNumber, approvalStatus: "PENDING" },
    });
    await createNotification({
      audience: "ADMIN",
      customerUserId: null,
      riderId: null,
      restaurantId: null,
      type: "RIDER_REGISTERED",
      title: `New rider signup: ${name}`,
      body: `${name} · ${phoneCanonical} · Vehicle ${vehicleNumber}\nComplete KYC pending in rider app.`,
      orderId: null,
    });
    res.status(201).json({ message: "Registration successful!", data: newRider });
  } catch (err) {
    if (err.code === "P2002" && String(err.meta?.target || "").includes("phone")) {
      return res.status(400).json({
        error: "This number is already registered — use Login.",
        hint: "LOGIN",
        messageEn: "This number is already registered — use Login.",
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/rider/profile", async (req, res) => {
  try {
    const q = req.query.phone;
    const phone = Array.isArray(q) ? q[0] : q;
    let decoded = phone ? String(phone).trim() : "";
    try {
      if (decoded) decoded = decodeURIComponent(decoded);
    } catch {
      /* use trimmed raw */
    }
    if (!decoded) return res.status(400).json({ error: "phone required" });
    const r = await findRiderByPhone(decoded);
    if (!r) {
      return res.status(404).json({
        error: "No rider found for this number. Register first.",
        messageEn: "No rider found for this number. Register first, or use the same format as registration (10-digit mobile).",
      });
    }
    res.json({ data: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rider/onboarding", async (req, res) => {
  try {
    const { phone, documents, messageToAdmin } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const r = await findRiderByPhone(phone);
    if (!r) return res.status(404).json({ error: "Rider not found" });
    const data = { kycSubmittedAt: new Date() };
    if (Array.isArray(documents) && documents.length) data.kycDocuments = JSON.stringify(documents);
    if (typeof messageToAdmin === "string" && messageToAdmin.trim()) data.riderLastMessage = messageToAdmin.trim();
    if (!data.kycDocuments && !data.riderLastMessage) {
      return res.status(400).json({ error: "Add at least one KYC document or a message." });
    }
    const updated = await prisma.rider.update({ where: { id: r.id }, data });
    const docCount = documents?.length || 0;
    await createNotification({
      audience: "ADMIN",
      customerUserId: null,
      riderId: null,
      restaurantId: null,
      type: "RIDER_KYC_SUBMITTED",
      title: `Approve rider: ${r.name}`,
      body: `${r.name} (${r.phone}) submitted KYC (${docCount} file(s)). Vehicle: ${r.vehicleNumber}\n${data.riderLastMessage || ""}`,
      orderId: null,
    });
    res.json({ data: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rider/duty", async (req, res) => {
  try {
    const { phone, onDuty } = req.body;
    const r = await findRiderByPhone(phone);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.approvalStatus !== "APPROVED") return res.status(400).json({ error: "Rider not approved yet" });
    const updated = await prisma.rider.update({ where: { id: r.id }, data: { onDuty: !!onDuty } });
    res.json({ data: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Notifications (poll). Query: audience=ADMIN | customerUserId= | riderId= | restaurantId= */
app.get("/api/notifications", async (req, res) => {
  try {
    const { audience, customerUserId, riderId, restaurantId, limit } = req.query;
    const take = Math.min(80, Math.max(1, parseInt(limit, 10) || 40));
    let where = {};
    if (audience === "ADMIN") where = { audience: "ADMIN" };
    else if (customerUserId) where = { audience: "CUSTOMER", customerUserId: String(customerUserId) };
    else if (riderId) where = { audience: "RIDER", riderId: String(riderId) };
    else if (restaurantId) where = { audience: "RESTAURANT", restaurantId: String(restaurantId) };
    else return res.status(400).json({ error: "Provide audience=ADMIN or customerUserId or riderId or restaurantId" });

    const list = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json({ data: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/notifications/read", async (req, res) => {
  try {
    const { id, ids } = req.body || {};
    if (Array.isArray(ids) && ids.length) {
      await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { read: true } });
      return res.json({ ok: true });
    }
    if (!id) return res.status(400).json({ error: "id or ids required" });
    await prisma.notification.update({ where: { id: String(id) }, data: { read: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 👑 SUPER ADMIN APIs
// ==========================================

// 1. App Stats (operations + revenue)
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [
      totalOrders,
      totalRestaurants,
      pendingRestaurants,
      approvedRestaurants,
      infoNeededRestaurants,
      rejectedRestaurants,
      totalUsers,
      totalRiders,
      pendingRiders,
      approvedRiders,
      ridersOnDuty,
      menuItemsPendingReview,
      totalCoupons,
      activeCoupons,
      deliveredOrders,
      statusGroups,
    ] = await Promise.all([
      prisma.order.count(),
      prisma.restaurant.count(),
      prisma.restaurant.count({ where: { approvalStatus: "PENDING" } }),
      prisma.restaurant.count({ where: { approvalStatus: "APPROVED" } }),
      prisma.restaurant.count({ where: { approvalStatus: "INFO_NEEDED" } }),
      prisma.restaurant.count({ where: { approvalStatus: "REJECTED" } }),
      prisma.user.count(),
      prisma.rider.count(),
      prisma.rider.count({ where: { approvalStatus: "PENDING" } }),
      prisma.rider.count({ where: { approvalStatus: "APPROVED" } }),
      prisma.rider.count({ where: { onDuty: true, approvalStatus: "APPROVED" } }),
      prisma.menuItem.count({ where: { menuReviewStatus: "PENDING" } }),
      prisma.coupon.count(),
      prisma.coupon.count({ where: { isActive: true } }),
      prisma.order.findMany({ where: { status: "DELIVERED" }, select: { totalAmount: true } }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const totalRevenue = deliveredOrders.reduce((acc, order) => acc + order.totalAmount, 0);
    const ordersByStatus = {};
    for (const row of statusGroups) {
      ordersByStatus[row.status] = row._count._all;
    }
    res.json({
      totalOrders,
      totalRestaurants,
      pendingRestaurants,
      approvedRestaurants,
      infoNeededRestaurants,
      rejectedRestaurants,
      totalUsers,
      totalRiders,
      pendingRiders,
      approvedRiders,
      ridersOnDuty,
      menuItemsPendingReview,
      totalCoupons,
      activeCoupons,
      totalRevenue,
      ordersByStatus,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1b. All customers (admin dashboard — full profile fields + counts)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        phone: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        isPhoneVerified: true,
        isEmailVerified: true,
        dpdpaConsent: true,
        bankDetails: true,
        _count: { select: { addresses: true, orders: true } },
      },
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Approve/Reject Restaurant
app.post('/api/admin/restaurant-status', requireAdmin, async (req, res) => {
  try {
    const { restaurantId, status, message } = req.body;
    const data = { approvalStatus: status };
    // Only persist admin message when non-empty (avoid wiping on Approve/Reject with "")
    if (message !== undefined && message !== null && String(message).trim() !== "") {
      data.adminMessage = String(message).trim();
    }
    const updated = await prisma.restaurant.update({
      where: { id: restaurantId },
      data,
    });
    res.json({ message: `Restaurant ${status} successfully!`, data: updated });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Approve partner menu items stuck in PENDING review (or set one item)
app.post('/api/admin/menu-review', requireAdmin, async (req, res) => {
  try {
    const { restaurantId, menuItemId, status } = req.body || {};
    const next = status === "PENDING" ? "PENDING" : "APPROVED";
    if (menuItemId) {
      const item = await prisma.menuItem.update({
        where: { id: String(menuItemId) },
        data: { menuReviewStatus: next },
      });
      return res.json({ message: "Menu item updated", data: item });
    }
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId or menuItemId required" });
    }
    const result = await prisma.menuItem.updateMany({
      where: { restaurantId: String(restaurantId), menuReviewStatus: "PENDING" },
      data: { menuReviewStatus: "APPROVED" },
    });
    return res.json({ message: "Pending menu items approved", count: result.count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Partner onboarding: save documents JSON + message to admin (signed-in outlet only)
app.post('/api/partner/onboarding', requirePartner, async (req, res) => {
  try {
    const { documents, messageToAdmin } = req.body || {};
    const r = await prisma.restaurant.findUnique({ where: { id: req.partner.restaurantId } });
    if (!r) return res.status(404).json({ error: "Restaurant not found" });
    const data = {};
    if (Array.isArray(documents) && documents.length) data.partnerDocuments = JSON.stringify(documents);
    if (typeof messageToAdmin === 'string' && messageToAdmin.trim()) data.partnerLastMessage = messageToAdmin.trim();
    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'Add at least one document or a message to admin.' });
    }
    const updated = await prisma.restaurant.update({ where: { id: r.id }, data });
    res.json({ data: updated });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/partner/restaurant', requirePartner, async (req, res) => {
  try {
    const r = await prisma.restaurant.findUnique({ where: { id: req.partner.restaurantId } });
    if (!r) return res.status(404).json({ error: "Not found" });
    res.json({ data: r });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Partner profile / bank — maker-checker: sensitive edits → approvalStatus PENDING */
app.post("/api/partner/update-profile", requirePartner, async (req, res) => {
  try {
    const body = req.body || {};
    const restaurantId = String(body.restaurantId || "").trim();
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;

    const prev = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!prev) return res.status(404).json({ error: "Restaurant not found" });

    const data = {};
    let needsReapproval = false;
    const strEq = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

    if (body.name !== undefined) {
      const n = String(body.name || "").trim();
      const nextName = n || prev.name;
      if (!strEq(prev.name, nextName)) needsReapproval = true;
      data.name = nextName;
    }
    if (body.ownerName !== undefined) {
      const v = body.ownerName == null ? null : String(body.ownerName).trim();
      if (!strEq(prev.ownerName, v)) needsReapproval = true;
      data.ownerName = v;
    }
    if (body.phone !== undefined) {
      const p =
        body.phone == null || body.phone === ""
          ? null
          : digitsOnlyPhone(body.phone) || String(body.phone).trim();
      if (!strEq(prev.phone, p)) needsReapproval = true;
      data.phone = p;
    }
    if (body.email !== undefined) {
      const em = normalizeEmailInput(body.email);
      if (em) {
        const clash = await prisma.restaurant.findFirst({
          where: { email: em, NOT: { id: restaurantId } },
        });
        if (clash) return res.status(400).json({ error: "Email already in use" });
      }
      if (!strEq(prev.email, em)) {
        needsReapproval = true;
        data.isEmailVerified = false;
      }
      data.email = em;
    }
    if (body.address !== undefined) {
      const v = body.address == null ? null : String(body.address).trim();
      if (!strEq(prev.address, v)) needsReapproval = true;
      data.address = v;
    }
    if (body.fssaiNo !== undefined) {
      const v = body.fssaiNo == null ? null : String(body.fssaiNo).trim();
      if (!strEq(prev.fssaiNo, v)) needsReapproval = true;
      data.fssaiNo = v;
    }
    if (body.gstNo !== undefined) {
      const v = body.gstNo == null || body.gstNo === "" ? null : String(body.gstNo).trim();
      if (!strEq(prev.gstNo, v)) needsReapproval = true;
      data.gstNo = v;
    }
    if (body.coverImageUrl !== undefined) {
      const v =
        body.coverImageUrl == null || body.coverImageUrl === ""
          ? null
          : String(body.coverImageUrl).trim();
      if (!strEq(prev.coverImageUrl, v)) needsReapproval = true;
      data.coverImageUrl = v;
    }
    if (body.bankDetails !== undefined) {
      const v = normalizeBankDetailsForStore(body.bankDetails);
      if (jsonFieldComparable(prev.bankDetails) !== jsonFieldComparable(v)) needsReapproval = true;
      data.bankDetails = v;
    }
    if (body.partnerDocuments !== undefined) {
      const v =
        typeof body.partnerDocuments === "string"
          ? body.partnerDocuments
          : JSON.stringify(body.partnerDocuments);
      if (jsonFieldComparable(prev.partnerDocuments) !== jsonFieldComparable(v)) {
        needsReapproval = true;
      }
      data.partnerDocuments = v;
    }
    if (body.partnerLastMessage !== undefined) {
      data.partnerLastMessage =
        body.partnerLastMessage == null ? null : String(body.partnerLastMessage).trim();
    }
    if (body.latitude !== undefined) data.latitude = body.latitude == null ? null : Number(body.latitude);
    if (body.longitude !== undefined) data.longitude = body.longitude == null ? null : Number(body.longitude);
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

    if (needsReapproval) data.approvalStatus = "PENDING";

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const updated = await prisma.restaurant.update({
      where: { id: restaurantId },
      data,
    });
    res.json({ message: "Profile updated", data: updated, requiresReapproval: needsReapproval });
  } catch (error) {
    console.error("partner/update-profile:", error);
    res.status(500).json({ error: error.message });
  }
});

/** Rider profile / bank / vehicle — bank or vehicle change → PENDING */
app.post("/api/rider/update-profile", async (req, res) => {
  try {
    const body = req.body || {};
    const riderId = String(body.riderId || "").trim();
    if (!riderId) return res.status(400).json({ error: "riderId is required" });

    const prev = await prisma.rider.findUnique({ where: { id: riderId } });
    if (!prev) return res.status(404).json({ error: "Rider not found" });

    const data = {};
    let needsReapproval = false;
    const strEq = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

    if (body.name !== undefined) {
      data.name = String(body.name || "").trim() || prev.name;
    }
    if (body.phone !== undefined) {
      if (body.phone == null || String(body.phone).trim() === "") {
        return res.status(400).json({ error: "phone cannot be empty for riders" });
      }
      const p = digitsOnlyPhone(body.phone) || String(body.phone).trim();
      if (!strEq(prev.phone, p)) {
        const phoneClash = await prisma.rider.findFirst({
          where: { phone: p, NOT: { id: riderId } },
        });
        if (phoneClash) return res.status(400).json({ error: "Phone already registered to another rider" });
        needsReapproval = true;
      }
      data.phone = p;
    }
    if (body.email !== undefined) {
      const em = normalizeEmailInput(body.email);
      if (em) {
        const clash = await prisma.rider.findFirst({
          where: { email: em, NOT: { id: riderId } },
        });
        if (clash) return res.status(400).json({ error: "Email already in use" });
      }
      if (!strEq(prev.email, em)) {
        needsReapproval = true;
        data.isEmailVerified = false;
      }
      data.email = em;
    }
    if (body.vehicleNumber !== undefined) {
      const v = String(body.vehicleNumber || "").trim();
      if (!strEq(prev.vehicleNumber, v)) needsReapproval = true;
      data.vehicleNumber = v || prev.vehicleNumber;
    }
    if (body.bankDetails !== undefined) {
      const v = normalizeBankDetailsForStore(body.bankDetails);
      if (jsonFieldComparable(prev.bankDetails) !== jsonFieldComparable(v)) needsReapproval = true;
      data.bankDetails = v;
    }
    if (body.kycDocuments !== undefined) {
      const v =
        typeof body.kycDocuments === "string" ? body.kycDocuments : JSON.stringify(body.kycDocuments);
      data.kycDocuments = v;
    }
    if (body.riderLastMessage !== undefined) {
      data.riderLastMessage =
        body.riderLastMessage == null ? null : String(body.riderLastMessage).trim();
    }
    if (body.latitude !== undefined) {
      const x = body.latitude == null ? null : Number(body.latitude);
      data.latitude = Number.isFinite(x) ? x : null;
    }
    if (body.longitude !== undefined) {
      const x = body.longitude == null ? null : Number(body.longitude);
      data.longitude = Number.isFinite(x) ? x : null;
    }

    if (needsReapproval) data.approvalStatus = "PENDING";

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const updated = await prisma.rider.update({ where: { id: riderId }, data });
    res.json({ message: "Profile updated", data: updated, requiresReapproval: needsReapproval });
  } catch (error) {
    console.error("rider/update-profile:", error);
    res.status(500).json({ error: error.message });
  }
});

/** Customer user profile */
app.post("/api/user/update-profile", async (req, res) => {
  try {
    const body = req.body || {};
    const userId = String(body.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const prev = await prisma.user.findUnique({ where: { id: userId } });
    if (!prev) return res.status(404).json({ error: "User not found" });

    const data = {};
    const strEq = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

    if (body.name !== undefined) {
      data.name = body.name == null ? null : String(body.name).trim();
    }
    if (body.email !== undefined) {
      const em = normalizeEmailInput(body.email);
      if (em) {
        const clash = await prisma.user.findFirst({
          where: { email: em, NOT: { id: userId } },
        });
        if (clash) return res.status(400).json({ error: "Email already in use" });
      }
      if (!strEq(prev.email, em)) data.isEmailVerified = false;
      data.email = em;
    }
    if (body.bankDetails !== undefined) {
      data.bankDetails = normalizeBankDetailsForStore(body.bankDetails);
    }
    if (body.latitude !== undefined) {
      const x = body.latitude == null ? null : Number(body.latitude);
      data.latitude = Number.isFinite(x) ? x : null;
    }
    if (body.longitude !== undefined) {
      const x = body.longitude == null ? null : Number(body.longitude);
      data.longitude = Number.isFinite(x) ? x : null;
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const updated = await prisma.user.update({ where: { id: userId }, data });
    res.json({ message: "Profile updated", data: updated });
  } catch (error) {
    console.error("user/update-profile:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Get all Riders
app.get('/api/admin/riders', requireAdmin, async (req, res) => {
  try { res.json(await prisma.rider.findMany()); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Approve/Reject Rider
app.post('/api/admin/rider-status', requireAdmin, async (req, res) => {
  try {
    const { riderId, status, message } = req.body;
    const data = { approvalStatus: status };
    if (message !== undefined && message !== null && String(message).trim() !== "") {
      data.adminMessage = String(message).trim();
    }
    const updated = await prisma.rider.update({ where: { id: riderId }, data });
    if (status === "APPROVED") {
      await createNotification({
        audience: "RIDER",
        customerUserId: null,
        riderId,
        restaurantId: null,
        type: "RIDER_APPROVED",
        title: "You are approved on Fresto",
        body: "You can go On Duty and accept delivery requests. Drive safe!",
        orderId: null,
      });
    } else if (status === "REJECTED") {
      await createNotification({
        audience: "RIDER",
        customerUserId: null,
        riderId,
        restaurantId: null,
        type: "RIDER_REJECTED",
        title: "Rider application update",
        body: updated.adminMessage || "Please contact support for details.",
        orderId: null,
      });
    } else if (status === "INFO_NEEDED") {
      await createNotification({
        audience: "RIDER",
        customerUserId: null,
        riderId,
        restaurantId: null,
        type: "RIDER_INFO_NEEDED",
        title: "More details required",
        body: updated.adminMessage || "Please open the rider app and update your KYC.",
        orderId: null,
      });
    }
    res.json({ message: `Rider ${status} successfully!`, data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Create Coupon — always platform-funded (admin / “jeb”); no restaurant wallet
app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
  try {
    const { code, discount, minOrderValue, type } = req.body;
    const newCoupon = await prisma.coupon.create({
      data: {
        code: String(code).toUpperCase(),
        discount: parseFloat(discount),
        minOrderValue: parseFloat(minOrderValue),
        type: type || "FLAT",
        fundedBy: "ADMIN",
        restaurantId: null,
        budget: null,
        isActive: true,
      },
    });
    res.status(201).json({ message: "Coupon Created!", data: newCoupon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Public active coupons (customer app)
app.get("/api/coupons/active", async (req, res) => {
  try {
    const list = await prisma.coupon.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partner: list platform live admin coupons + this outlet’s coupons
app.get("/api/partner/coupons", requirePartner, async (req, res) => {
  try {
    const restaurantId = String(req.query.restaurantId || "").trim();
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;
    const rest = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!rest) return res.status(404).json({ error: "Restaurant not found" });
    const [platformCoupons, partnerCoupons] = await Promise.all([
      prisma.coupon.findMany({
        where: { fundedBy: "ADMIN", restaurantId: null, isActive: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.coupon.findMany({
        where: { restaurantId },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    res.json({
      data: {
        platformCoupons,
        partnerCoupons,
        marketingWallet: rest.marketingWallet ?? 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partner: create draft offer (inactive until partner activates — reserves budget from marketingWallet)
app.post("/api/partner/coupons", requirePartner, async (req, res) => {
  try {
    const body = req.body || {};
    const restaurantId = String(body.restaurantId || "").trim();
    const code = String(body.code || "").trim();
    if (!code) {
      return res.status(400).json({ error: "code required" });
    }
    if (!assertPartnerOwnsRestaurant(req, res, restaurantId)) return;
    const rest = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!rest) return res.status(404).json({ error: "Restaurant not found" });
    const discount = parseFloat(body.discount);
    const minOrderValue = parseFloat(body.minOrderValue);
    if (!Number.isFinite(discount) || discount <= 0) {
      return res.status(400).json({ error: "Valid discount required" });
    }
    if (!Number.isFinite(minOrderValue) || minOrderValue < 0) {
      return res.status(400).json({ error: "Valid min order value required" });
    }
    const budget = body.budget == null || body.budget === "" ? 0 : parseFloat(body.budget);
    if (!Number.isFinite(budget) || budget < 0) {
      return res.status(400).json({ error: "budget must be a number ≥ 0 (₹ reserved when offer is live)" });
    }
    const newCoupon = await prisma.coupon.create({
      data: {
        code: code.toUpperCase(),
        discount,
        minOrderValue,
        type: body.type || "FLAT",
        fundedBy: "PARTNER",
        restaurantId,
        budget,
        isActive: false,
      },
    });
    res.status(201).json({ message: "Offer created (inactive). Activate from Offers tab.", data: newCoupon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partner: activate / deactivate own offer (wallet escrow when budget > 0)
app.post("/api/partner/coupon-toggle", requirePartner, async (req, res) => {
  try {
    const { couponId, restaurantId, isActive } = req.body || {};
    const cid = String(couponId || "").trim();
    const rid = String(restaurantId || "").trim();
    if (!cid || !rid) return res.status(400).json({ error: "couponId and restaurantId required" });
    if (!assertPartnerOwnsRestaurant(req, res, rid)) return;
    const wantActive = Boolean(isActive);

    const coupon = await prisma.coupon.findUnique({ where: { id: cid } });
    if (!coupon || coupon.restaurantId !== rid || coupon.fundedBy !== "PARTNER") {
      return res.status(403).json({ error: "Not your outlet’s partner offer" });
    }

    const budget = Number(coupon.budget || 0);

    if (wantActive && coupon.isActive) {
      return res.json({ message: "Already active", data: coupon });
    }
    if (!wantActive && !coupon.isActive) {
      return res.json({ message: "Already inactive", data: coupon });
    }

    if (wantActive) {
      if (budget > 0) {
        const rest = await prisma.restaurant.findUnique({ where: { id: rid } });
        if (!rest || (rest.marketingWallet ?? 0) < budget) {
          return res.status(400).json({
            error: "Insufficient marketing wallet",
            hint: "Add credits via admin or reduce campaign budget.",
            marketingWallet: rest?.marketingWallet ?? 0,
            required: budget,
          });
        }
        const [updatedRest, updatedCoupon] = await prisma.$transaction([
          prisma.restaurant.update({
            where: { id: rid },
            data: { marketingWallet: { decrement: budget } },
          }),
          prisma.coupon.update({ where: { id: cid }, data: { isActive: true } }),
        ]);
        return res.json({
          message: "Offer live — budget reserved from your wallet",
          data: updatedCoupon,
          marketingWallet: updatedRest.marketingWallet,
        });
      }
      const updatedCoupon = await prisma.coupon.update({ where: { id: cid }, data: { isActive: true } });
      const rest = await prisma.restaurant.findUnique({ where: { id: rid } });
      return res.json({ data: updatedCoupon, marketingWallet: rest?.marketingWallet ?? 0 });
    }

    // deactivate
    if (coupon.isActive && budget > 0) {
      const [updatedRest, updatedCoupon] = await prisma.$transaction([
        prisma.restaurant.update({
          where: { id: rid },
          data: { marketingWallet: { increment: budget } },
        }),
        prisma.coupon.update({ where: { id: cid }, data: { isActive: false } }),
      ]);
      return res.json({
        message: "Offer paused — budget returned to wallet",
        data: updatedCoupon,
        marketingWallet: updatedRest.marketingWallet,
      });
    }
    const updatedCoupon = await prisma.coupon.update({ where: { id: cid }, data: { isActive: false } });
    const rest = await prisma.restaurant.findUnique({ where: { id: rid } });
    return res.json({ data: updatedCoupon, marketingWallet: rest?.marketingWallet ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get All Coupons
app.get('/api/admin/coupons', requireAdmin, async (req, res) => {
  try { res.json(await prisma.coupon.findMany()); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. Toggle Coupon Status — admin only for platform (ADMIN-funded) coupons
app.post('/api/admin/coupon-toggle', requireAdmin, async (req, res) => {
  try {
    const { couponId, isActive } = req.body;
    const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    if (coupon.fundedBy === "PARTNER" && coupon.restaurantId) {
      return res.status(400).json({
        error: "Partner-funded offers must be activated or paused from the Partner app.",
      });
    }
    const updated = await prisma.coupon.update({ where: { id: couponId }, data: { isActive: Boolean(isActive) } });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 💰 RIDER PAYMENT SETTLEMENT
app.post('/api/admin/settle-rider', requireAdmin, async (req, res) => {
  try {
    const { riderId, txnId } = req.body;
    const updated = await prisma.order.updateMany({
      where: { riderId: riderId, status: "DELIVERED", riderPaymentStatus: "PENDING" },
      data: { riderPaymentStatus: "PAID", riderTxnId: txnId }
    });
    res.json({ message: "Paid!", count: updated.count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 🏦 RESTAURANT PAYMENT SETTLEMENT
app.post('/api/admin/settle-restaurant', requireAdmin, async (req, res) => {
  try {
    const { restaurantId, txnId } = req.body;
    const updated = await prisma.order.updateMany({
      where: { restaurantId: restaurantId, status: "DELIVERED", restaurantPaymentStatus: "PENDING" },
      data: { restaurantPaymentStatus: "PAID", restaurantTxnId: txnId }
    });
    res.json({ message: "Paid!", count: updated.count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 💳 PAYTM (sandbox / production)
// ==========================================

/** Start Paytm: returns txn token and fields for JS Checkout / payment page */
app.post("/api/payment/paytm-initiate", async (req, res) => {
  try {
    if (!isPaytmReady()) {
      return res.status(503).json({
        error: "Paytm is not configured on the server",
        hint: "Set PAYTM_MID, PAYTM_MERCHANT_KEY, PAYTM_WEBSITE, and PAYTM_CALLBACK_URL (or APP_PUBLIC_URL).",
      });
    }
    const { orderId, userId } = req.body || {};
    const result = await initiatePaytmForOrder(prisma, { orderId, userId });
    res.json({
      success: true,
      data: result,
    });
  } catch (e) {
    const code = e.code || "";
    const msg = e.message || String(e);
    if (code === "BAD_REQUEST") return res.status(400).json({ error: msg });
    if (code === "NOT_FOUND") return res.status(404).json({ error: msg });
    if (code === "FORBIDDEN") return res.status(403).json({ error: msg });
    if (code === "PAYTM_NOT_CONFIGURED") return res.status(503).json({ error: msg });
    if (
      code === "PAYTM_INIT_FAILED" ||
      code === "PAYTM_BAD_RESPONSE" ||
      code === "PAYTM_NO_TOKEN" ||
      code === "PAYTM_CHECKSUM_ERROR"
    ) {
      console.error("[POST /api/payment/paytm-initiate] → 502:", msg, {
        code,
        resultCode: e.resultCode,
        detail: e.detail,
      });
      return res.status(502).json({
        error: msg,
        resultCode: e.resultCode,
        detail: e.detail,
      });
    }
    console.error("[POST /api/payment/paytm-initiate] → 500:", e);
    res.status(500).json({ error: msg || "Paytm initiate failed" });
  }
});

/**
 * Paytm server-to-server callback after the customer pays (or the payment fails).
 * Paytm usually sends a normal HTML form post (not JSON).
 */
app.post("/api/payment/paytm-callback", async (req, res) => {
  try {
    const outcome = await handlePaytmCallback(prisma, req.body);
    const { notifyRestaurantKitchen, orderId: paidOrderId, ...outcomeJson } = outcome || {};
    if (notifyRestaurantKitchen && paidOrderId) {
      const fullPaidOrder = await prisma.order.findUnique({
        where: { id: paidOrderId },
        include: { user: true, restaurant: true, rider: true, items: { include: { menuItem: true } } },
      });
      if (fullPaidOrder && isPaymentVerifiedForDispatch(fullPaidOrder)) {
        await notifyRestaurantKitchenNewOrder(fullPaidOrder);
      }
    }
    res.json(outcomeJson);
  } catch (e) {
    const code = e.code || "";
    if (code === "CHECKSUM_FAIL") return res.status(400).json({ error: e.message });
    if (code === "NOT_FOUND") return res.status(404).json({ error: e.message });
    if (code === "BAD_REQUEST" || code === "AMOUNT_MISMATCH") return res.status(400).json({ error: e.message });
    if (code === "PAYTM_NOT_CONFIGURED") return res.status(503).json({ error: e.message });
    console.error("paytm-callback:", e);
    res.status(500).json({ error: e.message || "Paytm callback failed" });
  }
});

(async () => {
  try {
    const riders = await prisma.rider.findMany({ select: { id: true } });
    for (const { id } of riders) await syncRiderActiveOrdersCount(id);
    if (riders.length) console.log(`✅ Rider activeOrdersCount reconciled for ${riders.length} rider(s)`);
  } catch (e) {
    console.warn("Rider activeOrdersCount backfill skipped:", e?.message || e);
  }
})();

startRestaurantHoursScheduler(prisma);

const httpServer = http.createServer(app);
attachLiveChatSocket(httpServer);
httpServer.listen(PORT, () => console.log(`✅ Fresto backend running at http://localhost:${PORT}`));