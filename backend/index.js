import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db, initDb } from "./db.js";
import { parseJsonSafe, normalizeTextForMatch, getCompanyCatalogCurrency, formatChatMoney, normalizeWhatsappFromNumber, isReserved, isHumanTrigger, newOrderId, roundMoney } from "./services/utils.js";
import { paymentMethodsPromptText, paymentMethodsReplyText, normalizePaymentMethodInput, paymentMethodLabel, paymentMethodSelectionPrompt, extractCheckoutFieldsFromText } from "./services/payment.js";
import { pickCatalogEmoji, buildCatalogCategoryPathFromItem, normalizeCatalogEntries, extractCatalogSelectionsFromText, summarizeCatalogSelection, buildCatalogInfoReply, buildCatalogFilteredReply, contextualCheckoutFallback, looksLikeCheckoutOperationalMessage, formatCatalogChoices } from "./services/catalog.js";
import { CART_REMINDER_AFTER_MS, appendOrderNote, resolvePendingSessionOrder, resolveRecentReceiptOrder, markRecentOrder, clearCheckoutProgress, createOrUpdateCheckoutOrder, buildOrderRegisteredReply, logWhatsappMessage, backfillOrdersWorkflowColumns } from "./services/order.js";
import { withUserLock, getSession, saveSession } from "./services/session.js";
import createApiRouter from "./routes/api.js";

dotenv.config();

console.log("BOOT VERSION:", "2026-02-03-INDEX-DASH-V1");
console.log("BOOT FILE:", import.meta.url);
console.log("PWD:", process.cwd());

const app = express();
app.use(express.urlencoded({ extended: false }));

app.use(express.json());

const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();

// ================= TELEGRAM =================
import { sendTelegram as _sendTelegram } from "./services/telegram.js";
import { notifyTelegramOrderCreated as _notifyTelegramOrderCreated } from "./services/order.js";

// Fire-and-forget: los fallos de Telegram nunca bloquean el flujo del cliente
const sendTelegram = (text) => _sendTelegram(text).catch((e) => console.error("[telegram] sendTelegram failed:", e?.message || e));
const notifyTelegramOrderCreated = (company, from, created) => _notifyTelegramOrderCreated(company, from, created).catch((e) => console.error("[telegram] notifyTelegramOrderCreated failed:", e?.message || e));

// ================= EMAIL =================
import { notifyEmailOrderCreated as _notifyEmailOrderCreated } from "./services/email.js";

// Fire-and-forget: los fallos de email nunca bloquean el flujo del cliente
const notifyEmailOrderCreated = (company, from, created) => _notifyEmailOrderCreated(company, from, created).catch((e) => console.error("[email] notifyEmailOrderCreated failed:", e?.message || e));

// ================= DB INIT =================
const DB_STARTUP_TIMEOUT_MS = Number(process.env.DB_STARTUP_TIMEOUT_MS || 15000);
let dbInitReady = false;
let dbInitError = null;

async function withStartupTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${DB_STARTUP_TIMEOUT_MS}ms`)), DB_STARTUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function initializeDatabase() {
  try {
    await withStartupTimeout(initDb(), "initDb");
    dbInitReady = true;
    dbInitError = null;
    console.log("DB init OK");
  } catch (e) {
    dbInitReady = false;
    dbInitError = e;
    console.error("DB init failed:", e?.message || e);
  }
}

const dbInitPromise = initializeDatabase();

// ================= OPENAI =================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_GLOBAL = (process.env.AI_GLOBAL || "on").trim().toLowerCase();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 15000);
const BOT_CATALOG_PROVIDER_ID = (process.env.BOT_CATALOG_PROVIDER_ID || "babystepsbots").trim().toLowerCase();

// ================= ADMIN =================
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
const isAdmin = (from) => ADMIN_NUMBER && from === ADMIN_NUMBER;

// ================= DB HELPERS =================
const getSetting = async (k) => (await db.prepare(`SELECT value FROM settings WHERE key=?`).get(k))?.value || "";
const setSetting = async (k, v) =>
  await db.prepare(`
    INSERT INTO settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(k, String(v ?? ""));

const getCompany = async (id) => {
  const r = await db.prepare(`SELECT * FROM companies WHERE id=?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    catalog: JSON.parse(r.catalogJson || "[]"),
    rules: JSON.parse(r.rulesJson || "{}"),
  };
};

async function getCompanySafe(session) {
  const fallback = await getCompany("babystepsbots");
  const id = String(session?.data?.companyId || "babystepsbots").toLowerCase();
  return (await getCompany(id)) || fallback;
}

function isSubscriptionActive(company) {
  const id = String(company?.id || "").toLowerCase();
  if (!id || id === "babystepsbots") return true;
  const rules = parseJsonSafe(company?.rulesJson || "{}", {});
  const status = String(rules?.subscriptionStatus || "Activa").trim().toLowerCase();
  const inactive = ["inactiva", "cancelada", "suspendida", "inactive", "cancelled", "canceled", "suspended"].includes(status);
  if (inactive) return false;
  const endAt = rules?.subscriptionCurrentEnd;
  if (endAt) {
    const endDate = new Date(endAt);
    if (!isNaN(endDate.getTime()) && endDate < new Date()) return false;
  }
  return true;
}

// ─── Maintenance mode ─────────────────────────────────────────────────────────
let _maintenanceCacheValue = null;
let _maintenanceCacheAt = 0;
const MAINTENANCE_CACHE_TTL = 30 * 1000; // 30 seconds

async function isBotInMaintenance() {
  const now = Date.now();
  if (_maintenanceCacheValue !== null && now - _maintenanceCacheAt < MAINTENANCE_CACHE_TTL) {
    return _maintenanceCacheValue;
  }
  try {
    const val = await getSetting("maintenance_mode");
    _maintenanceCacheValue = val === "1";
    _maintenanceCacheAt = now;
    return _maintenanceCacheValue;
  } catch {
    return false;
  }
}

function invalidateMaintenanceCache() {
  _maintenanceCacheValue = null;
  _maintenanceCacheAt = 0;
}

// ─── Rate limiting (per-customer, per-company, in-memory) ────────────────────
const _rlMap = new Map(); // key "companyId:from" → { count, windowStart }
const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(companyId, from, limitPerHour) {
  const limit = Math.max(1, Number(limitPerHour) || 0);
  if (!limit) return { ok: true, count: 0 }; // 0 = disabled
  const key = `${companyId}:${from}`;
  const now = Date.now();
  const entry = _rlMap.get(key);
  if (!entry || now - entry.windowStart >= RL_WINDOW_MS) {
    _rlMap.set(key, { count: 1, windowStart: now });
    return { ok: true, count: 1, remaining: limit - 1 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    const resetIn = Math.ceil((entry.windowStart + RL_WINDOW_MS - now) / 60000);
    return { ok: false, count: entry.count, resetInMinutes: resetIn };
  }
  return { ok: true, count: entry.count, remaining: limit - entry.count };
}

// ─── Business hours ──────────────────────────────────────────────────────────
function isWithinBusinessHours(company) {
  const rules = parseJsonSafe(company?.rulesJson || "{}", {});
  if (!rules.businessHoursEnabled) return true;

  const tz = String(rules.businessHoursTz || "America/Argentina/Buenos_Aires").trim();
  const startStr = String(rules.businessHoursStart || "00:00").trim();
  const endStr = String(rules.businessHoursEnd || "23:59").trim();
  const enabledDays = Array.isArray(rules.businessHoursDays)
    ? rules.businessHoursDays.map(Number)
    : [0, 1, 2, 3, 4, 5, 6];

  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const weekdayStr = (parts.find((p) => p.type === "weekday")?.value || "").toLowerCase().slice(0, 3);
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const current = hour * 60 + minute;

    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    const start = (sh || 0) * 60 + (sm || 0);
    const end = (eh || 0) * 60 + (em || 0);

    if (!enabledDays.includes(dayOfWeek)) return false;
    if (current < start || current >= end) return false;
    return true;
  } catch {
    return true; // on error, don't block
  }
}

// ─── FAQ matching ─────────────────────────────────────────────────────────────
function findFaqMatch(text, faqItems) {
  if (!Array.isArray(faqItems) || !faqItems.length) return null;
  const msgLower = String(text || "").toLowerCase();
  for (const item of faqItems) {
    const q = String(item.question || "").toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) continue;
    const matches = words.filter((w) => msgLower.includes(w));
    if (matches.length >= Math.ceil(words.length * 0.5)) {
      const answer = String(item.answer || "").trim();
      if (answer) return answer;
    }
  }
  return null;
}

// ================= TEXT HELPERS =================
const menuText = (c) => {
  const rules = parseJsonSafe(c?.rulesJson || "{}", {});
  const custom = String(rules?.welcomeMessage || "").trim();
  if (custom) return custom;
  return `${String.fromCodePoint(0x1F44B)} Hola! Soy el asistente de ${c.name}\n- catalogo\n- carrito\n- checkout\n- humano`;
};


const catalogText = (c) =>
  `Catalogo ${c.name}\n` +
  (c.catalog || []).map((p, idx) => {
    const category = buildCatalogCategoryPathFromItem(p);
    const suffix = category !== "-" ? ` [${category}]` : "";
    const price = formatChatMoney(p?.price || 0, getCompanyCatalogCurrency(c));
    return `${pickCatalogEmoji(p, idx)} ${p.name} - ${price}${suffix}`;
  }).join("\n") +
  `\n\nPara comprar, escribi el nombre del producto o su ID.`;

const cartText = async (s) => {
  const c = await getCompanySafe(s);
  if (!s.cart.length) return `${String.fromCodePoint(0x1F9FA)} Carrito vacio.`;
  let total = 0;
  const out = {};
  s.cart.forEach((item) => {
    const id = typeof item === "object" ? item.id : item;
    const lockedPrice = typeof item === "object" ? item.price : null;
    const key = Number(id);
    if (!out[key]) out[key] = { qty: 0, lockedPrice };
    out[key].qty += 1;
  });
  const lines = Object.entries(out).map(([id, { qty, lockedPrice }]) => {
    const p = (c.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = lockedPrice != null ? lockedPrice : Number(p?.price || 0);
    const sub = unit * qty;
    total += sub;
    return `- ${p?.name || "Producto"} x${qty} - ${formatChatMoney(sub, getCompanyCatalogCurrency(c))}`;
  });
  return `${String.fromCodePoint(0x1F9FE)} ${c.name}\n${lines.join("\n")}\nTotal: ${formatChatMoney(total, getCompanyCatalogCurrency(c))}`;
};

// ================= AI =================
function aiModeProfile(modeRaw) {
  const mode = String(modeRaw || "").toLowerCase();
  if (mode === "pro") {
    return {
      dailyLimit: 120,
      memoryMessages: 24,
      memoryChars: 12000,
    };
  }
  return {
    dailyLimit: 40,
    memoryMessages: 8,
    memoryChars: 3500,
  };
}

function normalizeAiHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : "user",
      content: String(item?.content || "").trim(),
    }))
    .filter((item) => item.content);
}

function trimAiHistoryForProfile(history, profile) {
  const maxMessages = Math.max(0, Number(profile?.memoryMessages || 0));
  const maxChars = Math.max(0, Number(profile?.memoryChars || 0));
  if (!maxMessages || !maxChars) return [];

  let chars = 0;
  const selected = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    const nextChars = chars + item.content.length;
    if (selected.length >= maxMessages) break;
    if (nextChars > maxChars && selected.length > 0) break;
    selected.push(item);
    chars = nextChars;
  }
  return selected.reverse();
}

async function aiReply(session, from, text) {
  if (!openai || AI_GLOBAL === "off") return null;

  const aiMode = String(session.data.aiMode || "").toLowerCase();
  const profile = ["lite", "pro"].includes(aiMode)
    ? aiModeProfile(aiMode)
    : { dailyLimit: 80, memoryMessages: 30, memoryChars: 20000 };

  // Resetear contador si es un dia nuevo
  const todayStr = new Date().toISOString().slice(0, 10);
  if (session.data.aiCountDate !== todayStr) {
    session.data.aiCount = 0;
    session.data.aiCountDate = todayStr;
  }

  // Verificar limite diario
  const currentCount = Number(session.data.aiCount || 0);
  if (profile.dailyLimit && currentCount >= profile.dailyLimit) {
    return "Llegaste al límite de consultas de hoy. Mañana se renueva tu cuota o podés hablar con nosotros para ampliarla.";
  }

  const c = await getCompanySafe(session);
  const paymentPrompt = paymentMethodsPromptText(c);
  const currency = getCompanyCatalogCurrency(c);
  const companyRules = parseJsonSafe(c?.rulesJson || "{}", {});
  const companyDescription = String(companyRules?.companyDescription || "").trim();
  const businessHoursText = String(companyRules?.businessHoursText || "").trim();
  const prompt = `
${c.prompt || ""}
${companyDescription ? `\nDESCRIPCION DE LA EMPRESA:\n${companyDescription}` : ""}
${businessHoursText ? `\nHORARIO DE ATENCION:\n${businessHoursText}` : ""}

CATALOGO:
${(c.catalog || []).map((p) => `${p.id}) ${p.name}: ${formatChatMoney(p.price, currency)}`).join("\n")}

Reglas:
- Tono: ${companyRules?.tone || (c.rules || {}).tone || "neutral"}
- No inventar datos
- Responde de forma natural y util
- Si el cliente pregunta por productos, explica diferencias y beneficios de cada opcion
- Si el cliente quiere comprar, propon siguiente paso claro sin bloquear la conversacion
`;

  const history = normalizeAiHistory(session.data.aiHistory || []);
  const memoryWindow = trimAiHistoryForProfile(history, profile);
  const inputMessages = [
    ...memoryWindow.map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: text },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const resp = await openai.responses.create(
      {
        model: "gpt-4o-mini",
        input: inputMessages,
        instructions: `${prompt}\nMEDIOS DE PAGO:\n${paymentPrompt}`,
      },
      { signal: controller.signal }
    );

    const answer = (resp.output_text || "").trim();
    session.data.aiCount = Number(session.data.aiCount || 0) + 1;
    session.data.aiHistory = [
      ...history,
      { role: "user", content: String(text || "").trim(), at: new Date().toISOString() },
      { role: "assistant", content: answer || "Sin respuesta.", at: new Date().toISOString() },
    ].slice(-180);
    await saveSession(session);

    return answer || null;
  } catch (e) {
    if (e?.name === "AbortError" || controller.signal.aborted) {
      console.error(`aiReply timeout after ${OPENAI_TIMEOUT_MS}ms`);
    } else {
      console.error("aiReply failed:", e?.message || e);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}


// ================= BOT / SUBSCRIPTION =================
function normalizePlanTierFromText(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("pro")) return "PRO";
  if (raw.includes("lite")) return "LITE";
  if (raw.includes("basic") || raw.includes("basico") || raw.includes("sin ai") || raw.includes("base")) return "BASICO";
  return "";
}

function normalizeChannelModeFromText(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("unifi") || raw.includes("multi")) return "combinado";
  if (raw.includes("comb")) return "combinado";
  if (raw.includes("insta")) return "instagram";
  if (raw.includes("what")) return "whatsapp";
  return "";
}

function channelsFromMode(mode) {
  if (mode === "combinado") return ["whatsapp", "instagram"];
  if (mode === "instagram") return ["instagram"];
  return ["whatsapp"];
}

function aiModeFromPlanTier(tierRaw) {
  const tier = String(tierRaw || "").trim().toUpperCase();
  if (tier === "PRO") return "pro";
  if (tier === "LITE") return "lite";
  return "off";
}

function resolveAiModeFromRules(rulesRaw) {
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  const tierMode = aiModeFromPlanTier(rules.planTier);
  if (tierMode !== "off") return tierMode;
  const inferredTier = normalizePlanTierFromText(
    String(rules.botClass || rules.subscriptionPlan || rules.planName || "")
  );
  const inferredMode = aiModeFromPlanTier(inferredTier);
  if (inferredMode !== "off") return inferredMode;
  if (rules.aiEnabled === true) return "lite";
  return "off";
}

function resetAiMemoryForMode(data) {
  data.aiCount = 0;
  data.aiCountDate = "";
  data.aiHistory = [];
  data.lastAiAt = 0;
}

function applyCompanyAiModeToSessionData(dataRaw, nextModeRaw, options = {}) {
  const { force = false, source = "company-rules" } = options;
  const data = dataRaw && typeof dataRaw === "object" ? dataRaw : {};
  if (!force && data.aiModeManual === true) {
    return { changed: false, skippedManual: true, mode: String(data.aiMode || "off").toLowerCase() };
  }
  const currentMode = ["lite", "pro"].includes(String(data.aiMode || "").toLowerCase())
    ? String(data.aiMode || "").toLowerCase()
    : "off";
  const nextMode = ["lite", "pro"].includes(String(nextModeRaw || "").toLowerCase())
    ? String(nextModeRaw || "").toLowerCase()
    : "off";
  let changed = false;
  if (force && data.aiModeManual) { delete data.aiModeManual; changed = true; }
  if (data.aiModeSource !== source) { data.aiModeSource = source; changed = true; }
  if (currentMode !== nextMode) { data.aiMode = nextMode; resetAiMemoryForMode(data); changed = true; }
  return { changed, skippedManual: false, mode: nextMode };
}

async function syncSessionAiModeFromCompany(session, options = {}) {
  const company = await getCompanySafe(session);
  const mode = resolveAiModeFromRules(company?.rules || {});
  const result = applyCompanyAiModeToSessionData(session.data, mode, {
    ...options,
    source: `company:${String(company?.id || "").toLowerCase() || "unknown"}`,
  });
  return { ...result, companyId: String(company?.id || "").toLowerCase() };
}

async function syncCompanySessionsAiMode(companyIdRaw, rulesRaw, options = {}) {
  const { force = false } = options;
  const companyId = String(companyIdRaw || "").trim().toLowerCase();
  if (!companyId) return { mode: "off", scanned: 0, updated: 0, skippedManual: 0 };
  const mode = resolveAiModeFromRules(rulesRaw || {});
  const rows = await db.prepare(`SELECT fromNumber,dataJson FROM sessions`).all();
  let scanned = 0, updated = 0, skippedManual = 0;
  for (const row of rows) {
    const data = parseJsonSafe(row?.dataJson || "{}", {});
    const rowCompanyId = String(data?.companyId || "babystepsbots").trim().toLowerCase();
    if (rowCompanyId !== companyId) continue;
    scanned += 1;
    const result = applyCompanyAiModeToSessionData(data, mode, { force, source: `company:${companyId}` });
    if (result.skippedManual) { skippedManual += 1; continue; }
    if (!result.changed) continue;
    await db.prepare(`UPDATE sessions SET dataJson=? WHERE fromNumber=?`).run(JSON.stringify(data), row.fromNumber);
    updated += 1;
  }
  return { mode, scanned, updated, skippedManual };
}

async function getCatalogProviderRow() {
  return await db.prepare(`SELECT id,name,catalogJson FROM companies WHERE id=?`).get(BOT_CATALOG_PROVIDER_ID);
}

async function resolveBotCatalogForCompany(targetCompanyId, targetCatalogRaw) {
  const targetId = String(targetCompanyId || "").trim().toLowerCase();
  const ownCatalog = normalizeCatalogEntries(targetCatalogRaw);
  if (targetId === BOT_CATALOG_PROVIDER_ID) {
    return { sourceId: BOT_CATALOG_PROVIDER_ID, sourceName: "Catalogo proveedor", catalogItems: ownCatalog };
  }
  const providerRow = await getCatalogProviderRow();
  const providerCatalog = normalizeCatalogEntries(parseJsonSafe(providerRow?.catalogJson || "[]", []));
  if (providerCatalog.length) {
    return {
      sourceId: String(providerRow?.id || BOT_CATALOG_PROVIDER_ID),
      sourceName: String(providerRow?.name || BOT_CATALOG_PROVIDER_ID),
      catalogItems: providerCatalog,
    };
  }
  return { sourceId: targetId || BOT_CATALOG_PROVIDER_ID, sourceName: "Catalogo empresa", catalogItems: ownCatalog };
}

function isValidDateObj(d) { return d instanceof Date && !Number.isNaN(d.getTime()); }
function parseDateSafe(value) { if (!value) return null; const d = new Date(value); return isValidDateObj(d) ? d : null; }
function monthRefFromShift(baseYear, baseMonth, shift) { const d = new Date(Date.UTC(baseYear, baseMonth + shift, 1)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() }; }
function clampDayOfMonth(year, month, day) { const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); return Math.min(Math.max(1, day), last); }
function buildUtcDate(year, month, day) { return new Date(Date.UTC(year, month, day, 0, 0, 0, 0)); }

function computeMonthlyCycle(anchorInput, nowInput = new Date()) {
  const now = parseDateSafe(nowInput) || new Date();
  const anchor = parseDateSafe(anchorInput) || now;
  const anchorDay = anchor.getUTCDate();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth();
  const monthDay = clampDayOfMonth(nowYear, nowMonth, anchorDay);
  let start = buildUtcDate(nowYear, nowMonth, monthDay);
  if (now.getTime() < start.getTime()) {
    const prevRef = monthRefFromShift(nowYear, nowMonth, -1);
    start = buildUtcDate(prevRef.year, prevRef.month, clampDayOfMonth(prevRef.year, prevRef.month, anchorDay));
  }
  const nextRef = monthRefFromShift(start.getUTCFullYear(), start.getUTCMonth(), 1);
  const renewal = buildUtcDate(nextRef.year, nextRef.month, clampDayOfMonth(nextRef.year, nextRef.month, anchorDay));
  const end = new Date(renewal.getTime() - 24 * 60 * 60 * 1000);
  const totalDays = Math.max(1, Math.ceil((renewal.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  const remainingDays = Math.max(0, Math.ceil((renewal.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return { anchorIso: anchor.toISOString(), cycleDay: anchorDay, startIso: start.toISOString(), endIso: end.toISOString(), renewalIso: renewal.toISOString(), totalDays, remainingDays };
}

function findCatalogItemByBot(catalogItems, botClass, botCatalogId) {
  const idRaw = String(botCatalogId || "").trim().toLowerCase();
  const classRaw = String(botClass || "").trim().toLowerCase();
  if (!catalogItems.length) return null;
  if (idRaw) { const byId = catalogItems.find((item) => item.idLower === idRaw); if (byId) return byId; }
  if (classRaw) {
    const exact = catalogItems.find((item) => item.nameLower === classRaw);
    if (exact) return exact;
    const partial = catalogItems.find((item) => item.nameLower.includes(classRaw));
    if (partial) return partial;
  }
  return null;
}

function resolveBotPriceFromRules(rules, catalogItems) {
  const selected = findCatalogItemByBot(catalogItems, rules?.botClass, rules?.botCatalogId);
  if (selected) return { selected, amount: selected.price };
  const fallback = roundMoney(rules?.subscriptionAmount ?? rules?.subscriptionNextAmount ?? rules?.monthlyPrice ?? 0);
  return { selected: null, amount: fallback };
}

function syncRulesSubscription({ rules, catalogItems, previousRules = null, previousCatalogItems = null, now = new Date(), triggerUpgrade = false }) {
  const nextRules = rules && typeof rules === "object" ? { ...rules } : {};
  const prevRulesObj = previousRules && typeof previousRules === "object" ? previousRules : {};
  const prevCatalog = Array.isArray(previousCatalogItems) ? previousCatalogItems : catalogItems;

  const currentBot = findCatalogItemByBot(catalogItems, nextRules.botClass, nextRules.botCatalogId);
  if (currentBot) { nextRules.botClass = currentBot.name; if (currentBot.id) nextRules.botCatalogId = currentBot.id; }

  const currentBotClass = String(nextRules.botClass || "").trim();
  if (!currentBotClass) {
    const mode = String(nextRules.channelMode || "").toLowerCase();
    let inferred = null;
    if (mode === "instagram") inferred = catalogItems.find((item) => item.nameLower.includes("instagram") || item.nameLower.includes("insta"));
    else if (mode === "combinado") inferred = catalogItems.find((item) => item.nameLower.includes("unificado") || item.nameLower.includes("combinado"));
    else if (mode === "whatsapp") inferred = catalogItems.find((item) => item.nameLower.includes("whatsapp"));
    if (!inferred && catalogItems.length === 1) inferred = catalogItems[0];
    if (inferred) { nextRules.botClass = inferred.name; if (inferred.id) nextRules.botCatalogId = inferred.id; }
  }

  const { selected, amount } = resolveBotPriceFromRules(nextRules, catalogItems);
  const activeAmount = roundMoney(amount);
  const activeName = selected?.name || String(nextRules.botClass || "").trim();
  const anchorSource = nextRules.subscriptionAnchorDate || nextRules.subscriptionStartDate || nextRules.botActivatedAt || now.toISOString();
  const cycle = computeMonthlyCycle(anchorSource, now);

  nextRules.subscriptionAnchorDate = cycle.anchorIso;
  nextRules.subscriptionCycleDay = cycle.cycleDay;
  nextRules.subscriptionCurrentStart = cycle.startIso;
  nextRules.subscriptionCurrentEnd = cycle.endIso;
  nextRules.subscriptionRenewal = cycle.renewalIso;
  nextRules.subscriptionCycle = "Mensual";
  nextRules.subscriptionStatus = String(nextRules.subscriptionStatus || "Activa");
  nextRules.subscriptionCurrency = String(nextRules.subscriptionCurrency || "USD");
  nextRules.subscriptionAmount = activeAmount;
  nextRules.subscriptionNextAmount = activeAmount;
  nextRules.monthlyPrice = activeAmount;
  if (activeName) nextRules.subscriptionPlan = activeName;

  if (triggerUpgrade) {
    const prev = resolveBotPriceFromRules(prevRulesObj, prevCatalog);
    const prevAmount = roundMoney(prev.amount);
    if (activeAmount > prevAmount && cycle.totalDays > 0 && cycle.remainingDays > 0) {
      nextRules.subscriptionProrationDueNow = roundMoney((activeAmount * cycle.remainingDays) / cycle.totalDays);
      nextRules.subscriptionProrationAt = (parseDateSafe(now) || new Date()).toISOString();
    } else {
      nextRules.subscriptionProrationDueNow = 0;
    }
  }

  return nextRules;
}

// ================= STARTUP =================
dbInitPromise
  .then(async () => {
    if (!dbInitReady) return;
    await backfillOrdersWorkflowColumns();
  })
  .catch((e) => console.error("Workflow backfill startup error:", e?.message || e));

// ================= WEBHOOK HELPERS =================
function resetSessionForCompanyChange(session, companyId) {
  resetAiMemoryForMode(session.data);
  session.state = "MENU";
  session.cart = [];
  session.lastOrderId = null;
  session.data.humanNotified = false;
  session.data.name = "";
  session.data.contact = "";
  session.data.notes = "";
  delete session.data.paymentMethodHint;
  delete session.data.checkoutOrderId;
  delete session.data.recentOrderId;
  delete session.data.recentOrderAt;
  delete session.data.recentOrderPaymentMethod;
  delete session.data.cartUpdatedAt;
  delete session.data.lastCartReminderAt;
  session.data.companyId = companyId;
}

async function updateOrderPaymentMethod(orderId, method) {
  await db.prepare(`
    UPDATE orders
    SET paymentMethod=?, paymentStatus=?, orderStatus=?, workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
    WHERE id=?
  `).run(method, "pending", "confirmed", "pending", false, null, "", "pending", orderId);
  await appendOrderNote(
    orderId,
    `[Cambio medio de pago ${new Date().toISOString()}] ${paymentMethodLabel(method)}`
  );
}

// ===== API ROUTES =====
app.use(createApiRouter({
  syncCompanySessionsAiMode,
  resolveBotCatalogForCompany,
  syncRulesSubscription,
  resetAiMemoryForMode,
  syncSessionAiModeFromCompany,
  BOT_CATALOG_PROVIDER_ID,
}));

// ================= WEBHOOK =================
function validateTwilioSignature(req, res, next) {
  if (!TWILIO_AUTH_TOKEN) {
    console.warn("[twilio] TWILIO_AUTH_TOKEN no configurado — omitiendo validación de firma");
    return next();
  }
  const valid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    req.headers["x-twilio-signature"] || "",
    `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    req.body
  );
  if (!valid) {
    console.warn("[twilio] Firma inválida rechazada desde", req.ip);
    res.set("Content-Type", "text/xml");
    return res.status(403).send("<Response></Response>");
  }
  next();
}

app.post("/whatsapp", validateTwilioSignature, async (req, res) => {
  try {
  const fromRaw = req.body.From || "unknown";
  const from = normalizeWhatsappFromNumber(fromRaw) || String(fromRaw || "unknown").trim() || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmdRaw = body.replace(/\s+/g, " ").trim();
  const cmd = cmdRaw.toLowerCase();
  const numMedia = Number(req.body.NumMedia || 0);
  const hasMedia = Number.isFinite(numMedia) && numMedia > 0;
  const twilioSid = String(req.body.MessageSid || "").trim();

  // Deduplicación: ignorar mensajes ya procesados (reintentos de Twilio)
  if (twilioSid) {
    try {
      const already = await db.prepare(`SELECT id FROM ai_messages WHERE twilioSid = ? LIMIT 1`).get(twilioSid);
      if (already) {
        res.set("Content-Type", "text/xml");
        return res.send("<Response></Response>");
      }
    } catch (dedupErr) {
      console.error("[webhook] dedup check failed:", dedupErr?.message || dedupErr);
      // continuar — mejor procesar dos veces que no procesar
    }
  }

  await withUserLock(from, async () => {
  if (from && from !== "unknown" && !cmd.startsWith("admin")) await setSetting("last_customer", from);

  const session = await getSession(from);
  let sessionDirty = false;

  const map = await db.prepare(`SELECT companyId FROM customer_company WHERE fromNumber=?`).get(from);
  if (map?.companyId && session.data.companyId !== map.companyId) {
    resetSessionForCompanyChange(session, map.companyId);
    sessionDirty = true;
  }

  const sessionModeSync = await syncSessionAiModeFromCompany(session);
  if (sessionModeSync.changed) {
    sessionDirty = true;
  }

  if (sessionDirty) {
    await saveSession(session);
  }

  // Maintenance mode: respond with maintenance message to all non-admin messages
  if (!cmd.startsWith("admin")) {
    const inMaintenance = await isBotInMaintenance();
    if (inMaintenance) {
      const maintMsg = await getSetting("maintenance_message") || "El bot está en mantenimiento. Volvemos en breve. 🔧";
      res.set("Content-Type", "text/xml");
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(maintMsg);
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // Subscription enforcement: bot silently ignores messages if subscription is inactive/expired
  if (!cmd.startsWith("admin")) {
    const companyForSub = await getCompanySafe(session);
    if (!isSubscriptionActive(companyForSub)) {
      res.set("Content-Type", "text/xml");
      return res.send("<Response></Response>");
    }
  }

  const pendingOrderForSession = await resolvePendingSessionOrder(session);
  const activeOrderId = String(pendingOrderForSession?.id || "").trim();
  const hasActiveOrder = !!activeOrderId;
  const recentReceiptOrder = await resolveRecentReceiptOrder(session);
  const recentReceiptMethod = normalizePaymentMethodInput(
    recentReceiptOrder?.paymentMethod || session?.data?.recentOrderPaymentMethod || ""
  );
  const canLinkRecentReceipt = ["transferencia", "debito", "tarjeta"].includes(recentReceiptMethod);
  const receiptOrderId = String((canLinkRecentReceipt ? recentReceiptOrder?.id : "") || activeOrderId || "").trim();
  const cartReminderDue =
    session.state === "MENU" &&
    Array.isArray(session?.cart) &&
    session.cart.length > 0 &&
    !hasActiveOrder &&
    (() => {
      const cartUpdatedAt = Number(session?.data?.cartUpdatedAt || 0);
      const lastReminderAt = Number(session?.data?.lastCartReminderAt || 0);
      if (!cartUpdatedAt) return false;
      const elapsed = Date.now() - cartUpdatedAt;
      if (elapsed < CART_REMINDER_AFTER_MS) return false;
      return !lastReminderAt || (Date.now() - lastReminderAt) >= CART_REMINDER_AFTER_MS;
    })();
  let cartReminderPrefix = "";
  if (cartReminderDue) {
    const reminderCompany = await getCompanySafe(session);
    cartReminderPrefix =
      `Recordatorio: tenes productos guardados en tu carrito.\n\n${await cartText(session)}\n\n` +
      `Si queres seguir, podes agregar algo mas o escribir checkout.\n\n`;
    session.data.lastCartReminderAt = Date.now();
    sessionDirty = true;
  }

  const respondAndLog = async (textOut, options = {}) => {
    let message = String(textOut || "");
    if (cartReminderPrefix && !options.skipCartReminder) {
      message = `${cartReminderPrefix}${message}`.trim();
    }
    if (!cmd.startsWith("admin")) {
      await logWhatsappMessage({
        fromNumber: from,
        companyId: session?.data?.companyId || "babystepsbots",
        orderId: options.orderId ?? activeOrderId ?? null,
        direction: "out",
        role: "assistant",
        content: message,
        createdAt: new Date().toISOString(),
      });
    }
    return respond(res, message);
  };

  if (!cmd.startsWith("admin") && body) {
    await logWhatsappMessage({
      fromNumber: from,
      companyId: session?.data?.companyId || "babystepsbots",
      orderId: activeOrderId || null,
      direction: "in",
      role: "user",
      content: body,
      twilioSid,
      createdAt: new Date().toISOString(),
    });
  }

  // ─── Business hours enforcement ──────────────────────────────────────────
  if (!cmd.startsWith("admin")) {
    const hoursCompany = await getCompanySafe(session);
    if (!isWithinBusinessHours(hoursCompany)) {
      const hoursRules = parseJsonSafe(hoursCompany?.rulesJson || "{}", {});
      const outsideMsg = String(hoursRules?.businessHoursOutsideText || hoursRules?.businessHoursText || "").trim()
        || "Gracias por tu mensaje. Estamos fuera del horario de atención. Te respondemos a la brevedad. 🙏";
      const now = Date.now();
      const lastNotified = Number(session.data.lastOutsideHoursNotifiedAt || 0);
      if (!lastNotified || now - lastNotified > 55 * 60 * 1000) {
        session.data.lastOutsideHoursNotifiedAt = now;
        await saveSession(session);
        return respondAndLog(outsideMsg);
      }
      // Already notified recently — silent ignore
      res.set("Content-Type", "text/xml");
      return res.send("<Response></Response>");
    } else if (session.data.lastOutsideHoursNotifiedAt) {
      delete session.data.lastOutsideHoursNotifiedAt;
      sessionDirty = true;
    }
  }

  // ─── Rate limiting ────────────────────────────────────────────────────────
  if (!cmd.startsWith("admin")) {
    const rlCompany = await getCompanySafe(session);
    const rlRules = parseJsonSafe(rlCompany?.rulesJson || "{}", {});
    const rlLimit = Number(rlRules?.rateLimitPerHour || 0);
    if (rlLimit > 0) {
      const companyId = String(session?.data?.companyId || "babystepsbots");
      const rl = checkRateLimit(companyId, from, rlLimit);
      if (!rl.ok) {
        // First message over the limit → notify once
        if (rl.count === rlLimit + 1) {
          return respondAndLog(
            `Enviaste demasiados mensajes en poco tiempo. Podés volver a escribir en ${rl.resetInMinutes} minuto${rl.resetInMinutes === 1 ? "" : "s"}. 🙏`
          );
        }
        // Subsequent — silent ignore
        res.set("Content-Type", "text/xml");
        return res.send("<Response></Response>");
      }
    }
  }

  if (hasMedia && !cmd.startsWith("admin")) {
    const orderId = session.cart.length ? "" : receiptOrderId;
    const mediaCount = Math.max(1, Math.min(10, numMedia));

    for (let i = 0; i < mediaCount; i += 1) {
      const mediaUrl = String(req.body[`MediaUrl${i}`] || "").trim();
      const mediaType = String(req.body[`MediaContentType${i}`] || "").trim();
      if (!mediaUrl) continue;

      await logWhatsappMessage({
        fromNumber: from,
        companyId: session?.data?.companyId || "babystepsbots",
        orderId: orderId || null,
        direction: "in",
        role: "user",
        content: `[Adjunto recibido${mediaType ? `: ${mediaType}` : ""}]`,
        mediaUrl,
        mediaContentType: mediaType,
        twilioSid,
        createdAt: new Date().toISOString(),
      });

      if (orderId) {
        const noteLine = `[Comprobante recibido ${new Date().toISOString()}${mediaType ? ` (${mediaType})` : ""}${mediaUrl ? ` ${mediaUrl}` : ""}]`;
        await db.prepare(`
          UPDATE orders
          SET notes = COALESCE(notes, '') || ?
          WHERE id=?
        `).run(`\n${noteLine}`, orderId);
      }

    }

    return respondAndLog(
      `Recibimos tu comprobante${orderId ? ` para ${orderId}` : ""}. La validacion es manual y no bloquea tu pedido.\n` +
      `Te avisamos por este chat cuando quede validado.`,
      { orderId: orderId || null }
    );
  }

  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;
    await saveSession(session);

    const company = await getCompanySafe(session);
    sendTelegram(
      `HUMANO SOLICITADO\n` +
      `Empresa: ${company?.name || "-"}\n` +
      `Cliente: ${from}\n` +
      `Mensaje: ${body}`
    );

    return respondAndLog(
      "Listo. Un asesor fue notificado y te va a responder en breve.\n\nMientras tanto podes escribir *menu* para volver al bot."
    );
  }

  if (session.state === "HUMAN" && (text === "menu" || text === "hola")) {
    session.state = "MENU";
    session.data.humanNotified = false;
    await saveSession(session);
    const company = await getCompanySafe(session);
    return respondAndLog(menuText(company));
  }

  if (session.state === "HUMAN" && !cmd.startsWith("admin")) {
    return respondAndLog("Un asesor ya fue notificado. Escribi *menu* para volver.");
  }

  if (cmd.startsWith("admin")) {
    if (!isAdmin(from)) return respond(res, "Comando restringido.");

    if (cmd === "admin whoami") return respond(res, `ADMIN OK: ${from}`);

    if (cmd === "admin company list") {
      const rows = await db.prepare(`SELECT id,name FROM companies ORDER BY id`).all();
      return respond(
        res,
        rows.length ? "Empresas:\n" + rows.map((r) => `- ${r.id} - ${r.name}`).join("\n") : "No hay empresas."
      );
    }

    const companySet = cmd.match(/^admin company set ([a-z0-9_-]+)(?:\s+(.+))?$/i);
    if (companySet) {
      const companyId = companySet[1].toLowerCase();
      let target = (companySet[2] || "").trim();

      const row = await db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      if (!target) target = await getSetting("last_customer");
      if (!target) return respond(res, "No tengo ultimo cliente todavia. Hace que un cliente mande un mensaje primero.");
      target = normalizeWhatsappFromNumber(target);
      if (!target || !target.startsWith("whatsapp:+")) {
        return respond(res, "Numero de cliente invalido. Usa whatsapp:+549...");
      }

      await db.prepare(`
        INSERT INTO customer_company(fromNumber, companyId, updatedAt)
        VALUES(?,?,?)
        ON CONFLICT(fromNumber) DO UPDATE SET
          companyId=excluded.companyId,
          updatedAt=excluded.updatedAt
      `).run(target, companyId, new Date().toISOString());

      const s2 = await getSession(target);
      const previousCompanyId = String(s2.data.companyId || "babystepsbots").trim().toLowerCase();
      if (previousCompanyId !== companyId) {
        resetSessionForCompanyChange(s2, companyId);
      } else {
        s2.data.companyId = companyId;
      }
      await syncSessionAiModeFromCompany(s2, { force: true });
      await saveSession(s2);

      return respond(res, `Empresa para ${target}: ${row.id} (${row.name}) OK`);
    }

    const botList = cmd.match(/^admin bot list ([a-z0-9_-]+)$/i);
    if (botList) {
      const companyId = botList[1].toLowerCase();
      const row = await db.prepare(`SELECT id,name,catalogJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const catalogCtx = await resolveBotCatalogForCompany(row.id, parseJsonSafe(row.catalogJson || "[]", []));
      const catalog = catalogCtx.catalogItems.map((item) => ({ id: item.id, name: item.name }));
      if (!catalog.length) {
        return respond(res, `No hay bots configurados en el catalogo proveedor '${catalogCtx.sourceId}'.`);
      }

      return respond(
        res,
        `Catalogo de bots (${catalogCtx.sourceId}) para ${row.id}:\n${formatCatalogChoices(catalog)}\n\nUso: admin bot set ${row.id} <id o nombre>`
      );
    }

    const botStatus = cmd.match(/^admin bot status ([a-z0-9_-]+)$/i);
    if (botStatus) {
      const companyId = botStatus[1].toLowerCase();
      const row = await db.prepare(`SELECT id,name,rulesJson,catalogJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const rulesRaw = parseJsonSafe(row.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
      const catalogCtx = await resolveBotCatalogForCompany(row.id, parseJsonSafe(row.catalogJson || "[]", []));
      const catalog = catalogCtx.catalogItems;
      const synced = syncRulesSubscription({
        rules,
        catalogItems: catalog,
        previousRules: rules,
        previousCatalogItems: catalog,
        now: new Date(),
        triggerUpgrade: false,
      });

      return respond(
        res,
        `Bot empresa ${row.id}\nProveedor catalogo: ${catalogCtx.sourceId}\nClase: ${String(synced.botClass || "Sin definir")}\nPlan: ${String(synced.planTier || "Sin definir")}\nCanal: ${String(synced.channelMode || "Sin definir")}\nInicio ciclo: ${String(synced.subscriptionCurrentStart || "-")}\nFin ciclo: ${String(synced.subscriptionCurrentEnd || "-")}\nProximo cobro: $${roundMoney(synced.subscriptionNextAmount || 0)}\nProrrateo ahora: $${roundMoney(synced.subscriptionProrationDueNow || 0)}`
      );
    }

    const botSet = cmdRaw.match(/^admin bot set ([a-z0-9_-]+)\s+(.+)$/i);
    if (botSet) {
      const companyId = String(botSet[1] || "").toLowerCase().trim();
      const botQueryRaw = String(botSet[2] || "").trim();
      const botQuery = botQueryRaw.toLowerCase();

      const row = await db.prepare(`SELECT id,name,catalogJson,rulesJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const catalogCtx = await resolveBotCatalogForCompany(row.id, parseJsonSafe(row.catalogJson || "[]", []));
      const catalog = catalogCtx.catalogItems;
      if (!catalog.length) {
        return respond(res, `No hay productos en el catalogo proveedor '${catalogCtx.sourceId}'.`);
      }

      let selected = catalog.find((item) => item.idLower === botQuery);
      if (!selected) selected = catalog.find((item) => item.nameLower === botQuery);
      if (!selected) selected = catalog.find((item) => item.nameLower.includes(botQuery));
      if (!selected) {
        return respond(
          res,
          `No encontre '${botQueryRaw}' en el catalogo de ${row.id}.\nOpciones:\n${formatCatalogChoices(catalog)}`
        );
      }

      const rulesRaw = parseJsonSafe(row.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? { ...rulesRaw } : {};
      const previousRules = { ...rules };
      rules.botClass = selected.name;
      if (selected.id) rules.botCatalogId = selected.id;
      rules.botClassUpdatedAt = new Date().toISOString();

      const inferredTier = normalizePlanTierFromText(selected.name);
      if (inferredTier) {
        rules.planTier = inferredTier;
        rules.aiEnabled = inferredTier !== "BASICO";
      }

      const inferredChannel = normalizeChannelModeFromText(selected.name);
      if (inferredChannel) {
        rules.channelMode = inferredChannel;
        rules.channels = channelsFromMode(inferredChannel);
      }

      const syncedRules = syncRulesSubscription({
        rules,
        catalogItems: catalog,
        previousRules,
        previousCatalogItems: catalog,
        now: new Date(),
        triggerUpgrade: true,
      });
      syncedRules.botCatalogProviderId = catalogCtx.sourceId;
      syncedRules.botCatalogProviderName = catalogCtx.sourceName;

      await db.prepare(`UPDATE companies SET rulesJson=? WHERE id=?`).run(JSON.stringify(syncedRules), row.id);
      const aiSync = await syncCompanySessionsAiMode(row.id, syncedRules, { force: true });

      return respond(
        res,
        `OK Bot actualizado para ${row.id}\nProveedor catalogo: ${catalogCtx.sourceId}\nClase: ${selected.name}\nPlan: ${syncedRules.planTier || "-"}\nCanal: ${syncedRules.channelMode || "-"}\nProximo cobro: $${roundMoney(syncedRules.subscriptionNextAmount || 0)}\nProrrateo ahora: $${roundMoney(syncedRules.subscriptionProrationDueNow || 0)}\nIA sincronizada en ${aiSync.updated}/${aiSync.scanned} sesiones`
      );
    }

    const mAi = cmd.match(/^admin ai set (off|lite|pro)(?:\s+(.+))?$/i);
    if (mAi) {
      let target = (mAi[2] || "").trim() || (await getSetting("last_customer"));
      if (!target) return respond(res, "No hay cliente activo.");
      target = normalizeWhatsappFromNumber(target);
      if (!target || !target.startsWith("whatsapp:+")) return respond(res, "Numero de cliente invalido.");

      const s2 = await getSession(target);
      s2.data.aiMode = mAi[1].toLowerCase();
      s2.data.aiModeManual = true;
      s2.data.aiModeSource = "admin-manual";
      await saveSession(s2);
      return respond(res, `IA ${mAi[1].toUpperCase()} para ${target}`);
    }

    const mStatus = cmd.match(/^admin ai status(?:\s+(.+))?$/i);
    if (mStatus) {
      let target = (mStatus[1] || "").trim() || (await getSetting("last_customer"));
      if (!target) return respond(res, "No hay cliente activo.");
      target = normalizeWhatsappFromNumber(target);
      if (!target || !target.startsWith("whatsapp:+")) return respond(res, "Numero de cliente invalido.");

      const s2 = await getSession(target);
      return respond(res, `IA: ${(s2.data.aiMode || "off").toUpperCase()}`);
    }

    return respond(res, "Admin OK");
  }

  if (text === "menu" || text === "hola") {
    session.state = "MENU";
    session.data.humanNotified = false;
    await saveSession(session);
    const company = await getCompanySafe(session);
    return respondAndLog(menuText(company), { skipCartReminder: text === "hola" ? false : true });
  }

  if (text === "catalogo") {
    const company = await getCompanySafe(session);
    return respondAndLog(catalogText(company));
  }

  if (text === "ayuda") {
    return respondAndLog(
      "Comandos utiles:\n" +
      "- menu\n" +
      "- catalogo\n" +
      "- carrito\n" +
      "- checkout\n" +
      "- humano\n" +
      "- cancelar (reinicia el flujo actual)"
    );
  }

  if (text === "cancelar") {
    session.cart = [];
    session.data.humanNotified = false;
    clearCheckoutProgress(session, { keepRecentOrder: true });
    delete session.data.cartUpdatedAt;
    delete session.data.lastCartReminderAt;
    await saveSession(session);
    return respondAndLog("Listo, reinicie el flujo. Escribi catalogo para empezar una nueva compra.");
  }

  if (
    [
      "pago",
      "pagar",
      "pagado",
      "comprobante",
      "transferencia",
      "medio de pago",
      "medios de pago",
      "medios",
    ].includes(text) &&
    !session.cart.length
  ) {
    const company = await getCompanySafe(session);
    const methodFromText = normalizePaymentMethodInput(body);
    if (hasActiveOrder && methodFromText) {
      await updateOrderPaymentMethod(activeOrderId, methodFromText);
      return respondAndLog(
        `Actualizado. El pedido ${activeOrderId} ahora figura con medio de pago: ${paymentMethodLabel(methodFromText)}.\n\n` +
        `${paymentMethodsReplyText(company, { orderId: activeOrderId })}`,
        { orderId: activeOrderId }
      );
    }
    return respondAndLog(
      paymentMethodsReplyText(company, { orderId: activeOrderId })
    );
  }
  const looksLikePaymentReady =
    ["listo", "ok", "ya", "hecho", "transferi", "ya transferi", "pague", "ya pague"].includes(text) ||
    text.includes("ya transfer") ||
    text.includes("comprobante");
  if (session.state === "MENU" && receiptOrderId && !hasMedia && !session.cart.length && looksLikePaymentReady) {
    return respondAndLog(
      `Perfecto. Para avanzar con la validacion del pedido ${receiptOrderId}, envia el comprobante cuando lo tengas.\n` +
      `Si ya lo enviaste, no hace falta repetirlo: te confirmamos por este chat.`,
      { orderId: receiptOrderId }
    );
  }

  if (session.state === "MENU" && hasActiveOrder && !hasMedia && !session.cart.length) {
    const directMethod = normalizePaymentMethodInput(body);
    if (directMethod) {
      await updateOrderPaymentMethod(activeOrderId, directMethod);
      const company = await getCompanySafe(session);
      return respondAndLog(
        `Actualizado. El pedido ${activeOrderId} ahora figura con medio de pago: ${paymentMethodLabel(directMethod)}.\n\n` +
        `${paymentMethodsReplyText(company, { orderId: activeOrderId })}`,
        { orderId: activeOrderId }
      );
    }
  }

  if (text === "carrito") return respondAndLog(await cartText(session));

  const mAdd = text.match(/^agregar\s+(\d+)$/);
  const mCatalogNumber = session.state === "MENU" ? text.match(/^(\d+)$/) : null;
  const selectedCatalogId = mAdd?.[1] || mCatalogNumber?.[1] || "";
  if (selectedCatalogId) {
    const id = Number(selectedCatalogId);
    const company = await getCompanySafe(session);
    const p = (company.catalog || []).find((x) => Number(x.id) === id);
    if (!p) return respondAndLog("Ese producto no existe. Escribi catalogo y elegi una opcion valida.");
    session.cart.push({ id, price: Number(p.price || 0) });
    session.data.cartUpdatedAt = Date.now();
    delete session.data.lastCartReminderAt;
    await saveSession(session);
    return respondAndLog(`Agregado ${p.name}\n\n${await cartText(session)}\n\n¿Deseas agregar o ver algo mas? Podes escribir otro producto, su ID o "catalogo".\nPara finalizar: checkout`);
  }

  if (session.state === "MENU" && !hasActiveOrder) {
    const company = await getCompanySafe(session);
    const detected = extractCatalogSelectionsFromText(body, company.catalog || []);
    const quickCheckoutData = extractCheckoutFieldsFromText(body);
    const looksLikeCheckoutData = !!(quickCheckoutData.contact || quickCheckoutData.paymentMethod);

    if (!detected.selectedIds.length && detected.groupMatchedIds.length >= 2) {
      return respondAndLog(
        buildCatalogFilteredReply(company, detected.groupMatchedIds, detected.groupLabels)
      );
    }
    if (!detected.selectedIds.length && detected.groupMatchedIds.length === 1 && detected.isInfoIntent) {
      return respondAndLog(buildCatalogInfoReply(company, detected.groupMatchedIds));
    }

    if (detected.isInfoIntent) {
      return respondAndLog(buildCatalogInfoReply(company, detected.selectedIds));
    }

    const canAutoAddFromNaturalText =
      detected.selectedIds.length > 0 &&
      !detected.isInfoIntent &&
      !looksLikeCheckoutData;

    if (canAutoAddFromNaturalText) {
      for (const id of detected.selectedIds) {
        const cp = (company.catalog || []).find((x) => Number(x.id) === Number(id));
        session.cart.push({ id: Number(id), price: Number(cp?.price || 0) });
      }
      session.data.cartUpdatedAt = Date.now();
      delete session.data.lastCartReminderAt;
      await saveSession(session);
      const added = summarizeCatalogSelection(detected.selectedIds, company.catalog || []);
      const addedText = added.length ? `Agregados: ${added.join(", ")}` : "Productos agregados al carrito.";
      return respondAndLog(
        `${addedText}\n\n${await cartText(session)}\n\n¿Querés agregar algo más? Podes escribir otro producto o su ID.\nPara continuar: checkout`,
      );
    }
    if (detected.isAddIntent && detected.invalidIds.length > 0) {
      return respondAndLog(
        `No encuentro esas opciones (${detected.invalidIds.join(", ")}).\n` +
        `Escribi catalogo y elegi IDs validos.`
      );
    }
  }

  if (session.state === "MENU" && session.cart.length) {
    const quickData = extractCheckoutFieldsFromText(body);
    const mergedName = String(quickData.name || session.data.name || "").trim();
    const mergedContact = String(quickData.contact || session.data.contact || "").trim();
    const mergedPaymentMethod = normalizePaymentMethodInput(
      quickData.paymentMethod || session.data.paymentMethodHint || ""
    );
    const hasUsefulData = !!(quickData.name || quickData.contact || quickData.paymentMethod);

    if (hasUsefulData) {
      if (mergedName) session.data.name = mergedName;
      if (mergedContact) session.data.contact = mergedContact;
      if (mergedPaymentMethod) session.data.paymentMethodHint = mergedPaymentMethod;
    }

    if (hasUsefulData && mergedName && mergedContact && mergedPaymentMethod) {
      if (session.data.notes === undefined || session.data.notes === null) session.data.notes = "";
      const company = await getCompanySafe(session);
      const created = await createOrUpdateCheckoutOrder(session, from, company, {
        paymentMethod: mergedPaymentMethod,
      });
      if (created.missingItems) {
        return respondAndLog("No pude registrar el pedido porque el carrito esta vacio. Escribi: catalogo");
      }
      notifyTelegramOrderCreated(company, from, created);
      notifyEmailOrderCreated(company, from, created);
      markRecentOrder(session, created.orderId, created.paymentMethod);
      clearCheckoutProgress(session, { keepRecentOrder: true });
      delete session.data.cartUpdatedAt;
      delete session.data.lastCartReminderAt;
      await saveSession(session);
      return respondAndLog(
        buildOrderRegisteredReply(company, created.orderId, created.total, created.paymentMethod),
        { orderId: created.orderId }
      );
    }

    if (hasUsefulData && mergedContact && mergedPaymentMethod && !mergedName) {
      session.state = "ASK_NAME";
      await saveSession(session);
      return respondAndLog(
        "Recibi tu contacto y medio de pago. Solo falta tu nombre para registrar el pedido."
      );
    }

    if (hasUsefulData && mergedName && mergedPaymentMethod && !mergedContact) {
      session.state = "ASK_CONTACT";
      await saveSession(session);
      return respondAndLog(
        "Recibi tu nombre y medio de pago. Ahora pasame un telefono de contacto."
      );
    }

    if (hasUsefulData && mergedName && mergedContact && !mergedPaymentMethod) {
      session.state = "ASK_NOTES";
      await saveSession(session);
      return respondAndLog(
        "Perfecto. Si queres agrega notas u observaciones (opcional) y luego elegimos medio de pago.\n" +
        "Si no queres agregar nada, dejalo vacio o responde: ok"
      );
    }

    if (hasUsefulData) {
      const missing = [];
      if (!mergedName) missing.push("nombre");
      if (!mergedContact) missing.push("contacto");
      if (!mergedPaymentMethod) missing.push("medio de pago");

      if (!mergedName) {
        session.state = "ASK_NAME";
      } else if (!mergedContact) {
        session.state = "ASK_CONTACT";
      } else if (!mergedPaymentMethod) {
        session.state = "ASK_PAYMENT_METHOD";
      }
      await saveSession(session);
      return respondAndLog(
        `Recibi parte de los datos para registrar el pedido. Falta: ${missing.join(", ")}.\n` +
        "Podes enviarlo en un solo mensaje (ej: Pedro 3812345678 transferencia)."
      );
    }
  }

  if (
    session.state === "MENU" &&
    !hasActiveOrder &&
    !session.cart.length &&
    !hasMedia &&
    normalizePaymentMethodInput(body)
  ) {
    return respondAndLog(
      "Todavia no tengo un pedido activo para asociar ese pago.\n" +
      "Primero elegi productos (catalogo) y despues seguimos con checkout."
    );
  }

  if (text === "checkout") {
    if (!session.cart.length) return respondAndLog("Carrito vacio.");
    session.state = "ASK_NAME";
    await saveSession(session);
    return respondAndLog("A nombre de quien va el pedido?");
  }

  if (session.state === "ASK_NAME" && !isReserved(text)) {
    const extracted = extractCheckoutFieldsFromText(body);
    session.data.name = extracted.name || body;
    if (extracted.contact) session.data.contact = extracted.contact;
    if (extracted.paymentMethod) session.data.paymentMethodHint = extracted.paymentMethod;
    session.state = session.data.contact ? "ASK_NOTES" : "ASK_CONTACT";
    await saveSession(session);
    if (session.state === "ASK_CONTACT") {
      return respondAndLog("Pasame un contacto.");
    }
    return respondAndLog(
      "Perfecto. Ultimo paso: agrega notas u observaciones para este pedido (opcional).\n" +
      "Si no queres agregar nada, dejalo vacio o responde: ok"
    );
  }

  if (session.state === "ASK_CONTACT" && !isReserved(text)) {
    const extracted = extractCheckoutFieldsFromText(body);
    session.data.contact = extracted.contact || String(body || "").trim();
    if (extracted.name && !session.data.name) session.data.name = extracted.name;
    if (extracted.paymentMethod) session.data.paymentMethodHint = extracted.paymentMethod;
    session.state = "ASK_NOTES";
    await saveSession(session);
    return respondAndLog(
      "Perfecto. Ultimo paso: agrega notas u observaciones para este pedido (opcional).\n" +
      "Si no queres agregar nada, dejalo vacio o responde: ok"
    );
  }

  if (session.state === "ASK_NOTES" && !isReserved(text)) {
    const extracted = extractCheckoutFieldsFromText(body);
    if (extracted.name && !session.data.name) session.data.name = extracted.name;
    if (extracted.contact && !session.data.contact) session.data.contact = extracted.contact;
    if (extracted.paymentMethod) session.data.paymentMethodHint = extracted.paymentMethod;

    const rawNotes = String(body || "").trim();
    const normalized = rawNotes.toLowerCase();
    const skipNotes = ["", "-", "ok", "listo", "ninguna", "ninguno", "sin", "sin notas", "no"].includes(normalized);
    session.data.notes = skipNotes ? "" : rawNotes;

    if (extracted.paymentMethod && session.data.name && session.data.contact) {
      const company = await getCompanySafe(session);
      const created = await createOrUpdateCheckoutOrder(session, from, company, {
        paymentMethod: extracted.paymentMethod,
      });
      if (created.missingItems) {
        session.state = "MENU";
        await saveSession(session);
        return respondAndLog("No pude registrar el pedido porque el carrito esta vacio. Escribi: catalogo");
      }
      notifyTelegramOrderCreated(company, from, created);
      notifyEmailOrderCreated(company, from, created);
      markRecentOrder(session, created.orderId, created.paymentMethod);
      clearCheckoutProgress(session, { keepRecentOrder: true });
      delete session.data.cartUpdatedAt;
      delete session.data.lastCartReminderAt;
      await saveSession(session);
      return respondAndLog(
        buildOrderRegisteredReply(company, created.orderId, created.total, created.paymentMethod),
        { orderId: created.orderId }
      );
    }

    const notesCompany = await getCompanySafe(session);
    const notesRules = parseJsonSafe(notesCompany?.rulesJson || "{}", {});
    if (notesRules.requireDeliveryAddress && !String(session.data.address || "").trim()) {
      session.state = "ASK_ADDRESS";
      await saveSession(session);
      return respondAndLog("¿Cuál es la dirección de entrega? (o escribí *sin dirección* para omitir)");
    }
    session.state = "ASK_PAYMENT_METHOD";
    await saveSession(session);
    return respondAndLog(paymentMethodSelectionPrompt(notesCompany));
  }

  if (session.state === "ASK_ADDRESS" && !isReserved(text)) {
    const rawAddr = String(body || "").trim();
    const skipAddr = ["sin dirección", "sin direccion", "sin dir", "-", "no", "omitir", ""].includes(rawAddr.toLowerCase());
    session.data.address = skipAddr ? "" : rawAddr;
    session.state = "ASK_PAYMENT_METHOD";
    await saveSession(session);
    return respondAndLog(paymentMethodSelectionPrompt(await getCompanySafe(session)));
  }

  if (session.state === "ASK_PAYMENT_METHOD" && !isReserved(text)) {
    const company = await getCompanySafe(session);
    const selectedMethod = normalizePaymentMethodInput(body || session.data.paymentMethodHint || "");
    if (!selectedMethod) {
      return respondAndLog(
        `No detecte el medio de pago.\n${paymentMethodSelectionPrompt(company)}`
      );
    }
    if (!String(session.data.name || "").trim()) {
      session.state = "ASK_NAME";
      await saveSession(session);
      return respondAndLog("Antes de registrar el pedido necesito tu nombre.");
    }
    if (!String(session.data.contact || "").trim()) {
      session.state = "ASK_CONTACT";
      await saveSession(session);
      return respondAndLog("Antes de registrar el pedido necesito un contacto.");
    }

    if (String(session.data.address || "").trim()) {
      session.data.notes = ["Dirección: " + session.data.address, session.data.notes].filter(Boolean).join("\n");
    }
    const created = await createOrUpdateCheckoutOrder(session, from, company, {
      paymentMethod: selectedMethod,
      fallbackPaymentMethod: session.data.paymentMethodHint || "",
    });
    if (created.missingItems) {
      session.state = "MENU";
      await saveSession(session);
      return respondAndLog("No pude registrar el pedido porque el carrito esta vacio. Escribi: catalogo");
    }

    notifyTelegramOrderCreated(company, from, created);
    notifyEmailOrderCreated(company, from, created);
    markRecentOrder(session, created.orderId, created.paymentMethod);
    clearCheckoutProgress(session, { keepRecentOrder: true });
    delete session.data.cartUpdatedAt;
    delete session.data.lastCartReminderAt;
    await saveSession(session);
    return respondAndLog(
      buildOrderRegisteredReply(company, created.orderId, created.total, created.paymentMethod),
      { orderId: created.orderId }
    );
  }

  if (session.state === "ASK_PAYMENT_DETAILS" && !isReserved(text)) {
    const orderId = String(session.lastOrderId || "").trim();
    if (!orderId) {
      session.state = "MENU";
      await saveSession(session);
      return respondAndLog("No encuentro el pedido activo. Escribi catalogo para iniciar una nueva compra.");
    }

    const maybeMethodChange = normalizePaymentMethodInput(body);
    if (maybeMethodChange) {
      await updateOrderPaymentMethod(orderId, maybeMethodChange);
      await saveSession(session);
      return respondAndLog(
        `Actualizado. El pedido ${orderId} ahora queda con medio de pago: ${paymentMethodLabel(maybeMethodChange)}.\n` +
        `Contame lugar y horario para coordinar.`,
        { orderId }
      );
    }

    const paymentDetail = String(body || "").trim();
    const normalizedDetail = normalizeTextForMatch(paymentDetail);
    const skipDetail = ["-", "ok", "listo", "ninguno", "ninguna", "sin", "no"].includes(normalizedDetail);
    if (!skipDetail && paymentDetail) {
      await appendOrderNote(orderId, `[Detalle pago ${new Date().toISOString()}] ${paymentDetail}`);
    }

    session.state = "MENU";
    session.data.name = "";
    session.data.contact = "";
    session.data.notes = "";
    delete session.data.paymentMethodHint;
    delete session.data.checkoutOrderId;
    await saveSession(session);
    return respondAndLog(
      `Perfecto. Pedido ${orderId} en gestion.\nTe confirmamos por este chat cuando avance el pago/entrega.`,
      { orderId }
    );
  }

  if (text === "confirmar" && session.state === "READY") {
    const company = await getCompanySafe(session);
    const created = await createOrUpdateCheckoutOrder(session, from, company, {
      fallbackPaymentMethod: session.data.paymentMethodHint || "",
    });
    if (created.missingItems) {
      session.state = "MENU";
      await saveSession(session);
      return respondAndLog("No pude registrar el pedido porque el carrito esta vacio. Escribi: catalogo");
    }
    notifyTelegramOrderCreated(company, from, created);
    notifyEmailOrderCreated(company, from, created);
    session.state = "ASK_PAYMENT_METHOD";
    await saveSession(session);
    return respondAndLog(
      `Pedido ${created.orderId} registrado.\nTotal: ${formatChatMoney(created.total, getCompanyCatalogCurrency(company))}\n\n` +
      `${paymentMethodSelectionPrompt(company)}`,
      { orderId: created.orderId }
    );
  }

  if (text === "confirmar" && session.state === "ASK_PAYMENT_METHOD" && hasActiveOrder) {
    const company = await getCompanySafe(session);
    return respondAndLog(
      `El pedido ${activeOrderId} ya esta registrado.\n` +
      `${paymentMethodSelectionPrompt(company)}`,
      { orderId: activeOrderId }
    );
  }

  if (text === "confirmar" && session.state === "ASK_PAYMENT_METHOD" && !hasActiveOrder) {
    return respondAndLog("Antes de confirmar, elegi medio de pago: efectivo / transferencia / debito / tarjeta.");
  }

  if (text === "confirmar" && session.state === "ASK_PAYMENT_DETAILS" && hasActiveOrder) {
    session.state = "MENU";
    session.data.name = "";
    session.data.contact = "";
    session.data.notes = "";
    delete session.data.paymentMethodHint;
    delete session.data.checkoutOrderId;
    await saveSession(session);
    return respondAndLog(
      `Perfecto. Pedido ${activeOrderId} en gestion.`,
      { orderId: activeOrderId }
    );
  }

  if (!isReserved(text) && body && !looksLikeCheckoutOperationalMessage(body)) {
    const faqCompany = await getCompanySafe(session);
    const faqRules = parseJsonSafe(faqCompany?.rulesJson || "{}", {});
    const faqItems = Array.isArray(faqRules.faqItems) ? faqRules.faqItems : [];
    const faqAnswer = findFaqMatch(text, faqItems);
    if (faqAnswer) return respondAndLog(faqAnswer);

    const ai = await aiReply(session, from, body);
    if (ai) return respondAndLog(ai);
  }

  const company = await getCompanySafe(session);
  await saveSession(session);
  return respondAndLog(
    contextualCheckoutFallback(session, company, { activeOrderId })
  );
  }); // withUserLock
  } catch (err) {
    console.error("[webhook] unhandled error:", err?.message || err);
    res.set("Content-Type", "text/xml");
    res.status(500).send("<Response></Response>");
  }
});
// ================= RESPUESTA =================
function respond(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.type("text/xml").send(twiml.toString());
}

// ================= MAINTENANCE TOGGLE =================
app.post("/api/admin/maintenance", async (req, res) => {
  const token = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  const API_KEY = (process.env.API_KEY || "").trim();
  if (!API_KEY || token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });

  try {
    const enabled = req.body.enabled === true || req.body.enabled === "1" || req.body.enabled === "true";
    const message = String(req.body.message || "").trim();
    await setSetting("maintenance_mode", enabled ? "1" : "0");
    if (message) await setSetting("maintenance_message", message);
    invalidateMaintenanceCache();
    const current = await getSetting("maintenance_message");
    return res.json({ ok: true, maintenanceMode: enabled, message: current || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/admin/maintenance", async (req, res) => {
  const token = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  const API_KEY = (process.env.API_KEY || "").trim();
  if (!API_KEY || token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const enabled = (await getSetting("maintenance_mode")) === "1";
    const message = await getSetting("maintenance_message");
    return res.json({ ok: true, maintenanceMode: enabled, message: message || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ================= HEALTH =================
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/health/db", async (_, res) => {
  try {
    const row = await db.prepare("SELECT 1 as ok").get();
    res.json({
      ok: true,
      db: row?.ok === 1 ? "up" : "unknown",
      initReady: dbInitReady,
      initError: dbInitError ? String(dbInitError?.message || dbInitError) : null,
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      db: "down",
      initReady: dbInitReady,
      initError: dbInitError ? String(dbInitError?.message || dbInitError) : null,
      error: e?.message || String(e),
    });
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));



