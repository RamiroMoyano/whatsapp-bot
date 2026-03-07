import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db, initDb } from "./db.js";
import fetch from "node-fetch";
import crypto from "crypto";

dotenv.config();

console.log("BOOT VERSION:", "2026-02-03-INDEX-DASH-V1");
console.log("BOOT FILE:", import.meta.url);
console.log("PWD:", process.cwd());

const app = express();
app.use(express.urlencoded({ extended: false }));

app.use(express.json());

const API_TOKEN = (process.env.API_TOKEN || "").trim();
function requireApiAuth(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: "API_TOKEN no configurado" });
  const h = req.headers.authorization || "";
  if (h !== `Bearer ${API_TOKEN}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ================= TELEGRAM (UNICO, ARRIBA) =================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured (missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)");
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });

    clearTimeout(t);

    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      console.error("Telegram API error:", r.status, data);
      return false;
    }

    return true;
  } catch (e) {
    console.error("Telegram notify failed:", e?.message || e);
    return false;
  }
}

// ================= DB INIT =================
await initDb();

// ================= OPENAI =================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_GLOBAL = (process.env.AI_GLOBAL || "on").trim().toLowerCase();
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

// ================= SESSION =================
async function getSession(from) {
  const r = await db.prepare(`SELECT * FROM sessions WHERE fromNumber=?`).get(from);

  const base = {
    companyId: "babystepsbots",
    aiMode: "off",
    aiCount: 0,
    aiCountDate: "",
    aiHistory: [],
    lastAiAt: 0,
    humanNotified: false,
  };

  if (!r) return { fromNumber: from, state: "MENU", cart: [], data: base, lastOrderId: null };

  return {
    fromNumber: from,
    state: r.state || "MENU",
    cart: JSON.parse(r.cartJson || "[]"),
    data: { ...base, ...(JSON.parse(r.dataJson || "{}") || {}) },
    lastOrderId: r.lastOrderId || null,
  };
}

async function saveSession(s) {
  await db.prepare(`
    INSERT INTO sessions(fromNumber,state,cartJson,dataJson,lastOrderId)
    VALUES (?,?,?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      state=excluded.state,
      cartJson=excluded.cartJson,
      dataJson=excluded.dataJson,
      lastOrderId=excluded.lastOrderId
  `).run(
    s.fromNumber,
    s.state,
    JSON.stringify(s.cart || []),
    JSON.stringify(s.data || {}),
    s.lastOrderId || null
  );
}

// ================= TEXT HELPERS =================
const menuText = (c) => `${String.fromCodePoint(0x1F44B)} Hola! Soy el asistente de ${c.name}
- catalogo
- carrito
- checkout
- humano`;

function pickCatalogEmoji(itemRaw, index = 0) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const text = normalizeTextForMatch(
    `${item?.name || ""} ${item?.category || ""} ${item?.rubro || ""} ${item?.seccion || ""}`
  );
  if (text.includes("perro") || text.includes("mascota")) return String.fromCodePoint(0x1F436);
  if (text.includes("gato")) return String.fromCodePoint(0x1F431);
  if (text.includes("ropa") || text.includes("remera") || text.includes("pantalon") || text.includes("campera")) return String.fromCodePoint(0x1F455);
  if (text.includes("accesorio")) return String.fromCodePoint(0x1F9F0);
  if (text.includes("comida") || text.includes("alimento")) return String.fromCodePoint(0x1F35D);
  const fallback = [0x1F539, 0x1F537, 0x1F535, 0x1F7E2];
  return String.fromCodePoint(fallback[index % fallback.length]);
}

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
  s.cart.forEach((id) => (out[id] = (out[id] || 0) + 1));
  const lines = Object.entries(out).map(([id, q]) => {
    const p = (c.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = Number(p?.price || 0);
    const sub = unit * q;
    total += sub;
    return `- ${p?.name || "Producto"} x${q} - ${formatChatMoney(sub, getCompanyCatalogCurrency(c))}`;
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
    : { memoryMessages: 30, memoryChars: 20000 };

  const c = await getCompanySafe(session);
  const paymentPrompt = paymentMethodsPromptText(c);
  const currency = getCompanyCatalogCurrency(c);
  const prompt = `
${c.prompt || ""}

CATALOGO:
${(c.catalog || []).map((p) => `${p.id}) ${p.name}: ${formatChatMoney(p.price, currency)}`).join("\n")}

Reglas:
- Tono: ${(c.rules || {}).tone || "neutral"}
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

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: inputMessages,
      instructions: `${prompt}\nMEDIOS DE PAGO:\n${paymentPrompt}`,
    });

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
    console.error("aiReply failed:", e?.message || e);
    return null;
  }
}

// ================= UTILIDADES =================
const newOrderId = () => "PED-" + Math.random().toString(36).slice(2, 8).toUpperCase();

const isReserved = (t) =>
  [
    "menu","hola","catalogo","carrito","checkout",
    "pago","pagar","pagado","confirmar","cancelar","ayuda",
    "humano","asesor","hablar con humano"
  ].includes(t);

const isHumanTrigger = (t) => ["humano","asesor","hablar con humano"].includes(t);

function parseJsonSafe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw ?? "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const SUPPORTED_CURRENCIES = new Set(["ARS", "USD", "EUR", "GBP", "BRL"]);

function normalizeCurrencyCode(value, fallback = "USD") {
  const raw = String(value || "").trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.has(raw)) return raw;
  return fallback;
}

function getCompanyCatalogCurrency(company) {
  const rules = company?.rules && typeof company.rules === "object" ? company.rules : {};
  return normalizeCurrencyCode(
    rules.catalogCurrency ||
    rules.subscriptionCurrency ||
    "USD"
  );
}

function formatChatMoney(value, currencyCode = "USD") {
  const amount = Number(value || 0);
  const currency = normalizeCurrencyCode(currencyCode);
  if (!Number.isFinite(amount)) return `${currency} 0`;
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount * 100) / 100}`;
  }
}

function normalizeWhatsappFromNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toLowerCase() === "unknown") return "unknown";

  let phone = raw;
  if (phone.toLowerCase().startsWith("whatsapp:")) {
    phone = phone.slice("whatsapp:".length).trim();
  }

  if (!phone) return "";
  let compact = phone.replace(/[^\d+]/g, "");
  if (!compact) return "";

  if (compact.startsWith("+")) {
    compact = `+${compact.slice(1).replace(/\+/g, "")}`;
  } else {
    compact = `+${compact.replace(/\+/g, "")}`;
  }

  return `whatsapp:${compact}`;
}

function isTruthyFlag(value) {
  if (value === true) return true;
  const raw = String(value || "").trim().toLowerCase();
  return ["1", "true", "on", "si", "yes"].includes(raw);
}

function extractCompanyPaymentConfig(rulesRaw) {
  const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
  const methodsRaw = rules.paymentMethods && typeof rules.paymentMethods === "object"
    ? rules.paymentMethods
    : {};
  const transferRaw = rules.paymentTransfer && typeof rules.paymentTransfer === "object"
    ? rules.paymentTransfer
    : {};

  const transfer = {
    bankName: String(transferRaw.bankName || rules.paymentTransferBankName || rules.paymentTransferBank || "").trim(),
    accountHolder: String(
      transferRaw.accountHolder ||
      rules.paymentTransferAccountHolder ||
      rules.razonSocial ||
      rules.businessName ||
      ""
    ).trim(),
    taxId: String(
      transferRaw.taxId ||
      rules.paymentTransferTaxId ||
      rules.paymentTransferCuit ||
      rules.cuit ||
      rules.taxId ||
      ""
    ).trim(),
    cbu: String(transferRaw.cbu || rules.paymentTransferCbu || rules.cbu || "").trim(),
    alias: String(transferRaw.alias || rules.paymentTransferAlias || rules.alias || "").trim(),
    accountType: String(transferRaw.accountType || rules.paymentTransferAccountType || "").trim(),
    note: String(transferRaw.note || rules.paymentTransferNote || "").trim(),
  };

  const enabled = {
    cash: isTruthyFlag(methodsRaw.cash ?? methodsRaw.efectivo ?? rules.paymentCash ?? rules.paymentEfectivo),
    debit: isTruthyFlag(methodsRaw.debit ?? methodsRaw.debito ?? rules.paymentDebit ?? rules.paymentDebito),
    transfer: isTruthyFlag(
      methodsRaw.transfer ??
      methodsRaw.transferencia ??
      rules.paymentTransferEnabled ??
      rules.paymentTransfer
    ),
    credit: isTruthyFlag(methodsRaw.credit ?? methodsRaw.credito ?? rules.paymentCredit ?? rules.paymentCredito),
  };

  if (transfer.cbu || transfer.alias || transfer.accountHolder || transfer.bankName) {
    enabled.transfer = true;
  }

  return {
    enabled,
    transfer,
    publicNote: String(rules.paymentInstructions || rules.paymentPublicNote || "").trim(),
  };
}

function paymentMethodsPromptText(company) {
  const payment = extractCompanyPaymentConfig(company?.rules || {});
  const methods = [];
  if (payment.enabled.cash) methods.push("Efectivo");
  if (payment.enabled.debit) methods.push("Debito");
  if (payment.enabled.transfer) methods.push("Transferencia");
  if (payment.enabled.credit) methods.push("Tarjeta de credito");

  const lines = [];
  lines.push(methods.length ? methods.join(", ") : "No configurados");

  if (payment.enabled.transfer) {
    const transferParts = [];
    if (payment.transfer.bankName) transferParts.push(`Banco: ${payment.transfer.bankName}`);
    if (payment.transfer.accountHolder) transferParts.push(`Titular: ${payment.transfer.accountHolder}`);
    if (payment.transfer.taxId) transferParts.push(`CUIT/CUIL: ${payment.transfer.taxId}`);
    if (payment.transfer.cbu) transferParts.push(`CBU: ${payment.transfer.cbu}`);
    if (payment.transfer.alias) transferParts.push(`Alias: ${payment.transfer.alias}`);
    if (payment.transfer.accountType) transferParts.push(`Tipo: ${payment.transfer.accountType}`);
    if (transferParts.length) lines.push(transferParts.join(" | "));
  }

  if (payment.publicNote) lines.push(`Notas: ${payment.publicNote}`);
  lines.push("Comprobante de transferencia: opcional (no bloquea el pedido).");
  return lines.join("\n");
}

function paymentMethodsReplyText(company, options = {}) {
  const { orderId = "" } = options;
  const payment = extractCompanyPaymentConfig(company?.rules || {});
  const methods = [];
  if (payment.enabled.cash) methods.push("Efectivo");
  if (payment.enabled.debit) methods.push("Debito");
  if (payment.enabled.transfer) methods.push("Transferencia");
  if (payment.enabled.credit) methods.push("Tarjeta de credito");

  const lines = [];
  lines.push(`Medios de pago de ${company?.name || "la empresa"}:`);

  if (!methods.length) {
    lines.push("- Aun no hay medios de pago configurados.");
  } else {
    lines.push(`- Disponibles: ${methods.join(", ")}`);
  }

  if (payment.enabled.transfer) {
    lines.push("");
    lines.push("Datos para transferencia:");
    if (payment.transfer.bankName) lines.push(`- Banco: ${payment.transfer.bankName}`);
    if (payment.transfer.accountHolder) lines.push(`- Razon social / titular: ${payment.transfer.accountHolder}`);
    if (payment.transfer.taxId) lines.push(`- CUIT/CUIL: ${payment.transfer.taxId}`);
    if (payment.transfer.cbu) lines.push(`- CBU: ${payment.transfer.cbu}`);
    if (payment.transfer.alias) lines.push(`- Alias: ${payment.transfer.alias}`);
    if (payment.transfer.accountType) lines.push(`- Tipo de cuenta: ${payment.transfer.accountType}`);
    if (payment.transfer.note) lines.push(`- Nota: ${payment.transfer.note}`);
    lines.push("- Si queres, podes enviar comprobante (opcional).");
  }

  if (payment.publicNote) {
    lines.push("");
    lines.push(`Info adicional: ${payment.publicNote}`);
  }

  if (orderId) {
    lines.push("");
    lines.push(`Pedido asociado: ${orderId}`);
  }

  return lines.join("\n");
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizePaymentMethodInput(value) {
  const raw = normalizeTextForMatch(value);
  if (!raw) return "";
  if (
    raw.includes("transfer") ||
    raw.includes("banco") ||
    raw.includes("cbu") ||
    raw.includes("alias")
  ) {
    return "transferencia";
  }
  if (raw.includes("debito") || raw.includes("debit")) return "debito";
  if (raw.includes("credito") || raw.includes("credit") || raw.includes("tarjeta")) return "tarjeta";
  if (raw.includes("efectivo") || raw.includes("cash")) return "efectivo";
  return "";
}

function normalizePaymentStatusInput(value) {
  const raw = normalizeTextForMatch(value);
  if (!raw) return "";
  if (
    raw.includes("paid") ||
    raw.includes("pagado") ||
    raw.includes("approved") ||
    raw.includes("aprobado") ||
    raw.includes("settled") ||
    raw.includes("cobrado")
  ) {
    return "paid";
  }
  if (
    raw.includes("pending") ||
    raw.includes("pendiente") ||
    raw.includes("no pag") ||
    raw.includes("unpaid")
  ) {
    return "pending";
  }
  if (
    raw.includes("failed") ||
    raw.includes("fallido") ||
    raw.includes("rechaz") ||
    raw.includes("cancel")
  ) {
    return "failed";
  }
  return "";
}

function isPaidStatusValue(value) {
  return normalizePaymentStatusInput(value) === "paid";
}

function paymentMethodLabel(methodRaw) {
  const method = normalizePaymentMethodInput(methodRaw);
  if (method === "transferencia") return "Transferencia";
  if (method === "debito") return "Debito";
  if (method === "tarjeta") return "Tarjeta de credito";
  if (method === "efectivo") return "Efectivo";
  return "No definido";
}

function availablePaymentMethodKeys(company) {
  const payment = extractCompanyPaymentConfig(company?.rules || {});
  const methods = [];
  if (payment.enabled.cash) methods.push("efectivo");
  if (payment.enabled.debit) methods.push("debito");
  if (payment.enabled.transfer) methods.push("transferencia");
  if (payment.enabled.credit) methods.push("tarjeta");
  return methods.length ? methods : ["efectivo", "debito", "transferencia", "tarjeta"];
}

function paymentMethodSelectionPrompt(company) {
  const methods = availablePaymentMethodKeys(company).map((item) => paymentMethodLabel(item));
  return (
    `Perfecto. Ahora elegi medio de pago: ${methods.join(", ")}.\n` +
    `Ejemplo: efectivo / transferencia / debito / tarjeta`
  );
}

function extractCheckoutFieldsFromText(textRaw) {
  const text = String(textRaw || "").trim();
  const paymentMethod = normalizePaymentMethodInput(text);

  const phoneMatch = text.match(/\+?\d[\d\s\-()]{6,}\d/g);
  const contact = phoneMatch?.length
    ? String(phoneMatch[0] || "").trim().replace(/\s+/g, " ")
    : "";

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let name = "";
  for (const line of lines) {
    const normalized = normalizeTextForMatch(line);
    if (!normalized) continue;
    if (normalizePaymentMethodInput(line)) continue;
    if (/\d{6,}/.test(normalized)) continue;
    if (["si", "no", "ok", "listo", "hecho", "ahora", "hoy", "manana", "maÃ±ana"].includes(normalized)) continue;
    name = line;
    break;
  }

  if (!name && lines.length === 1) {
    let single = lines[0];
    if (contact) single = single.replace(contact, " ");
    single = single
      .replace(/efectivo/gi, " ")
      .replace(/transferencia/gi, " ")
      .replace(/transfer/gi, " ")
      .replace(/debito/gi, " ")
      .replace(/d[eÃ©]bito/gi, " ")
      .replace(/tarjeta/gi, " ")
      .replace(/credito/gi, " ")
      .replace(/cr[eÃ©]dito/gi, " ")
      .replace(/cash/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/[a-zA-Z]/.test(single)) name = single;
  }

  return { name, contact, paymentMethod };
}

function normalizeCatalogMatchText(value) {
  return normalizeTextForMatch(value)
    .replace(/[^a-z0-9\s,+\-\/x]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulCatalogValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  return !!raw && !["-", "n/a", "na", "null", "undefined", "sin dato", "s/d"].includes(raw);
}

function buildCatalogCategoryPathFromItem(itemRaw) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const categoryRaw = String(item.category ?? item.type ?? "").trim();
  if (isMeaningfulCatalogValue(categoryRaw)) return categoryRaw;

  const parts = [item.rubro, item.seccion, item.subseccion]
    .map((value) => String(value ?? "").trim())
    .filter((value) => isMeaningfulCatalogValue(value));
  if (!parts.length) return "-";

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.length ? unique.join(" > ") : "-";
}

function getCatalogGroupKeyset(itemRaw) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const sources = [
    buildCatalogCategoryPathFromItem(item),
    item.rubro,
    item.seccion,
    item.subseccion,
    item.category,
    item.type,
    item.tags,
  ];

  const keywords = new Set();
  for (const source of sources) {
    const values = Array.isArray(source) ? source : [source];
    for (const value of values) {
      const normalized = normalizeCatalogMatchText(value);
      if (!normalized) continue;
      keywords.add(normalized);
      for (const token of normalized.split(" ")) {
        if (token.length >= 3) keywords.add(token);
      }
    }
  }
  return keywords;
}

function extractWeightGramsFromText(value) {
  const raw = normalizeCatalogMatchText(value);
  if (!raw) return 0;
  const kgMatch = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos)\b/);
  if (kgMatch) {
    const n = Number(String(kgMatch[1]).replace(",", "."));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  const gMatch = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(g|gr|grs|gramo|gramos)\b/);
  if (gMatch) {
    const n = Number(String(gMatch[1]).replace(",", "."));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function extractNameTokensForCatalogSearch(value) {
  const raw = normalizeCatalogMatchText(value);
  if (!raw) return [];
  const clean = ` ${raw} `
    .replace(/\b\d+(?:[.,]\d+)?\s*(kg|kilo|kilos|g|gr|grs|gramo|gramos)\b/g, " ")
    .replace(/\b\d+\s*(x|unidades?|u|uds?)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\b(de|del|la|el|los|las|para|con|sin|quiero|agregar|agregame|sumame|sumar|suma|comprar|compra|pedido|carrito|checkout|info|informacion|detalle|detalles|contame|cuentame|mas|sobre|mostrame|mostrar|ver|me|interesa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  return clean.split(" ").filter((token) => token.length >= 3);
}

function scoreCatalogItemByTokens(item, tokens) {
  if (!tokens.length) return 0;
  const text = normalizeCatalogMatchText(
    `${item?.name || ""} ${item?.category || ""} ${item?.rubro || ""} ${item?.seccion || ""} ${item?.subseccion || ""}`
  );
  if (!text) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits;
}

function computeWeightedSelectionByGrams(textRaw, catalogRaw) {
  const requestedGrams = extractWeightGramsFromText(textRaw);
  if (!requestedGrams) return [];
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const tokens = extractNameTokensForCatalogSearch(textRaw);

  const candidates = catalog
    .map((item) => {
      const id = Number(item?.id);
      const weight = extractWeightGramsFromText(item?.name || "");
      if (!Number.isFinite(id) || !weight) return null;
      const score = scoreCatalogItemByTokens(item, tokens);
      return { id, weight, score };
    })
    .filter(Boolean)
    .filter((item) => (tokens.length ? item.score > 0 : true));

  if (!candidates.length) return [];

  const bestScore = Math.max(...candidates.map((c) => c.score));
  const scoped = candidates
    .filter((c) => c.score === bestScore)
    .sort((a, b) => b.weight - a.weight);
  const maxWeight = scoped[0]?.weight || 0;
  const minWeight = scoped[scoped.length - 1]?.weight || 0;
  if (!maxWeight || !minWeight) return [];

  const maxUnits = Math.min(60, Math.ceil(requestedGrams / minWeight) + 8);
  const limit = Math.max(requestedGrams + maxWeight * 2, requestedGrams);
  const dp = Array.from({ length: limit + 1 }, () => null);
  dp[0] = { units: 0, counts: Array(scoped.length).fill(0) };

  for (let total = 0; total <= limit; total += 1) {
    const state = dp[total];
    if (!state) continue;
    if (state.units >= maxUnits) continue;
    for (let i = 0; i < scoped.length; i += 1) {
      const nextTotal = total + scoped[i].weight;
      if (nextTotal > limit) continue;
      const nextUnits = state.units + 1;
      const current = dp[nextTotal];
      if (current && current.units <= nextUnits) continue;
      const counts = state.counts.slice();
      counts[i] += 1;
      dp[nextTotal] = { units: nextUnits, counts };
    }
  }

  let bestTotal = -1;
  let bestExcess = Number.POSITIVE_INFINITY;
  let bestUnits = Number.POSITIVE_INFINITY;
  for (let total = 0; total <= limit; total += 1) {
    const state = dp[total];
    if (!state || !state.units) continue;
    const excess = total >= requestedGrams ? total - requestedGrams : Number.POSITIVE_INFINITY;
    if (excess < bestExcess || (excess === bestExcess && state.units < bestUnits)) {
      bestExcess = excess;
      bestUnits = state.units;
      bestTotal = total;
    }
  }

  if (bestTotal < 0 || !dp[bestTotal]) return [];
  const selectedIds = [];
  dp[bestTotal].counts.forEach((qty, idx) => {
    for (let i = 0; i < qty; i += 1) selectedIds.push(scoped[idx].id);
  });
  return selectedIds;
}

function isPureCatalogSelectionText(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;

  const compact = ` ${raw} `
    .replace(/\b(\d{1,2})\s*x\s*(\d{1,3})\b/g, " ")
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\b(y|e|and|,|\/|\+|-|del|de|el|la|los|las)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !compact;
}

function looksLikeCatalogInfoIntent(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;
  const keywords = [
    "contame",
    "cuentame",
    "info",
    "informacion",
    "mas",
    "detalle",
    "detalles",
    "caracteristica",
    "caracteristicas",
    "que incluye",
    "que trae",
    "como funciona",
    "diferencia",
    "explicame",
  ];
  if (raw.includes("?")) return true;
  return keywords.some((word) => raw.includes(word));
}

function looksLikeCatalogAddIntent(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;
  const keywords = [
    "agrega",
    "agregame",
    "agregar",
    "sumame",
    "sumar",
    "suma",
    "anadi",
    "aÃ±adi",
    "aniadi",
    "adiciona",
    "quiero",
    "me interesa",
    "llevo",
    "comprar",
    "compra",
    "adquirir",
    "elijo",
    "elegi",
  ];
  return keywords.some((word) => raw.includes(word));
}

function looksLikeCatalogSelectionIntent(textRaw) {
  return (
    isPureCatalogSelectionText(textRaw) ||
    looksLikeCatalogAddIntent(textRaw) ||
    looksLikeCatalogInfoIntent(textRaw) ||
    extractWeightGramsFromText(textRaw) > 0
  );
}

function extractCatalogSelectionsFromText(textRaw, catalogRaw) {
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const normalizedText = normalizeCatalogMatchText(textRaw);
  const isInfoIntent = looksLikeCatalogInfoIntent(textRaw);
  const isAddIntent = looksLikeCatalogAddIntent(textRaw);
  const isPureSelection = isPureCatalogSelectionText(textRaw);
  const idToProduct = new Map();
  for (const item of catalog) {
    const id = Number(item?.id);
    if (!Number.isFinite(id)) continue;
    idToProduct.set(id, item);
  }

  const selectedIds = [];
  const selectedOnce = new Set();
  const invalidIds = [];
  let weightedMatched = false;

  const addId = (id, qty = 1, explicitQuantity = false) => {
    if (!idToProduct.has(id)) {
      if (!invalidIds.includes(id)) invalidIds.push(id);
      return;
    }
    if (explicitQuantity) {
      const safeQty = Math.max(1, Math.min(20, Number(qty) || 1));
      for (let i = 0; i < safeQty; i += 1) selectedIds.push(id);
      selectedOnce.add(id);
      return;
    }
    if (selectedOnce.has(id)) return;
    selectedIds.push(id);
    selectedOnce.add(id);
  };

  let working = ` ${normalizedText} `;
  working = working.replace(/\b\d+(?:[.,]\d+)?\s*(kg|kilo|kilos|g|gr|grs|gramo|gramos)\b/g, " ");
  const qtyPattern = /\b(\d{1,2})\s*x\s*(\d{1,3})\b/g;
  for (const match of normalizedText.matchAll(qtyPattern)) {
    const qty = Number(match[1]);
    const id = Number(match[2]);
    if (Number.isFinite(id)) addId(id, qty, true);
  }
  working = working.replace(qtyPattern, " ");

  const numericPattern = /\b(\d{1,3})\b/g;
  for (const match of working.matchAll(numericPattern)) {
    const id = Number(match[1]);
    if (!Number.isFinite(id)) continue;
    addId(id, 1, false);
  }

  const genericWords = new Set([
    "bot",
    "whatsapp",
    "con",
    "sin",
    "para",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "ai",
  ]);

  for (const [id, item] of idToProduct.entries()) {
    if (selectedOnce.has(id)) continue;
    const itemName = normalizeCatalogMatchText(item?.name || "");
    if (!itemName) continue;

    if (working.includes(` ${itemName} `)) {
      addId(id, 1, false);
      continue;
    }

    const strongTokens = itemName
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !genericWords.has(token));
    if (!strongTokens.length) continue;

    const allTokensPresent = strongTokens.every((token) => working.includes(token));
    if (allTokensPresent) addId(id, 1, false);
  }

  // Natural quantity by product name (ej: "2 unidades de almendras")
  const unitsByNameMatch = normalizedText.match(/\b(\d{1,2})\s*(?:x|unidades?|u|uds?)?\s+(?:de\s+)?(.+)$/);
  if (unitsByNameMatch) {
    const qty = Math.max(1, Math.min(20, Number(unitsByNameMatch[1]) || 1));
    const targetText = unitsByNameMatch[2] || "";
    const targetTokens = extractNameTokensForCatalogSearch(targetText);
    if (targetTokens.length) {
      const scored = [...idToProduct.entries()]
        .map(([id, item]) => ({ id, score: scoreCatalogItemByTokens(item, targetTokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
        addId(scored[0].id, qty, true);
      }
    }
  }

  // Weight-aware selection (ej: "200 gr de almendras", "600 gramos de almendras")
  if ((isAddIntent || isPureSelection) && !isInfoIntent) {
    const weightedIds = computeWeightedSelectionByGrams(textRaw, catalog);
    if (weightedIds.length) {
      weightedMatched = true;
      for (const id of weightedIds) addId(id, 1, true);
    }
  }

  const groupStopWords = new Set([
    "catalogo",
    "producto",
    "productos",
    "opcion",
    "opciones",
    "quiero",
    "agregar",
    "agregame",
    "sumame",
    "sumar",
    "suma",
    "compra",
    "comprar",
    "pedido",
    "pedidos",
    "carrito",
    "checkout",
    "info",
    "informacion",
    "detalle",
    "detalles",
    "contame",
    "cuentame",
    "mas",
    "sobre",
    "del",
    "de",
    "la",
    "el",
    "los",
    "las",
    "para",
    "con",
    "sin",
    "mostrame",
    "mostrar",
    "ver",
    "tengo",
    "que",
    "me",
    "interesa",
  ]);

  const queryTokens = normalizedText
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !groupStopWords.has(token));

  const groupMatchesRaw = [];
  if (queryTokens.length) {
    for (const [id, item] of idToProduct.entries()) {
      const keyset = getCatalogGroupKeyset(item);
      if (!keyset.size) continue;

      const keyList = [...keyset];
      let hits = 0;
      for (const token of queryTokens) {
        const matched = keyList.some((key) => {
          if (key === token) return true;
          if (key.length >= 4 && key.includes(token)) return true;
          if (token.length >= 5 && token.includes(key)) return true;
          return false;
        });
        if (matched) hits += 1;
      }

      if (hits > 0) {
        groupMatchesRaw.push({
          id,
          hits,
          category: buildCatalogCategoryPathFromItem(item),
        });
      }
    }
  }

  let groupMatchedIds = [];
  let groupLabels = [];
  if (groupMatchesRaw.length) {
    groupMatchesRaw.sort((a, b) => b.hits - a.hits || a.id - b.id);
    const minHits = queryTokens.length > 1 ? 2 : 1;
    const filtered = groupMatchesRaw.filter((row) => row.hits >= minHits);
    const scoped = filtered.length ? filtered : groupMatchesRaw;

    const uniqueIds = [];
    const seenIds = new Set();
    for (const row of scoped) {
      if (selectedOnce.has(row.id)) continue;
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      uniqueIds.push(row.id);
    }
    groupMatchedIds = uniqueIds;

    const labels = [];
    const seenLabels = new Set();
    for (const row of scoped) {
      const label = String(row.category || "-").trim();
      if (!isMeaningfulCatalogValue(label)) continue;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      labels.push(label);
      if (labels.length >= 3) break;
    }
    groupLabels = labels;
  }

  return {
    selectedIds,
    invalidIds,
    groupMatchedIds,
    groupLabels,
    hasSelectionIntent: looksLikeCatalogSelectionIntent(textRaw),
    isInfoIntent,
    isAddIntent,
    isPureSelection,
    weightedMatched,
  };
}

function summarizeCatalogSelection(idsRaw, catalogRaw) {
  const ids = Array.isArray(idsRaw) ? idsRaw : [];
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const counts = new Map();
  for (const id of ids) {
    const key = Number(id);
    if (!Number.isFinite(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lines = [];
  for (const [id, qty] of counts.entries()) {
    const product = catalog.find((item) => Number(item?.id) === id);
    const label = product?.name || `Producto ${id}`;
    lines.push(qty > 1 ? `${label} x${qty}` : label);
  }
  return lines;
}

function catalogItemDetailsText(itemRaw, currencyCode = "USD") {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const name = String(item.name || "Producto").trim();
  const priceText = formatChatMoney(Number(item.price || 0), currencyCode);
  const explicitDescription = String(
    item.description || item.details || item.detail || item.summary || item.info || ""
  ).trim();

  if (explicitDescription) {
    return `${name} - ${priceText}\n${explicitDescription}`;
  }

  const normalizedName = normalizeTextForMatch(name);
  if (normalizedName.includes("base")) {
    return `${name} - ${priceText}\nIncluye flujo comercial base sin IA avanzada, ideal para empezar.`;
  }
  if (normalizedName.includes("lite")) {
    return `${name} - ${priceText}\nIncluye IA LITE con memoria/contexto moderado y asistencia comercial.`;
  }
  if (normalizedName.includes("pro")) {
    return `${name} - ${priceText}\nIncluye IA PRO con mayor memoria/contexto y respuestas mas personalizadas.`;
  }
  if (normalizedName.includes("dashboard")) {
    return `${name} - ${priceText}\nPanel con metricas operativas para seguimiento comercial y pedidos.`;
  }
  return `${name} - ${priceText}\nSi queres, te detallo alcance y casos de uso para este producto.`;
}

function buildCatalogInfoReply(company, selectedIdsRaw) {
  const selectedIds = Array.isArray(selectedIdsRaw) ? selectedIdsRaw : [];
  const catalog = Array.isArray(company?.catalog) ? company.catalog : [];
  const uniqueIds = [...new Set(selectedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  const selectedItems = uniqueIds
    .map((id) => catalog.find((item) => Number(item?.id) === id))
    .filter(Boolean);

  if (!selectedItems.length) {
    return (
      "Decime que opcion queres revisar (por ID o nombre).\n" +
      "Ejemplo: info 2, info bot ai lite."
    );
  }

  const lines = [];
  const currency = getCompanyCatalogCurrency(company);
  lines.push(`Te paso info de ${selectedItems.length} opcion(es):`);
  lines.push("");
  for (const item of selectedItems) {
    lines.push(`${pickCatalogEmoji(item, Number(item?.id || 0))} ${catalogItemDetailsText(item, currency)}`);
    lines.push("");
  }
  lines.push("Si queres agregar al carrito, escribi: agregar <id> (ej: agregar 2).");
  lines.push("Tambien podes agregar varios por nombre o por IDs.");
  return lines.join("\n").trim();
}

function buildCatalogFilteredReply(company, selectedIdsRaw, labelsRaw = []) {
  const selectedIds = Array.isArray(selectedIdsRaw) ? selectedIdsRaw : [];
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter(Boolean) : [];
  const catalog = Array.isArray(company?.catalog) ? company.catalog : [];
  const uniqueIds = [...new Set(selectedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  const selectedItems = uniqueIds
    .map((id) => catalog.find((item) => Number(item?.id) === id))
    .filter(Boolean);

  if (!selectedItems.length) {
    return "No encontre productos para ese rubro/seccion. Escribi catalogo para ver opciones.";
  }

  const lines = [];
  const currency = getCompanyCatalogCurrency(company);
  const context = labels.length ? ` en ${labels.join(" / ")}` : "";
  lines.push(`Encontre ${selectedItems.length} producto(s)${context}:`);
  lines.push("");
  for (const [idx, item] of selectedItems.slice(0, 40).entries()) {
    const category = buildCatalogCategoryPathFromItem(item);
    const suffix = category !== "-" ? ` [${category}]` : "";
    lines.push(`${pickCatalogEmoji(item, idx)} ${item.name} - ${formatChatMoney(Number(item.price || 0), currency)}${suffix} (ID ${item.id})`);
  }
  if (selectedItems.length > 40) {
    lines.push("");
    lines.push(`Mostrando 40 de ${selectedItems.length}. Pedi un filtro mas especifico para acotar.`);
  }
  lines.push("");
  lines.push("Para agregar al carrito: agregar <id>  (ej: agregar 2)");
  lines.push("Para ver detalle: info <id>");
  return lines.join("\n");
}

function contextualCheckoutFallback(session, company, options = {}) {
  const state = String(session?.state || "MENU");
  const cartCount = Array.isArray(session?.cart) ? session.cart.length : 0;
  const activeOrderId = String(options.activeOrderId || "").trim();

  if (state === "ASK_NAME") {
    return "Necesito tu nombre para continuar con el pedido.";
  }
  if (state === "ASK_CONTACT") {
    return "Necesito un telefono de contacto para continuar.";
  }
  if (state === "ASK_NOTES") {
    return (
      "Agrega notas u observaciones para el pedido (opcional).\n" +
      "Si no queres agregar nada, dejalo vacio o responde: ok"
    );
  }
  if (state === "ASK_PAYMENT_METHOD") {
    return paymentMethodSelectionPrompt(company);
  }
  if (state === "ASK_PAYMENT_DETAILS") {
    return (
      `Contame detalle de coordinacion para el pedido ${activeOrderId || "(sin ID)"}.\n` +
      "Ejemplo: dia, horario y lugar. Si no aplica, responde con -"
    );
  }
  if (state === "MENU" && activeOrderId && !cartCount) {
    return (
      `Tenes un pedido activo (${activeOrderId}).\n` +
      "Podes enviar detalle de pago/entrega o escribir menu para iniciar un nuevo flujo."
    );
  }
  if (state === "MENU" && cartCount > 0) {
    const hasName = !!String(session?.data?.name || "").trim();
    const hasContact = !!String(session?.data?.contact || "").trim();
    const hasPayment = !!String(session?.data?.paymentMethodHint || "").trim();
    const missing = [];
    if (!hasName) missing.push("nombre");
    if (!hasContact) missing.push("contacto");
    if (!hasPayment) missing.push("medio de pago");

    if (!missing.length) {
      return (
        "Ya tengo carrito y datos base. Escribi checkout para continuar,\n" +
        "o envia todo junto: nombre + telefono + medio de pago.\n" +
        "Si queres ver detalles de un producto: info <id>."
      );
    }
    return (
      `Ya tengo tu carrito. Falta: ${missing.join(", ")}.\n` +
      "Tambien podes enviar todo en un solo mensaje (ej: Pedro 3812345678 efectivo).\n" +
      "Si queres ver detalles de un producto: info <id>."
    );
  }
  return "No entendi. Escribi: menu / catalogo / ayuda";
}

function looksLikeCheckoutOperationalMessage(textRaw) {
  const raw = normalizeTextForMatch(textRaw);
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return true;

  const keywords = [
    "catalogo",
    "carrito",
    "checkout",
    "agregar",
    "comprar",
    "compra",
    "pedido",
    "pago",
    "pagado",
    "comprobante",
    "transfer",
    "efectivo",
    "debito",
    "credito",
    "tarjeta",
    "confirmar",
    "me interesa",
    "quiero el",
    "quiero esos",
    "sumame",
    "sumar",
    "llevo",
  ];
  if (keywords.some((word) => raw.includes(word))) return true;

  const extracted = extractCheckoutFieldsFromText(textRaw);
  return !!(extracted.contact || extracted.paymentMethod);
}

function buildCheckoutItemsFromSession(session, company) {
  const items = Array.isArray(session?.cart) ? [...session.cart] : [];
  let total = 0;
  const grouped = {};
  items.forEach((id) => {
    const key = Number(id);
    if (!Number.isFinite(key)) return;
    grouped[key] = (grouped[key] || 0) + 1;
  });

  const itemsDetailed = Object.entries(grouped).map(([id, qty]) => {
    const p = (company?.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = Number(p?.price || 0);
    const subtotal = unit * qty;
    total += subtotal;
    return { id: Number(id), name: p?.name || `Producto ${id}`, qty, unit, subtotal };
  });

  return { items, itemsDetailed, total };
}

function mergeCheckoutNotes(existingNotesRaw, nextNotesRaw) {
  const existingNotes = String(existingNotesRaw || "").trim();
  const nextNotes = String(nextNotesRaw || "").trim();
  if (!existingNotes) return nextNotes;
  if (!nextNotes) return existingNotes;
  if (existingNotes.includes(nextNotes)) return existingNotes;
  return `${existingNotes}\n${nextNotes}`;
}

async function appendOrderNote(orderIdRaw, noteRaw) {
  const orderId = String(orderIdRaw || "").trim();
  const note = String(noteRaw || "").trim();
  if (!orderId || !note) return;
  await db.prepare(`
    UPDATE orders
    SET notes = CASE
      WHEN notes IS NULL OR btrim(notes) = '' THEN ?
      ELSE notes || ?
    END
    WHERE id=?
  `).run(note, `\n${note}`, orderId);
}

async function resolvePendingSessionOrder(session) {
  const sessionOrderId = String(session?.lastOrderId || "").trim();
  if (!sessionOrderId) return null;
  const row = await db.prepare(`
    SELECT id, companyId, workflowState, archived, category, orderStatus, paymentStatus
    FROM orders
    WHERE id=?
  `).get(sessionOrderId);
  if (!row) return null;
  const workflow = deriveOrderWorkflowFromRow(row);
  const sameCompany =
    String(row.companyId || "").trim().toLowerCase() ===
    String(session?.data?.companyId || "babystepsbots").trim().toLowerCase();
  if (!sameCompany || workflow.archived || workflow.state !== "pending") return null;
  return row;
}

async function buildUniqueOrderId() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = newOrderId();
    const exists = await db.prepare(`SELECT id FROM orders WHERE id=?`).get(candidate);
    if (!exists?.id) return candidate;
  }
  return `PED-${Date.now().toString(36).toUpperCase()}`;
}

async function createOrUpdateCheckoutOrder(session, from, company, options = {}) {
  const paymentMethod = normalizePaymentMethodInput(options.paymentMethod || "");
  const fallbackMethod = normalizePaymentMethodInput(options.fallbackPaymentMethod || "");
  const explicitOrderId = String(options.orderId || "").trim();
  const now = new Date().toISOString();
  const snapshot = buildCheckoutItemsFromSession(session, company);
  const orderNotes = String(session?.data?.notes || "").trim();
  const orderName = String(session?.data?.name || "").trim();
  const orderContact = String(session?.data?.contact || "").trim();

  let existing = null;
  if (explicitOrderId) {
    existing = await db.prepare(`
      SELECT id, companyId, name, contact, notes, itemsJson, itemsDetailedJson, total,
              paymentMethod, paymentStatus, orderStatus, workflowState, archived
      FROM orders
      WHERE id=?
    `).get(explicitOrderId);
  }

  const existingWorkflow = existing ? deriveOrderWorkflowFromRow(existing) : { state: "", archived: false };
  const canReuse = !!existing &&
    String(existing.companyId || "").trim() === String(company?.id || "").trim() &&
    !normalizeArchivedFlag(existing.archived) &&
    !existingWorkflow.archived &&
    existingWorkflow.state === "pending";

  const finalMethod = paymentMethod || fallbackMethod || normalizePaymentMethodInput(existing?.paymentMethod || "");

  if (canReuse) {
    const mergedName = orderName || String(existing.name || "");
    const mergedContact = orderContact || String(existing.contact || "");
    const mergedNotes = mergeCheckoutNotes(existing.notes, orderNotes);
    const hasCartItems = Array.isArray(snapshot.items) && snapshot.items.length > 0;
    const nextItemsJson = hasCartItems ? JSON.stringify(snapshot.items) : String(existing.itemsJson || "[]");
    const nextItemsDetailedJson = hasCartItems ? JSON.stringify(snapshot.itemsDetailed) : String(existing.itemsDetailedJson || "[]");
    const nextTotal = hasCartItems ? Number(snapshot.total || 0) : Number(existing.total || 0);

    await db.prepare(`
      UPDATE orders
      SET name=?, contact=?, notes=?, itemsJson=?, itemsDetailedJson=?, total=?,
          paymentStatus=?, paymentMethod=?, orderStatus=?, workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
      WHERE id=?
    `).run(
      mergedName,
      mergedContact,
      mergedNotes,
      nextItemsJson,
      nextItemsDetailedJson,
      nextTotal,
      "pending",
      finalMethod,
      "confirmed",
      "pending",
      false,
      null,
      "",
      "pending",
      existing.id
    );

    session.lastOrderId = existing.id;
    session.data.checkoutOrderId = existing.id;
    if (hasCartItems) session.cart = [];
    return { orderId: existing.id, total: nextTotal, paymentMethod: finalMethod, reused: true };
  }

  if (!snapshot.items.length) {
    return { orderId: "", total: 0, paymentMethod: finalMethod, reused: false, missingItems: true };
  }

  const orderId = await buildUniqueOrderId();
  await db.prepare(`
    INSERT INTO orders(
      id,createdAt,fromNumber,companyId,name,contact,notes,
      itemsJson,itemsDetailedJson,total,paymentStatus,paymentMethod,
      orderStatus,deliveredAt,category,workflowState,archived,archivedAt,archiveReason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    orderId,
    now,
    from,
    company.id,
    orderName,
    orderContact,
    orderNotes,
    JSON.stringify(snapshot.items),
    JSON.stringify(snapshot.itemsDetailed),
    snapshot.total,
    "pending",
    finalMethod,
    "confirmed",
    null,
    "pending",
    "pending",
    false,
    null,
    ""
  );

  session.lastOrderId = orderId;
  session.data.checkoutOrderId = orderId;
  session.cart = [];
  return { orderId, total: snapshot.total, paymentMethod: finalMethod, reused: false };
}

function buildOrderRegisteredReply(company, orderId, total, paymentMethodRaw) {
  const paymentMethod = normalizePaymentMethodInput(paymentMethodRaw);
  const paymentLabel = paymentMethodLabel(paymentMethod);
  const totalText = formatChatMoney(Number(total || 0), getCompanyCatalogCurrency(company));
  const lines = [
    `Pedido ${orderId} registrado.`,
    `Total: ${totalText}`,
    `Medio de pago: ${paymentLabel}.`,
    "",
  ];

  if (paymentMethod === "transferencia") {
    lines.push(paymentMethodsReplyText(company, { orderId }));
    lines.push("");
    lines.push("Si queres, envia comprobante (opcional) o indica cuando realizas la transferencia.");
    return lines.join("\n");
  }

  if (paymentMethod === "efectivo") {
    lines.push("Perfecto. Indica lugar y horario para coordinar pago en efectivo y entrega.");
    return lines.join("\n");
  }

  if (paymentMethod === "debito" || paymentMethod === "tarjeta") {
    lines.push("Perfecto. Indica lugar y horario para coordinar el pago y la entrega.");
    return lines.join("\n");
  }

  lines.push(paymentMethodsReplyText(company, { orderId }));
  return lines.join("\n");
}

async function notifyTelegramOrderCreated(company, fromNumber, created) {
  const orderId = String(created?.orderId || "").trim();
  if (!orderId) return false;
  if (created?.reused) return false;

  const total = Number(created?.total || 0);
  const paymentLabel = paymentMethodLabel(created?.paymentMethod || "");
  const companyName = String(company?.name || company?.id || "-").trim();
  const customer = String(fromNumber || "-").trim();

  return sendTelegram(
    `PEDIDO GENERADO\n` +
    `Empresa: ${companyName}\n` +
    `Cliente: ${customer}\n` +
    `Pedido: ${orderId}\n` +
    `Total: ${formatChatMoney(total, getCompanyCatalogCurrency(company))}\n` +
    `Pago: ${paymentLabel}`
  );
}

async function logWhatsappMessage({
  fromNumber,
  companyId,
  orderId = null,
  direction = "in",
  role = "user",
  content = "",
  mediaUrl = "",
  mediaContentType = "",
  twilioSid = "",
  createdAt = "",
}) {
  const from = String(fromNumber || "").trim();
  const cid = String(companyId || "").trim().toLowerCase() || "babystepsbots";
  const oid = String(orderId || "").trim();
  const dirRaw = String(direction || "").trim().toLowerCase();
  const dir = dirRaw === "out" ? "out" : "in";
  const roleRaw = String(role || "").trim().toLowerCase();
  const safeRole = roleRaw === "assistant" ? "assistant" : roleRaw === "system" ? "system" : "user";
  const body = String(content || "").trim();
  const media = String(mediaUrl || "").trim();
  const mediaType = String(mediaContentType || "").trim();
  const messageSid = String(twilioSid || "").trim();
  const at = String(createdAt || "").trim() || new Date().toISOString();

  if (!from || !cid) return;
  if (!body && !media) return;

  try {
    await db.prepare(`
      INSERT INTO ai_messages(
        fromNumber, companyId, orderId, direction, role, content, mediaUrl, mediaContentType, twilioSid, createdAt
      )
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      from,
      cid,
      oid || null,
      dir,
      safeRole,
      body,
      media || null,
      mediaType || null,
      messageSid || null,
      at
    );
  } catch (e) {
    console.error("ai_messages insert error:", e?.message || e);
  }
}

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

  if (force && data.aiModeManual) {
    delete data.aiModeManual;
    changed = true;
  }

  if (data.aiModeSource !== source) {
    data.aiModeSource = source;
    changed = true;
  }

  if (currentMode !== nextMode) {
    data.aiMode = nextMode;
    resetAiMemoryForMode(data);
    changed = true;
  }

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
  if (!companyId) {
    return { mode: "off", scanned: 0, updated: 0, skippedManual: 0 };
  }

  const mode = resolveAiModeFromRules(rulesRaw || {});
  const rows = await db.prepare(`SELECT fromNumber,dataJson FROM sessions`).all();
  let scanned = 0;
  let updated = 0;
  let skippedManual = 0;

  for (const row of rows) {
    const data = parseJsonSafe(row?.dataJson || "{}", {});
    const rowCompanyId = String(data?.companyId || "babystepsbots").trim().toLowerCase();
    if (rowCompanyId !== companyId) continue;
    scanned += 1;

    const result = applyCompanyAiModeToSessionData(data, mode, {
      force,
      source: `company:${companyId}`,
    });
    if (result.skippedManual) {
      skippedManual += 1;
      continue;
    }
    if (!result.changed) continue;

    await db.prepare(`UPDATE sessions SET dataJson=? WHERE fromNumber=?`).run(JSON.stringify(data), row.fromNumber);
    updated += 1;
  }

  return { mode, scanned, updated, skippedManual };
}

function formatCatalogChoices(catalogItems) {
  if (!catalogItems.length) return "Sin opciones de catalogo.";
  return catalogItems
    .map((item) => `- ${item.id ? `${item.id}) ` : ""}${item.name}`)
    .join("\n");
}

function roundMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeCatalogEntries(catalogRaw) {
  if (!Array.isArray(catalogRaw)) return [];
  return catalogRaw
    .map((item, idx) => ({
      id: String(item?.id ?? "").trim(),
      idLower: String(item?.id ?? "").trim().toLowerCase(),
      name: String(item?.name || item?.title || `Producto ${idx + 1}`).trim(),
      nameLower: String(item?.name || item?.title || `Producto ${idx + 1}`).trim().toLowerCase(),
      price: roundMoney(item?.price ?? item?.amount ?? 0),
    }))
    .filter((item) => item.name);
}

async function getCatalogProviderRow() {
  return await db.prepare(`SELECT id,name,catalogJson FROM companies WHERE id=?`).get(BOT_CATALOG_PROVIDER_ID);
}

async function resolveBotCatalogForCompany(targetCompanyId, targetCatalogRaw) {
  const targetId = String(targetCompanyId || "").trim().toLowerCase();
  const ownCatalog = normalizeCatalogEntries(targetCatalogRaw);

  if (targetId === BOT_CATALOG_PROVIDER_ID) {
    return {
      sourceId: BOT_CATALOG_PROVIDER_ID,
      sourceName: "Catalogo proveedor",
      catalogItems: ownCatalog,
    };
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

  return {
    sourceId: targetId || BOT_CATALOG_PROVIDER_ID,
    sourceName: "Catalogo empresa",
    catalogItems: ownCatalog,
  };
}

function isValidDateObj(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return isValidDateObj(d) ? d : null;
}

function monthRefFromShift(baseYear, baseMonth, shift) {
  const d = new Date(Date.UTC(baseYear, baseMonth + shift, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function clampDayOfMonth(year, month, day) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), last);
}

function buildUtcDate(year, month, day) {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

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

  return {
    anchorIso: anchor.toISOString(),
    cycleDay: anchorDay,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    renewalIso: renewal.toISOString(),
    totalDays,
    remainingDays,
  };
}

function findCatalogItemByBot(catalogItems, botClass, botCatalogId) {
  const idRaw = String(botCatalogId || "").trim().toLowerCase();
  const classRaw = String(botClass || "").trim().toLowerCase();
  if (!catalogItems.length) return null;
  if (idRaw) {
    const byId = catalogItems.find((item) => item.idLower === idRaw);
    if (byId) return byId;
  }
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

  const fallback = roundMoney(
    rules?.subscriptionAmount ??
    rules?.subscriptionNextAmount ??
    rules?.monthlyPrice ??
    0
  );
  return { selected: null, amount: fallback };
}

function syncRulesSubscription({
  rules,
  catalogItems,
  previousRules = null,
  previousCatalogItems = null,
  now = new Date(),
  triggerUpgrade = false,
}) {
  const nextRules = rules && typeof rules === "object" ? { ...rules } : {};
  const prevRulesObj = previousRules && typeof previousRules === "object" ? previousRules : {};
  const prevCatalog = Array.isArray(previousCatalogItems) ? previousCatalogItems : catalogItems;

  const currentBot = findCatalogItemByBot(catalogItems, nextRules.botClass, nextRules.botCatalogId);
  if (currentBot) {
    nextRules.botClass = currentBot.name;
    if (currentBot.id) nextRules.botCatalogId = currentBot.id;
  }

  const currentBotClass = String(nextRules.botClass || "").trim();
  if (!currentBotClass) {
    const mode = String(nextRules.channelMode || "").toLowerCase();
    let inferred = null;
    if (mode === "instagram") {
      inferred = catalogItems.find((item) => item.nameLower.includes("instagram") || item.nameLower.includes("insta"));
    } else if (mode === "combinado") {
      inferred = catalogItems.find((item) => item.nameLower.includes("unificado") || item.nameLower.includes("combinado"));
    } else if (mode === "whatsapp") {
      inferred = catalogItems.find((item) => item.nameLower.includes("whatsapp"));
    }
    if (!inferred && catalogItems.length === 1) inferred = catalogItems[0];
    if (inferred) {
      nextRules.botClass = inferred.name;
      if (inferred.id) nextRules.botCatalogId = inferred.id;
    }
  }

  const { selected, amount } = resolveBotPriceFromRules(nextRules, catalogItems);
  const activeAmount = roundMoney(amount);
  const activeName = selected?.name || String(nextRules.botClass || "").trim();

  const anchorSource =
    nextRules.subscriptionAnchorDate ||
    nextRules.subscriptionStartDate ||
    nextRules.botActivatedAt ||
    now.toISOString();
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
  if (activeName) {
    nextRules.subscriptionPlan = activeName;
  }

  if (triggerUpgrade) {
    const prev = resolveBotPriceFromRules(prevRulesObj, prevCatalog);
    const prevAmount = roundMoney(prev.amount);
    if (activeAmount > prevAmount && cycle.totalDays > 0 && cycle.remainingDays > 0) {
      const prorated = roundMoney((activeAmount * cycle.remainingDays) / cycle.totalDays);
      nextRules.subscriptionProrationDueNow = prorated;
      nextRules.subscriptionProrationAt = (parseDateSafe(now) || new Date()).toISOString();
    } else {
      nextRules.subscriptionProrationDueNow = 0;
    }
  }

  return nextRules;
}

function normalizeOrderWorkflowState(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("reject") || raw.includes("rechaz") || raw.includes("cancel") || raw.includes("anul")) return "rejected";
  if (raw.includes("complet") || raw.includes("entreg") || raw.includes("finaliz") || raw.includes("cerrad")) return "completed";
  if (raw.includes("pend")) return "pending";
  return "";
}

function normalizeArchivedFlag(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "si" || raw === "on";
}

function parseLegacyOrderCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return { state: "", archived: false };
  if (raw.includes("archiv")) {
    const stripped = raw
      .replaceAll("archived", "")
      .replaceAll("archivado", "")
      .replaceAll(":", " ")
      .replaceAll("|", " ")
      .replaceAll("-", " ")
      .trim();
    return { state: normalizeOrderWorkflowState(stripped), archived: true };
  }
  return { state: normalizeOrderWorkflowState(raw), archived: false };
}

function inferOrderWorkflowStateFromStatus(orderStatus, paymentStatus) {
  const orderRaw = String(orderStatus || "").trim().toLowerCase();
  const paymentRaw = String(paymentStatus || "").trim().toLowerCase();
  if (
    ["rejected", "rechazado", "cancelled", "canceled", "cancelado", "anulado"].some((v) => orderRaw.includes(v)) ||
    ["failed", "voided", "refunded", "chargeback"].some((v) => paymentRaw.includes(v))
  ) {
    return "rejected";
  }
  if (["delivered", "completed", "done", "entregado", "finalizado", "cerrado"].some((v) => orderRaw.includes(v))) {
    return "completed";
  }
  return "pending";
}

function deriveOrderWorkflowFromRow(row) {
  const explicitState = normalizeOrderWorkflowState(row?.workflowState);
  const explicitArchived = row?.archived === 1 || row?.archived === true || String(row?.archived || "").trim() === "1";
  let state = explicitState;
  let archived = explicitArchived;

  if (!state || !explicitArchived) {
    const legacy = parseLegacyOrderCategory(row?.category);
    if (!state && legacy.state) state = legacy.state;
    if (!archived && legacy.archived) archived = true;
  }

  if (!archived) {
    const orderRaw = String(row?.orderStatus || "").trim().toLowerCase();
    if (["archived", "archivado"].some((v) => orderRaw.includes(v))) archived = true;
  }
  if (!state) {
    state = inferOrderWorkflowStateFromStatus(row?.orderStatus, row?.paymentStatus);
  }
  return { state, archived };
}

function normalizeOrderRow(row) {
  if (!row) return null;
  const workflow = deriveOrderWorkflowFromRow(row);
  const archivedAt = workflow.archived
    ? (row?.archivedAt || row?.deliveredAt || row?.createdAt || null)
    : null;
  const archiveReason = workflow.archived
    ? String(row?.archiveReason || workflow.state || "")
    : "";
  const legacyCategory = workflow.archived ? `archived:${workflow.state}` : workflow.state;
  return {
    id: row?.id ?? "",
    createdAt: row?.createdAt ?? "",
    fromNumber: row?.fromNumber ?? "",
    companyId: row?.companyId ?? "",
    name: row?.name ?? "",
    contact: row?.contact ?? "",
    notes: row?.notes ?? "",
    itemsJson: row?.itemsJson ?? "[]",
    itemsDetailedJson: row?.itemsDetailedJson ?? "[]",
    total: Number(row?.total || 0),
    paymentStatus: row?.paymentStatus ?? "",
    paymentMethod: row?.paymentMethod ?? "",
    orderStatus: row?.orderStatus ?? "",
    deliveredAt: row?.deliveredAt ?? null,
    category: row?.category ?? legacyCategory,
    workflowState: workflow.state,
    archived: workflow.archived,
    archivedAt,
    archiveReason,
  };
}

async function backfillOrdersWorkflowColumns() {
  try {
    const rows = await db.prepare(`
      SELECT id, workflowState, archived, category, orderStatus, paymentStatus, archivedAt, archiveReason, createdAt
      FROM orders
    `).all();
    if (!Array.isArray(rows) || !rows.length) return;

    for (const row of rows) {
      const hasState = String(row?.workflowState || "").trim().length > 0;
      const hasArchived = row?.archived === false || row?.archived === true || String(row?.archived || "").trim() !== "";
      if (hasState && hasArchived) continue;

      const workflow = deriveOrderWorkflowFromRow(row);
      const archivedAt = workflow.archived
        ? String(row?.archivedAt || row?.createdAt || new Date().toISOString())
        : null;
      const archiveReason = workflow.archived
        ? String(row?.archiveReason || workflow.state || "")
        : "";
      const legacyCategory = workflow.archived ? `archived:${workflow.state}` : workflow.state;

      await db.prepare(`
        UPDATE orders
        SET workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
        WHERE id=?
      `).run(
        workflow.state || "pending",
        workflow.archived,
        archivedAt,
        archiveReason,
        legacyCategory,
        row.id
      );
    }
  } catch (e) {
    console.error("Workflow backfill error:", e?.message || e);
  }
}

await backfillOrdersWorkflowColumns();

// ================== FIN PARTE 1: PEGAR PARTE 2 DESDE AQUÃ ==================
// ===== API: Companies =====
app.get("/api/companies", requireApiAuth, async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT id,name,createdAt,prompt,catalogJson,rulesJson FROM companies ORDER BY id`).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/companies/:id", requireApiAuth, async (req, res) => {
  try {
    const row = await db.prepare(`SELECT * FROM companies WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/companies", requireApiAuth, async (req, res) => {
  try {
    const id = String(req.body.id || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    if (!id.match(/^[a-z0-9_-]{3,40}$/)) return res.status(400).json({ error: "ID invalido" });

    await db.prepare(`
      INSERT INTO companies(id,name,prompt,catalogJson,rulesJson,createdAt)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      id,
      name || id,
      "Sos el asistente de la empresa. Respondes acorde al manual de marca.",
      "[]",
      JSON.stringify({ tone: "neutral", allowHuman: true }),
      new Date().toISOString()
    );

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/companies/:id/save", requireApiAuth, async (req, res) => {
  const id = req.params.id;
  const name = String(req.body.name || "").trim();
  const prompt = String(req.body.prompt || "");
  const catalogJson = String(req.body.catalogJson || "[]");
  const rulesJson = String(req.body.rulesJson || "{}");

  let parsedCatalog;
  let parsedRules;
  try {
    parsedCatalog = JSON.parse(catalogJson);
    if (!Array.isArray(parsedCatalog)) throw new Error("catalogJson debe ser un array");
  } catch (e) {
    return res.status(400).json({ error: `Catalog JSON invalido: ${e.message}` });
  }

  try {
    parsedRules = JSON.parse(rulesJson);
    if (!parsedRules || Array.isArray(parsedRules) || typeof parsedRules !== "object") {
      throw new Error("rulesJson debe ser un objeto");
    }
  } catch (e) {
    return res.status(400).json({ error: `Rules JSON invalido: ${e.message}` });
  }

  const existing = await db.prepare(`SELECT rulesJson,catalogJson FROM companies WHERE id=?`).get(id);
  const previousRules = parseJsonSafe(existing?.rulesJson || "{}", {});
  const previousOwnCatalog = normalizeCatalogEntries(parseJsonSafe(existing?.catalogJson || "[]", []));
  const resolvedCatalog = await resolveBotCatalogForCompany(id, parsedCatalog);
  const nextCatalog = resolvedCatalog.catalogItems;
  const previousCatalog = id === BOT_CATALOG_PROVIDER_ID ? previousOwnCatalog : nextCatalog;
  const previousBotClass = String(previousRules?.botClass || "").trim().toLowerCase();
  const nextBotClass = String(parsedRules?.botClass || "").trim().toLowerCase();
  const triggerUpgrade = previousBotClass && nextBotClass && previousBotClass !== nextBotClass;

  const syncedRules = syncRulesSubscription({
    rules: parsedRules,
    catalogItems: nextCatalog,
    previousRules,
    previousCatalogItems: previousCatalog,
    now: new Date(),
    triggerUpgrade,
  });
  syncedRules.botCatalogProviderId = resolvedCatalog.sourceId;
  syncedRules.botCatalogProviderName = resolvedCatalog.sourceName;
  const finalRulesJson = JSON.stringify(syncedRules);

  await db.prepare(`UPDATE companies SET name=?, prompt=?, catalogJson=?, rulesJson=? WHERE id=?`).run(
    name || id,
    prompt,
    catalogJson,
    finalRulesJson,
    id
  );

  const syncResult = await syncCompanySessionsAiMode(id, syncedRules, { force: true });
  res.json({ ok: true, aiSync: syncResult });
});

app.post("/api/companies/:id/delete", requireApiAuth, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM companies WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ===== API: Assignments =====
app.get("/api/assignments", requireApiAuth, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT fromNumber, companyId, updatedAt
      FROM customer_company
      ORDER BY updatedAt DESC
      LIMIT 100
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/assignments", requireApiAuth, async (req, res) => {
  try {
    let fromNumber = normalizeWhatsappFromNumber(req.body.fromNumber);
    const companyId = String(req.body.companyId || "").trim();

    if (!fromNumber || !fromNumber.startsWith("whatsapp:+")) {
      return res.status(400).json({ error: "fromNumber invalido. Usa formato whatsapp:+549..." });
    }

    const exists = await db.prepare(`SELECT id FROM companies WHERE id=?`).get(companyId);
    if (!exists) return res.status(400).json({ error: "Empresa no existe" });

    await db.prepare(`
      INSERT INTO customer_company(fromNumber, companyId, updatedAt)
      VALUES(?,?,?)
      ON CONFLICT(fromNumber) DO UPDATE SET
        companyId=excluded.companyId,
        updatedAt=excluded.updatedAt
    `).run(fromNumber, companyId, new Date().toISOString());

    const s = await db.prepare(`SELECT dataJson FROM sessions WHERE fromNumber=?`).get(fromNumber);
    if (s) {
      const data = JSON.parse(s.dataJson || "{}");
      const previousCompanyId = String(data.companyId || "babystepsbots").trim().toLowerCase();
      const nextCompanyId = String(companyId || "").trim().toLowerCase();
      if (previousCompanyId !== nextCompanyId) {
        resetAiMemoryForMode(data);
        data.humanNotified = false;
        data.name = "";
        data.contact = "";
        data.notes = "";
        delete data.paymentMethodHint;
        delete data.checkoutOrderId;
      }
      data.companyId = companyId;
      const tempSession = { data };
      await syncSessionAiModeFromCompany(tempSession, { force: true });
      await db.prepare(`
        UPDATE sessions
        SET state='MENU', cartJson='[]', lastOrderId=NULL, dataJson=?
        WHERE fromNumber=?
      `).run(JSON.stringify(data), fromNumber);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/assignments/delete", requireApiAuth, async (req, res) => {
  try {
    const fromNumber = normalizeWhatsappFromNumber(req.body.fromNumber);
    if (!fromNumber || !fromNumber.startsWith("whatsapp:+")) {
      return res.status(400).json({ error: "fromNumber invalido" });
    }
    await db.prepare(`DELETE FROM customer_company WHERE fromNumber=?`).run(fromNumber);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ===== API: Orders =====
app.get("/api/orders", requireApiAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const companyId = String(req.query.companyId || "").trim();
    const limitRaw = Number(req.query.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 100;

    const parseDateParam = (value, endOfDay = false) => {
      const raw = String(value || "").trim();
      if (!raw) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [yy, mm, dd] = raw.split("-").map((v) => Number(v));
        const date = endOfDay
          ? new Date(Date.UTC(yy, mm - 1, dd, 23, 59, 59, 999))
          : new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0));
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
      }
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    };

    const fromIso = parseDateParam(req.query.from, false);
    const toIso = parseDateParam(req.query.to, true);

    const where = [];
    const params = [];

    if (companyId) {
      where.push("companyId = ?");
      params.push(companyId);
    }

    if (q) {
      const like = `%${q}%`;
      const searchFields = ["id", "fromNumber", "companyId", "name", "contact"];
      where.push(`(${searchFields.map((field) => `${field} LIKE ?`).join(" OR ")})`);
      params.push(...searchFields.map(() => like));
    }

    if (fromIso) {
      where.push("createdAt >= ?");
      params.push(fromIso);
    }

    if (toIso) {
      where.push("createdAt <= ?");
      params.push(toIso);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT
        id,createdAt,fromNumber,companyId,name,contact,notes,
        itemsJson,itemsDetailedJson,total,paymentStatus,paymentMethod,
        orderStatus,deliveredAt,category,workflowState,archived,archivedAt,archiveReason
      FROM orders
      ${whereSql}
      ORDER BY createdAt DESC
      LIMIT ?
    `;

    const rows = await db.prepare(sql).all(...params, limit);
    const normalized = rows.map((row) => normalizeOrderRow(row)).filter(Boolean);
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/orders/:id", requireApiAuth, async (req, res) => {
  try {
    const orderId = String(req.params.id || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId requerido" });
    const companyIdQuery = String(req.query.companyId || "").trim();

    const row = await db.prepare(`
      SELECT
        id,createdAt,fromNumber,companyId,name,contact,notes,
        itemsJson,itemsDetailedJson,total,paymentStatus,paymentMethod,
        orderStatus,deliveredAt,category,workflowState,archived,archivedAt,archiveReason
      FROM orders
      WHERE id=?
      LIMIT 1
    `).get(orderId);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    if (companyIdQuery && String(row.companyId || "").trim() !== companyIdQuery) {
      return res.status(403).json({ error: "Pedido no pertenece a esa empresa" });
    }

    return res.json(normalizeOrderRow(row));
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/orders/:id/messages", requireApiAuth, async (req, res) => {
  try {
    const orderId = String(req.params.id || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId requerido" });
    const companyIdQuery = String(req.query.companyId || "").trim();

    const limitRaw = Number(req.query.limit || 120);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 120;

    const order = await db.prepare(`SELECT id, companyId FROM orders WHERE id=?`).get(orderId);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
    if (companyIdQuery && String(order.companyId || "").trim() !== companyIdQuery) {
      return res.status(403).json({ error: "Pedido no pertenece a esa empresa" });
    }

    const rows = await db.prepare(`
      SELECT
        id, fromNumber, companyId, orderId, direction, role, content, mediaUrl, mediaContentType, twilioSid, createdAt
      FROM ai_messages
      WHERE orderId=?
      ORDER BY createdAt ASC
      LIMIT ?
    `).all(orderId, limit);

    const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row?.id || 0),
      fromNumber: String(row?.fromNumber || ""),
      companyId: String(row?.companyId || ""),
      orderId: String(row?.orderId || ""),
      direction: String(row?.direction || "").toLowerCase() === "out" ? "out" : "in",
      role: String(row?.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
      content: String(row?.content || ""),
      mediaUrl: String(row?.mediaUrl || ""),
      mediaContentType: String(row?.mediaContentType || ""),
      twilioSid: String(row?.twilioSid || ""),
      createdAt: row?.createdAt || "",
    }));

    return res.json({
      orderId,
      companyId: String(order.companyId || ""),
      count: normalized.length,
      messages: normalized,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/orders/:id/category", requireApiAuth, async (req, res) => {
  try {
    const orderId = String(req.params.id || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId requerido" });

    const current = await db.prepare(`
      SELECT id, workflowState, archived, category, orderStatus, paymentStatus, archivedAt, archiveReason
      FROM orders
      WHERE id=?
    `).get(orderId);
    if (!current) return res.status(404).json({ error: "Pedido no encontrado" });

    const stateInput = normalizeOrderWorkflowState(req.body.state);
    const legacy = parseLegacyOrderCategory(req.body.category);
    const hasArchivedInput = req.body.archived !== undefined && req.body.archived !== null && String(req.body.archived).trim() !== "";
    const archived = hasArchivedInput ? normalizeArchivedFlag(req.body.archived) : legacy.archived;
    const currentWorkflow = deriveOrderWorkflowFromRow(current);
    const state = stateInput || legacy.state || currentWorkflow.state;
    if (!state) return res.status(400).json({ error: "Estado invalido" });
    const archiveReasonInput = String(req.body.archiveReason || "").trim();

    const archivedAt = archived ? String(current?.archivedAt || new Date().toISOString()) : null;
    const archiveReason = archived
      ? String(archiveReasonInput || current?.archiveReason || state)
      : "";
    const legacyCategory = archived ? `archived:${state}` : state;
    const currentPaymentStatus = String(current?.paymentStatus || "").trim();
    const isPaid = isPaidStatusValue(currentPaymentStatus);
    const nextPaymentStatus = state === "completed"
      ? (isPaid ? currentPaymentStatus : "paid")
      : currentPaymentStatus;
    const nextOrderStatus = state === "completed"
      ? "completed"
      : state === "rejected"
        ? "rejected"
        : "confirmed";

    const result = await db.prepare(`
      UPDATE orders
      SET workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?, paymentStatus=?, orderStatus=?
      WHERE id=?
    `).run(state, archived, archivedAt, archiveReason, legacyCategory, nextPaymentStatus, nextOrderStatus, orderId);

    if (!result.changes) return res.status(404).json({ error: "Pedido no encontrado" });
    return res.json({
      ok: true,
      id: orderId,
      state,
      archived,
      category: legacyCategory,
      paymentStatus: nextPaymentStatus,
      orderStatus: nextOrderStatus,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/companies/:id/whatsapp-messages/stats", requireApiAuth, async (req, res) => {
  try {
    const companyId = String(req.params.id || "").trim().toLowerCase();
    if (!companyId) return res.status(400).json({ error: "companyId requerido" });

    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = await db.prepare(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END), 0)::int AS last30Days
      FROM ai_messages
      WHERE role='user'
        AND (
          companyId = ?
          OR (
            companyId IS NULL
            AND fromNumber IN (SELECT fromNumber FROM customer_company WHERE companyId = ?)
          )
        )
    `).get(since30, companyId, companyId);

    return res.json({
      companyId,
      total: Number(row?.total || 0),
      last30Days: Number(row?.last30Days || 0),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/orders/:id/payment-status", requireApiAuth, async (req, res) => {
  try {
    const orderId = String(req.params.id || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId requerido" });

    const current = await db.prepare(`
      SELECT id, paymentStatus
      FROM orders
      WHERE id=?
    `).get(orderId);
    if (!current) return res.status(404).json({ error: "Pedido no encontrado" });

    let nextPaymentStatus = normalizePaymentStatusInput(req.body.paymentStatus || "");
    if (!nextPaymentStatus && req.body.paid !== undefined) {
      nextPaymentStatus = normalizeArchivedFlag(req.body.paid) ? "paid" : "pending";
    }
    if (!nextPaymentStatus) return res.status(400).json({ error: "paymentStatus invalido" });

    const result = await db.prepare(`
      UPDATE orders
      SET paymentStatus=?
      WHERE id=?
    `).run(nextPaymentStatus, orderId);

    if (!result.changes) return res.status(404).json({ error: "Pedido no encontrado" });
    return res.json({
      ok: true,
      id: orderId,
      paymentStatus: nextPaymentStatus,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
  const fromRaw = req.body.From || "unknown";
  const from = normalizeWhatsappFromNumber(fromRaw) || String(fromRaw || "unknown").trim() || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmdRaw = body.replace(/\s+/g, " ").trim();
  const cmd = cmdRaw.toLowerCase();
  const numMedia = Number(req.body.NumMedia || 0);
  const hasMedia = Number.isFinite(numMedia) && numMedia > 0;
  const twilioSid = String(req.body.MessageSid || "").trim();

  if (from && from !== "unknown" && !cmd.startsWith("admin")) await setSetting("last_customer", from);

  const session = await getSession(from);
  let sessionDirty = false;

  const map = await db.prepare(`SELECT companyId FROM customer_company WHERE fromNumber=?`).get(from);
  if (map?.companyId && session.data.companyId !== map.companyId) {
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
    session.data.companyId = map.companyId;
    sessionDirty = true;
  }

  const sessionModeSync = await syncSessionAiModeFromCompany(session);
  if (sessionModeSync.changed) {
    sessionDirty = true;
  }

  if (sessionDirty) {
    await saveSession(session);
  }

  const pendingOrderForSession = await resolvePendingSessionOrder(session);
  const activeOrderId = String(pendingOrderForSession?.id || "").trim();
  const hasActiveOrder = !!activeOrderId;

  const respondAndLog = async (textOut, options = {}) => {
    const message = String(textOut || "");
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

  if (hasMedia && !cmd.startsWith("admin")) {
    const orderId = activeOrderId;
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
    await sendTelegram(
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
      s2.data.companyId = companyId;
      if (previousCompanyId !== companyId) {
        resetAiMemoryForMode(s2.data);
        s2.state = "MENU";
        s2.cart = [];
        s2.lastOrderId = null;
        s2.data.humanNotified = false;
        s2.data.name = "";
        s2.data.contact = "";
        s2.data.notes = "";
        delete s2.data.paymentMethodHint;
        delete s2.data.checkoutOrderId;
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
    return respondAndLog(menuText(company));
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
    session.state = "MENU";
    session.cart = [];
    session.data.name = "";
    session.data.contact = "";
    session.data.notes = "";
    session.data.humanNotified = false;
    delete session.data.paymentMethodHint;
    delete session.data.checkoutOrderId;
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
      await db.prepare(`
        UPDATE orders
        SET paymentMethod=?, paymentStatus=?, orderStatus=?, workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
        WHERE id=?
      `).run(
        methodFromText,
        "pending",
        "confirmed",
        "pending",
        false,
        null,
        "",
        "pending",
        activeOrderId
      );
      await appendOrderNote(
        activeOrderId,
        `[Cambio medio de pago ${new Date().toISOString()}] ${paymentMethodLabel(methodFromText)}`
      );
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
  if (session.state === "MENU" && hasActiveOrder && !hasMedia && !session.cart.length && looksLikePaymentReady) {
    return respondAndLog(
      `Perfecto. Para avanzar con la validacion del pedido ${activeOrderId}, envia el comprobante cuando lo tengas.\n` +
      `Si ya lo enviaste, no hace falta repetirlo: te confirmamos por este chat.`
    );
  }

  if (session.state === "MENU" && hasActiveOrder && !hasMedia && !session.cart.length) {
    const directMethod = normalizePaymentMethodInput(body);
    if (directMethod) {
      await db.prepare(`
        UPDATE orders
        SET paymentMethod=?, paymentStatus=?, orderStatus=?, workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
        WHERE id=?
      `).run(
        directMethod,
        "pending",
        "confirmed",
        "pending",
        false,
        null,
        "",
        "pending",
        activeOrderId
      );
      await appendOrderNote(
        activeOrderId,
        `[Cambio medio de pago ${new Date().toISOString()}] ${paymentMethodLabel(directMethod)}`
      );
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
    session.cart.push(id);
    await saveSession(session);
    return respondAndLog(`Agregado ${p.name}\n\n${await cartText(session)}\n\nPara finalizar: checkout`);
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
      (detected.isAddIntent || detected.isPureSelection || detected.weightedMatched) &&
      !looksLikeCheckoutData;

    if (canAutoAddFromNaturalText) {
      for (const id of detected.selectedIds) session.cart.push(Number(id));
      await saveSession(session);
      const added = summarizeCatalogSelection(detected.selectedIds, company.catalog || []);
      const addedText = added.length ? `Agregados: ${added.join(", ")}` : "Productos agregados al carrito.";
      return respondAndLog(
        `${addedText}\n\n${await cartText(session)}\n\nPara continuar: checkout`,
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
      await notifyTelegramOrderCreated(company, from, created);
      session.state = "ASK_PAYMENT_DETAILS";
      delete session.data.paymentMethodHint;
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
      await notifyTelegramOrderCreated(company, from, created);
      session.state = "ASK_PAYMENT_DETAILS";
      delete session.data.paymentMethodHint;
      await saveSession(session);
      return respondAndLog(
        buildOrderRegisteredReply(company, created.orderId, created.total, created.paymentMethod),
        { orderId: created.orderId }
      );
    }

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

    const created = await createOrUpdateCheckoutOrder(session, from, company, {
      paymentMethod: selectedMethod,
      fallbackPaymentMethod: session.data.paymentMethodHint || "",
    });
    if (created.missingItems) {
      session.state = "MENU";
      await saveSession(session);
      return respondAndLog("No pude registrar el pedido porque el carrito esta vacio. Escribi: catalogo");
    }

    await notifyTelegramOrderCreated(company, from, created);
    session.state = "ASK_PAYMENT_DETAILS";
    delete session.data.paymentMethodHint;
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
      await db.prepare(`
        UPDATE orders
        SET paymentMethod=?, paymentStatus=?, orderStatus=?, workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?
        WHERE id=?
      `).run(
        maybeMethodChange,
        "pending",
        "confirmed",
        "pending",
        false,
        null,
        "",
        "pending",
        orderId
      );
      await appendOrderNote(orderId, `[Cambio medio de pago ${new Date().toISOString()}] ${paymentMethodLabel(maybeMethodChange)}`);
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
    await notifyTelegramOrderCreated(company, from, created);
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
    const ai = await aiReply(session, from, body);
    if (ai) return respondAndLog(ai);
  }

  const company = await getCompanySafe(session);
  await saveSession(session);
  return respondAndLog(
    contextualCheckoutFallback(session, company, { activeOrderId })
  );
});
// ================= RESPUESTA =================
function respond(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.type("text/xml").send(twiml.toString());
}

// ================= HEALTH =================
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log("ðŸš€ Bot corriendo"));



