import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db } from "./db.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// ====== MIGRATIONS (evita "no such table" en DB vieja) ======
db.exec(`
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNumber TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_from ON ai_messages(fromNumber);
CREATE INDEX IF NOT EXISTS idx_ai_messages_createdAt ON ai_messages(createdAt);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ====== OPENAI ======
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const AI_GLOBAL = (process.env.AI_GLOBAL || "on").trim().toLowerCase(); // on|off
console.log("OpenAI configured:", { hasKey: !!OPENAI_API_KEY, AI_GLOBAL });

// ====== CONFIG ======
const CATALOG = [
  { id: 1, name: "Bot base para WhatsApp", price: 100 },
  { id: 2, name: "Bot base para Instagram", price: 100 },
  { id: 3, name: "Bot unificado base (WhatsApp + Instagram)", price: 175 },
  { id: 4, name: "Combo base con dashboard", price: 250 },
];

const PAYMENT = {
  transfer: {
    alias: (process.env.TRANSFER_ALIAS || "ramamj.macro").trim(),
    titular: process.env.TRANSFER_TITULAR || "",
    banco: process.env.TRANSFER_BANCO || "",
  },
  mpLinks: {
    1: process.env.MP_LINK_1 || "",
    2: process.env.MP_LINK_2 || "",
    3: process.env.MP_LINK_3 || "",
    4: process.env.MP_LINK_4 || "",
  },
};

// ====== ADMIN ======
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
function isAdmin(from) {
  return ADMIN_NUMBER && from === ADMIN_NUMBER;
}

// ====== PROMPT ======
const BABYSTEPSBOTS_INSTRUCTIONS = `
IDENTIDAD
Sos el asistente comercial de Babystepsbots (Tucumán, Argentina). Tu trabajo es ayudar a elegir el producto correcto y cerrar la compra.

ESTILO
- Español Argentina (vos).
- Mensajes cortos (máx 5 líneas).
- Claro y directo.
- 0 a 2 emojis por mensaje.

OBJETIVO
1) Entender necesidad
2) Recomendar opción
3) Cerrar próximo paso (pago / datos / demo)
4) Manejar objeciones (precio/tiempo/resultados)

CATÁLOGO
1) Bot base para WhatsApp — USD $100
2) Bot base para Instagram — USD $100
3) Bot unificado base (WhatsApp + Instagram) — USD $175
4) Combo base con dashboard — USD $250

PAGO
Preferido: MercadoPago link.
Alternativas: transferencia alias ramamj.macro, contraentrega (Tucumán capital, Yerba Buena, Tafí Viejo, Banda del Río Salí).

ENTREGA
Se coordina con el cliente.

REGLAS DURAS
- No inventes precios ni funcionalidades.
- Si falta info, preguntá 1 cosa puntual.
- Si hay enojo/reclamo: derivá a HUMANO.
- Siempre terminá con una pregunta o siguiente paso.

IA
- Lite: responde flexible + objeciones + toma datos básicos.
- Pro: además recuerda mejor el contexto y sigue el hilo.
`;

// ====== TELEGRAM (opcional) ======
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

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
    if (!r.ok || data.ok === false) console.error("Telegram API error:", r.status, data);
  } catch (e) {
    console.error("Telegram notify failed:", e?.message || e);
  }
}

// ====== Twilio outbound notify (opcional) ======
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || "").trim();

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) return false;
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
    return true;
  } catch (e) {
    console.error("Twilio sendWhatsApp failed:", e?.message || e);
    return false;
  }
}

// ====== HELPERS ======
function calcTotal(items) {
  let total = 0;
  for (const id of items) {
    const p = CATALOG.find((x) => x.id === Number(id));
    if (p) total += p.price;
  }
  return total;
}

function formatItems(items) {
  const counts = {};
  for (const id of items) counts[id] = (counts[id] || 0) + 1;

  return Object.entries(counts).map(([id, qty]) => {
    const p = CATALOG.find((x) => x.id === Number(id));
    const unit = p?.price || 0;
    return { id: Number(id), name: p?.name || "UNKNOWN", qty, unit, subtotal: unit * qty };
  });
}

function waLink(fromNumber) {
  const digits = (fromNumber || "").replace("whatsapp:", "").replace("+", "").trim();
  return digits ? `https://wa.me/${digits}` : "";
}

function menuText() {
  return `👋 Hola! Soy tu asistente de Babystepsbots.

Escribí:
• catalogo
• agregar 1
• carrito
• checkout
• humano
• ayuda
• cancelar`;
}

function catalogText() {
  return `🛒 Catálogo:
1) Bot base para WhatsApp — USD $100
2) Bot base para Instagram — USD $100
3) Bot unificado base — USD $175
4) Combo con dashboard — USD $250

Para agregar: agregar 1`;
}

function cartText(session) {
  if (session.cart.length === 0) return "🧺 Tu carrito está vacío. Escribí catalogo.";

  const counts = {};
  let total = 0;

  for (const id of session.cart) counts[id] = (counts[id] || 0) + 1;

  const lines = Object.entries(counts).map(([id, qty]) => {
    const p = CATALOG.find((x) => x.id === Number(id));
    const subtotal = p.price * qty;
    total += subtotal;
    return `• ${p.name} x${qty} — USD $${subtotal}`;
  });

  return `🧾 Carrito:\n${lines.join("\n")}\n\nTotal: USD $${total}`;
}

function newOrderId() {
  return "PED-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function paymentMenuText(orderId) {
  return `💳 Pago (Pedido ${orderId})

Elegí:
• pagar mp
• pagar transferencia

Cuando pagues, mandá: pagado`;
}

function paymentMpText(session) {
  const unique = [...new Set(session.lastOrderItems)];
  if (unique.length === 1) {
    const id = unique[0];
    const link = PAYMENT.mpLinks[id];
    if (link) return `✅ Link MercadoPago:\n${link}\n\nCuando pagues, mandá: pagado`;
    return `No tengo cargado el link de MP para ese producto.\nCargalo en Render y redeploy.`;
  }
  return `Para múltiples ítems, por ahora te paso el link de MP manual.`;
}

function paymentTransferText() {
  const { alias, titular, banco } = PAYMENT.transfer;
  return `🏦 Transferencia
• Alias/CBU: ${alias || "—"}
• Titular: ${titular || "—"}
• Banco: ${banco || "—"}

Cuando transfieras, mandá: pagado (si querés con comprobante).`;
}

function isReserved(text) {
  return [
    "checkout",
    "catalogo",
    "carrito",
    "menu",
    "hola",
    "ayuda",
    "cancelar",
    "confirmar",
    "pago",
    "pagar",
    "pagar mp",
    "pagar transferencia",
    "pagado",
    "testpedido",
    "humano",
    "asesor",
    "hablar con humano",
  ].includes(text);
}

function isHumanTrigger(text) {
  return text === "humano" || text === "asesor" || text === "hablar con humano";
}

// ====== DB: settings (último cliente) ======
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);

function setSetting(key, value) {
  setSettingStmt.run({ key, value: String(value ?? "") });
}
function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row?.value || "";
}
const getCompanyStmt = db.prepare(`
  SELECT * FROM companies WHERE id = ?
`);

function getCompany(companyId) {
  const row = getCompanyStmt.get(companyId);
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    catalog: JSON.parse(row.catalogJson || "[]"),
    rules: JSON.parse(row.rulesJson || "{}"),
  };
}

// ====== DB: sessions ======
const getSessionStmt = db.prepare("SELECT * FROM sessions WHERE fromNumber = ?");
const upsertSessionStmt = db.prepare(`
  INSERT INTO sessions (fromNumber, state, cartJson, dataJson, lastOrderId)
  VALUES (@fromNumber, @state, @cartJson, @dataJson, @lastOrderId)
  ON CONFLICT(fromNumber) DO UPDATE SET
    state=excluded.state,
    cartJson=excluded.cartJson,
    dataJson=excluded.dataJson,
    lastOrderId=excluded.lastOrderId
`);

function getSession(fromNumber) {
  const row = getSessionStmt.get(fromNumber);

  // Defaults (IMPORTANTE: acá viven aiCount/aiCountDate)
  const defaults = {
    name: "",
    contact: "",
    notes: "",
    humanNotified: false,

companyId: "babystepsbots",

    aiMode: "off",            // off|lite|pro
    requestedAiMode: "off",
    lastAiAt: 0,

    aiCountDate: "",
    aiCount: 0,
  };

  if (!row) {
    return {
      fromNumber,
      state: "MENU",
      cart: [],
      data: { ...defaults },
      lastOrderId: null,
      lastOrderItems: [],
    };
  }

  const raw = JSON.parse(row.dataJson || "{}");
  const merged = { ...defaults, ...raw };

  // Normalizar tipos
  merged.humanNotified = !!merged.humanNotified;
  merged.aiMode = String(merged.aiMode || "off").toLowerCase();
  merged.requestedAiMode = String(merged.requestedAiMode || "off").toLowerCase();
  merged.lastAiAt = Number(merged.lastAiAt || 0);
  merged.aiCount = Number(merged.aiCount || 0);
  merged.aiCountDate = String(merged.aiCountDate || "");

  return {
    fromNumber,
    state: row.state || "MENU",
    cart: JSON.parse(row.cartJson || "[]"),
    data: merged,
    lastOrderId: row.lastOrderId || null,
    lastOrderItems: [],
  };
}

function saveSession(session) {
  upsertSessionStmt.run({
    fromNumber: session.fromNumber,
    state: session.state,
    cartJson: JSON.stringify(session.cart || []),
    dataJson: JSON.stringify(session.data || {}),
    lastOrderId: session.lastOrderId || null,
  });
}

// ====== DB: orders ======
const insertOrderStmt = db.prepare(`
  INSERT INTO orders (
    id, createdAt, fromNumber, name, contact, notes,
    itemsJson, itemsDetailedJson, total,
    paymentStatus, paymentMethod,
    orderStatus, deliveredAt
  )
  VALUES (
    @id, @createdAt, @fromNumber, @name, @contact, @notes,
    @itemsJson, @itemsDetailedJson, @total,
    @paymentStatus, @paymentMethod,
    @orderStatus, @deliveredAt
  )
`);

const getOrderByIdStmt = db.prepare("SELECT * FROM orders WHERE id = ?");

const setPaidByAdminStmt = db.prepare(`
  UPDATE orders
  SET paymentStatus='paid',
      paymentMethod='admin',
      orderStatus='paid'
  WHERE id=@id
`);

const setConfirmedByAdminStmt = db.prepare(`
  UPDATE orders
  SET paymentStatus='pending',
      paymentMethod='',
      orderStatus='confirmed'
  WHERE id=@id
`);

const setDeliveredStmt = db.prepare(`
  UPDATE orders
  SET orderStatus='delivered',
      deliveredAt=@deliveredAt
  WHERE id=@id
`);

const setOrderStatusStmt = db.prepare(`
  UPDATE orders
  SET orderStatus=@orderStatus
  WHERE id=@id
`);

const setContactedStmt = db.prepare(`
  UPDATE orders
  SET contactedAt=@contactedAt, contactedBy=@contactedBy
  WHERE id=@id
`);

const setPaymentReportedStmt = db.prepare(`
  UPDATE orders
  SET orderStatus='payment_reported',
      paymentMethod='reported'
  WHERE id=@id
`);

const listLastOrdersStmt = db.prepare(`
  SELECT id, createdAt, fromNumber, total, paymentStatus
  FROM orders
  ORDER BY datetime(createdAt) DESC
  LIMIT ?
`);

const listTodayOrdersStmt = db.prepare(`
  SELECT id, createdAt, fromNumber, total, paymentStatus
  FROM orders
  WHERE datetime(createdAt) >= datetime(@start) AND datetime(createdAt) <= datetime(@end)
  ORDER BY datetime(createdAt) DESC
`);

const listPendingOrdersStmt = db.prepare(`
  SELECT id, createdAt, fromNumber, total, paymentStatus, orderStatus
  FROM orders
  WHERE paymentStatus='pending'
  ORDER BY datetime(createdAt) DESC
  LIMIT ?
`);

const listPaidNotDeliveredStmt = db.prepare(`
  SELECT id, createdAt, fromNumber, total, paymentStatus, orderStatus
  FROM orders
  WHERE paymentStatus='paid' AND (orderStatus IS NULL OR orderStatus != 'delivered')
  ORDER BY datetime(createdAt) DESC
  LIMIT ?
`);

const listDeliveredOrdersStmt = db.prepare(`
  SELECT id, createdAt, fromNumber, total, paymentStatus, orderStatus
  FROM orders
  WHERE orderStatus='delivered'
  ORDER BY datetime(createdAt) DESC
  LIMIT ?
`);

function loadLastOrderItems(session) {
  if (!session.lastOrderId) return;
  const row = getOrderByIdStmt.get(session.lastOrderId);
  if (!row) return;
  session.lastOrderItems = JSON.parse(row.itemsJson || "[]");
}

// ====== MEMORIA IA ======
const insertAiMsgStmt = db.prepare(`
  INSERT INTO ai_messages (fromNumber, role, content, createdAt)
  VALUES (@fromNumber, @role, @content, @createdAt)
`);

const getLastAiMsgsStmt = db.prepare(`
  SELECT role, content
  FROM ai_messages
  WHERE fromNumber = ?
  ORDER BY id DESC
  LIMIT ?
`);

function saveAiMessage(fromNumber, role, content) {
  insertAiMsgStmt.run({
    fromNumber,
    role,
    content: String(content || "").slice(0, 1200),
    createdAt: new Date().toISOString(),
  });
}

function loadAiHistory(fromNumber, limit) {
  const rows = getLastAiMsgsStmt.all(fromNumber, limit).reverse();
  return rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
  }));
}

// ====== IA Reply ======
async function aiReply({ session, from, userText }) {
  if (AI_GLOBAL === "off") return "⚠️ La IA está pausada por el administrador. Escribí: humano";
  if (!openai) return "⚠️ Falta OPENAI_API_KEY. Por ahora usá: menu / catalogo / ayuda.";

  const mode = String(session.data?.aiMode || "off").toLowerCase();
  if (mode !== "lite" && mode !== "pro") return "⚠️ IA apagada para este chat. Escribí: humano";

const company = getCompany(session.data.companyId);

const instructions = `
${company.prompt}

CATÁLOGO:
${company.catalog.map(p => `- ${p.name}: $${p.price}`).join("\n")}

REGLAS:
- Tono: ${company.rules.tone || "neutral"}
- Nunca inventes precios
- Si no sabés algo, preguntá
`;

instructions: instructions,


  // ===== Cupo diario (PRIMERO) =====
  const today = new Date().toISOString().slice(0, 10);
  if (session.data.aiCountDate !== today) {
    session.data.aiCountDate = today;
    session.data.aiCount = 0;
  }

  const AI_LIMIT_LITE = Number(process.env.AI_LIMIT_LITE || 40);
  const AI_LIMIT_PRO = Number(process.env.AI_LIMIT_PRO || 120);
  const dailyLimit = mode === "pro" ? AI_LIMIT_PRO : AI_LIMIT_LITE;

  if (Number(session.data.aiCount || 0) >= dailyLimit) {
    saveSession(session);
    return `Hoy ya se alcanzó el cupo de IA (${dailyLimit}) para este chat. Si querés, pedí un asesor escribiendo: humano`;
  }

  // Anti spam (1 cada 6s) — y CUENTA para el cupo si querés cortar “de verdad”
  const now = Date.now();
  if (now - Number(session.data?.lastAiAt || 0) < 6000) {
    session.data.aiCount = Number(session.data.aiCount || 0) + 1; // ✅ cuenta anti-spam
    saveSession(session);
    return "Dale 🙂 mandame 1 mensaje más completo y te respondo bien: ¿lo querés para WhatsApp, Instagram o ambos?";
  }

  session.data.lastAiAt = now;
  saveSession(session);

  const historyLimit = mode === "pro" ? 14 : 4;

  saveAiMessage(from, "user", userText);
  const history = loadAiHistory(from, historyLimit);

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: BABYSTEPSBOTS_INSTRUCTIONS,
      input: history,
    });

    const answer = (resp.output_text || "").trim() || "Dale, ¿lo querés para WhatsApp, Instagram o ambos?";
    saveAiMessage(from, "assistant", answer);

    // ✅ Suma 1 por respuesta real de IA
    session.data.aiCount = Number(session.data.aiCount || 0) + 1;
    saveSession(session);

    return answer;
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    console.error("AI error:", { status, msg });

    if (status === 401) return "⚠️ IA: clave inválida (401). Revisá OPENAI_API_KEY en Render.";
    if (status === 429) return "⚠️ IA: sin crédito/límite (429). Revisá Billing/Limits en OpenAI API.";
    return "⚠️ Tuve un problema con la IA. Probá de nuevo o escribí: menu";
  }
}

// ====== HEALTH ======
app.get("/", (req, res) => res.send("OK - server running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== WEBHOOK ======
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmd = body.trim().replace(/\s+/g, " ").toLowerCase();

  // Guardar último cliente (para admin ai set sin número)
  if (from && from !== ADMIN_NUMBER && !cmd.startsWith("admin")) {
    setSetting("last_customer", from);
  }

  const session = getSession(from);
  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // ===== HANDOFF HUMANO =====
  if (session.state === "HUMAN" && text !== "menu" && text !== "hola" && !cmd.startsWith("admin")) {
    if (!session.data.humanNotified) {
      session.data.humanNotified = true;
      reply = "✅ Listo. Un asesor te va a responder en breve.";
      sendTelegram(`🙋‍♂️ Solicitud de HUMANO\nCliente: ${from}\nMensaje: ${body}`);
    } else {
      reply = "✅ Un asesor ya fue notificado.";
    }
    saveSession(session);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;

    const extra = session.lastOrderId ? `\nÚltimo pedido: ${session.lastOrderId}` : "";
    sendTelegram(`🙋‍♂️ Solicitud de HUMANO\nCliente: ${from}${extra}\nMensaje: ${body}`);

    reply = "✅ Listo. Un asesor te va a responder en breve.";
    saveSession(session);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== ADMIN =====
  if (cmd.startsWith("admin")) {
    if (!isAdmin(from)) {
      reply = "⛔ Comando restringido.";
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    if (cmd === "admin whoami") {
      reply = `ADMIN From detectado: ${from}`;
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // admin ai set off|lite|pro [whatsapp:+...]
    const aiSet = cmd.match(/^admin ai set (off|lite|pro)(?:\s+(.+))?$/i);
    if (aiSet) {
      const mode = aiSet[1].toLowerCase();
      let target = (aiSet[2] || "").trim();

      if (!target) target = getSetting("last_customer");
      if (!target) {
        reply = "No tengo 'último cliente' todavía. Hacé que un cliente mande un mensaje primero.";
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(reply);
        return res.type("text/xml").send(twiml.toString());
      }

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      const s2 = getSession(target);
      s2.data.aiMode = mode;
      saveSession(s2);

      reply = `🤖 IA para ${target}: ${mode.toUpperCase()} ✅`;
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // admin ai status [whatsapp:+...]
    const aiStatus = cmd.match(/^admin ai status(?:\s+(.+))?$/i);
    if (aiStatus) {
      let target = (aiStatus[1] || "").trim();
      if (!target) target = getSetting("last_customer");

      if (!target) {
        reply = "No tengo 'último cliente' todavía. Hacé que un cliente mande un mensaje primero.";
      } else {
        if (!target.startsWith("whatsapp:")) {
          if (target.startsWith("+")) target = `whatsapp:${target}`;
          else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
        }
        const s2 = getSession(target);
        reply = `🤖 IA para ${target}: ${(s2.data.aiMode || "off").toUpperCase()}`;
      }

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    if (cmd === "admin" || cmd === "admin ayuda") {
      reply = `🛠 Admin:
• admin whoami
• admin ai set off|lite|pro [whatsapp:+54...]
• admin ai status [whatsapp:+54...]
• admin pedidos
• admin pedido PED-XXXXXX
• admin hoy
• admin telegram
• admin pendientes
• admin pagados
• admin entregados
• admin status PED-XXXXXX confirmed|paid|delivered
• admin auto whatsapp:+54...`;
    }

    if (cmd === "admin pedidos") {
      const rows = listLastOrdersStmt.all(5);
      if (!rows.length) reply = "No hay pedidos todavía.";
      else {
        const lines = rows.map(
          (r) => `• ${r.id} — ${r.paymentStatus} — USD $${r.total} — ${r.fromNumber} — ${r.createdAt}`
        );
        reply = `📦 Últimos pedidos:\n${lines.join("\n")}\n\nUsá: admin pedido PED-XXXXXX`;
      }
    }

    const m = cmd.match(/^admin pedido (ped-[a-z0-9]+)$/i);
    if (m) {
      const orderId = m[1].toUpperCase();
      const row = getOrderByIdStmt.get(orderId);
      if (!row) reply = `No encontré el pedido ${orderId}`;
      else {
        const items = JSON.parse(row.itemsDetailedJson || "[]");
        const itemsText = items.map((i) => `- ${i.name} x${i.qty} (USD $${i.subtotal})`).join("\n");
        reply =
          `🧾 Pedido ${row.id}\n` +
          `Fecha: ${row.createdAt}\n` +
          `Cliente: ${row.fromNumber}\n` +
          `Nombre: ${row.name || "—"}\n` +
          `Contacto: ${row.contact || "—"}\n` +
          `Notas: ${row.notes || "—"}\n` +
          `Estado pago: ${row.paymentStatus}\n` +
          `Status: ${row.orderStatus || "confirmed"}\n` +
          `Entregado: ${row.deliveredAt ? "✅ " + row.deliveredAt : "❌ no"}\n` +
          `Total: USD $${row.total}\n\n` +
          `Items:\n${itemsText || "—"}`;
      }
    }

    if (cmd === "admin pendientes") {
      const rows = listPendingOrdersStmt.all(10);
      reply = !rows.length
        ? "✅ No hay pendientes de pago."
        : `⏳ Pendientes de pago:\n${rows.map((r) => `• ${r.id} — USD $${r.total} — ${r.fromNumber}`).join("\n")}`;
    }

    if (cmd === "admin pagados") {
      const rows = listPaidNotDeliveredStmt.all(10);
      reply = !rows.length
        ? "✅ No hay pagados pendientes de entrega."
        : `💰 Pagados (sin entregar):\n${rows.map((r) => `• ${r.id} — USD $${r.total} — ${r.fromNumber}`).join("\n")}`;
    }

    if (cmd === "admin entregados") {
      const rows = listDeliveredOrdersStmt.all(10);
      reply = !rows.length
        ? "📭 No hay entregados todavía."
        : `📦 Entregados:\n${rows.map((r) => `• ${r.id} — USD $${r.total} — ${r.fromNumber}`).join("\n")}`;
    }

    if (cmd === "admin hoy") {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();
      const rows = listTodayOrdersStmt.all({ start, end });

      reply = !rows.length
        ? "📭 No hay pedidos hoy."
        : `📅 Pedidos de hoy:\n${rows.map((r) => `• ${r.id} — ${r.paymentStatus} — USD $${r.total} — ${r.fromNumber}`).join("\n")}`;
    }

    if (cmd === "admin telegram") {
      sendTelegram("✅ Test Telegram OK (enviado desde WhatsApp bot)");
      reply = "Listo ✅ mandé un test a Telegram.";
    }

    const s = cmd.match(/^admin status (ped-[a-z0-9]+) (confirmed|paid|delivered)$/i);
    if (s) {
      const orderId = s[1].toUpperCase();
      const status = s[2].toLowerCase();
      const row = getOrderByIdStmt.get(orderId);

      if (!row) reply = `No encontré el pedido ${orderId}`;
      else {
        if (status === "delivered") {
          setDeliveredStmt.run({ id: orderId, deliveredAt: new Date().toISOString() });
          reply = `✅ Marcado como ENTREGADO: ${orderId}`;
          sendTelegram(`📦 Pedido ENTREGADO\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);
          sendWhatsApp(row.fromNumber, `📦 ¡Listo! Tu pedido ${orderId} fue marcado como ENTREGADO. Gracias 🙌`);
        } else if (status === "paid") {
          setPaidByAdminStmt.run({ id: orderId });
          reply = `✅ Marcado como PAGADO: ${orderId}`;
          sendTelegram(`💰 Pedido PAGADO\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);
          sendWhatsApp(row.fromNumber, `✅ Pago verificado para tu pedido ${orderId}. En breve coordinamos la entrega.`);
        } else if (status === "confirmed") {
          setConfirmedByAdminStmt.run({ id: orderId });
          reply = `✅ Marcado como CONFIRMADO: ${orderId}`;
          sendTelegram(`🧾 Pedido CONFIRMADO (admin)\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);
        } else {
          setOrderStatusStmt.run({ orderStatus: status, id: orderId });
          reply = `✅ Status actualizado (${status}): ${orderId}`;
        }
      }
    }

    const a = cmd.match(/^admin auto (whatsapp:\+\d+)$/i);
    if (a) {
      const target = a[1];
      const s2 = getSession(target);
      s2.state = "MENU";
      s2.data.humanNotified = false;
      saveSession(s2);
      reply = `✅ Volví a modo automático a: ${target}`;
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== IA (solo MENU y no reservado) =====
  if ((session.data.aiMode === "lite" || session.data.aiMode === "pro") && session.state === "MENU" && !isReserved(text)) {
    reply = await aiReply({ session, from, userText: body });
    saveSession(session);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== MENU / HOLA =====
  if (text === "hola" || text === "menu") {
    session.state = "MENU";
    session.data.humanNotified = false;
    reply = menuText();
  }

  // ===== CANCELAR =====
  if (text === "cancelar") {
    session.state = "MENU";
    session.cart = [];
    // IMPORTANTE: no borrar aiCount/aiMode
    session.data = {
      ...session.data,
      name: "",
      contact: "",
      notes: "",
      humanNotified: false,
      requestedAiMode: "off",
    };
    session.lastOrderId = null;
    reply = "🧹 Listo, reinicié todo.\n\n" + menuText();
  }

  // ===== AYUDA / CATALOGO / CARRITO =====
  if (text === "ayuda") reply = "Flujo: catalogo → agregar 1 → carrito → checkout → confirmar → pago";
  if (text === "catalogo") reply = catalogText();
  if (text === "carrito") reply = cartText(session);

  // ===== AGREGAR =====
  const addMatch = text.match(/^agregar\s+(\d+)$/);
  if (addMatch) {
    const id = Number(addMatch[1]);
    const p = CATALOG.find((x) => x.id === id);
    if (!p) reply = "Ese producto no existe. Escribí catalogo y elegí 1, 2, 3 o 4.";
    else {
      session.cart.push(id);
      reply = `✅ Agregado: ${p.name}\n\n${cartText(session)}\n\nPara finalizar: checkout`;
    }
  }

  // ===== CHECKOUT =====
  if (text === "checkout") {
    if (session.cart.length === 0) reply = "Tu carrito está vacío. Escribí catalogo.";
    else {
      session.state = "ASK_NAME";
      reply = `Perfecto ✅\n\n${cartText(session)}\n\n¿A nombre de quién va el pedido?`;
    }
  }

  // ===== DATOS =====
  if (session.state === "ASK_NAME" && !isReserved(text)) {
    session.data.name = body;
    session.state = "ASK_CONTACT";
    reply = "Genial. Pasame un contacto (email o WhatsApp alternativo).";
  } else if (session.state === "ASK_CONTACT" && !isReserved(text)) {
    session.data.contact = body;
    session.state = "ASK_NOTES";
    reply = "¿Qué querés que haga el bot? (ventas, FAQs, turnos, etc). Si no, escribí: no";
  } else if (session.state === "ASK_NOTES" && !isReserved(text)) {
    session.data.notes = text === "no" ? "" : body;
    session.state = "ASK_AI_MODE";
    reply = "¿Querés IA? Respondé una opción: no / lite / pro";
  } else if (session.state === "ASK_AI_MODE" && !isReserved(text)) {
    const v = text.trim();
    if (v !== "no" && v !== "lite" && v !== "pro") {
      reply = "Decime una opción exacta: no / lite / pro";
    } else {
      session.data.requestedAiMode = v;
      session.state = "READY";
      reply =
        `✅ Resumen del pedido\n\n${cartText(session)}\n\n` +
        `👤 Nombre: ${session.data.name}\n` +
        `📩 Contacto: ${session.data.contact}\n` +
        `📝 Notas: ${session.data.notes || "—"}\n` +
        `🤖 IA solicitada: ${session.data.requestedAiMode.toUpperCase()}\n\n` +
        `Para confirmar: confirmar\nPara cancelar: cancelar`;
    }
  }

  // ===== CONFIRMAR =====
  if (text === "confirmar") {
    if (session.cart.length === 0) {
      reply = "No hay carrito activo. Escribí catalogo.";
    } else if (session.state !== "READY") {
      reply = "Todavía falta completar el checkout. Escribí: checkout";
    } else {
      const orderId = newOrderId();
      const createdAt = new Date().toISOString();
      const items = [...session.cart];
      const itemsDetailed = formatItems(items);
      const total = calcTotal(items);
      const link = waLink(from);

      insertOrderStmt.run({
        id: orderId,
        createdAt,
        fromNumber: from,
        name: session.data.name || "",
        contact: session.data.contact || "",
        notes: session.data.notes || "",
        itemsJson: JSON.stringify(items),
        itemsDetailedJson: JSON.stringify(itemsDetailed),
        total,
        paymentStatus: "pending",
        paymentMethod: "",
        orderStatus: "confirmed",
        deliveredAt: null,
      });

      sendTelegram(
        `🛎️ Nuevo pedido ${orderId}\n` +
          `Total: USD $${total}\n` +
          `Cliente: ${from}\n` +
          (link ? `Contactar: ${link}\n` : "") +
          `Nombre: ${session.data.name || "—"}\n` +
          `Contacto: ${session.data.contact || "—"}\n` +
          `IA solicitada: ${(session.data.requestedAiMode || "off").toUpperCase()}\n` +
          `Notas: ${session.data.notes || "—"}\n` +
          `Items:\n` +
          itemsDetailed.map((i) => `- ${i.name} x${i.qty} (USD $${i.subtotal})`).join("\n")
      );

      session.lastOrderId = orderId;
      session.state = "MENU";
      session.cart = [];
      // NO BORRAR aiCount/aiMode
      session.data = {
        ...session.data,
        name: "",
        contact: "",
        notes: "",
        humanNotified: false,
        requestedAiMode: "off",
      };

      reply = `🎉 Pedido confirmado: *${orderId}*\n\nPara pagar escribí: pago`;
    }
  }

  // ===== PAGO =====
  if (text === "pago" || text === "pagar") {
    if (!session.lastOrderId) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else reply = paymentMenuText(session.lastOrderId);
  }

  if (text === "pagar transferencia") {
    if (!session.lastOrderId) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else reply = paymentTransferText();
  }

  if (text === "pagar mp") {
    if (!session.lastOrderId) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else {
      loadLastOrderItems(session);
      reply = paymentMpText(session);
    }
  }

  // ===== PAGADO (reporta) =====
  if (text === "pagado") {
    if (!session.lastOrderId) {
      reply = "Perfecto ✅ ¿De qué pedido? (no veo uno reciente).";
    } else {
      setPaymentReportedStmt.run({ id: session.lastOrderId });
      const row = getOrderByIdStmt.get(session.lastOrderId);

      sendTelegram(
        `🧾 Cliente REPORTÓ PAGO (sin verificar)\nPedido: ${session.lastOrderId}\nCliente: ${from}\nTotal: USD $${row?.total ?? "?"}\nContactar: ${waLink(from)}`
      );

      reply =
        `✅ Recibido. Tomé tu aviso de pago del pedido *${session.lastOrderId}*.\n` +
        `Ahora verificamos el pago y te confirmamos.\n\n` +
        `Si querés, mandá el comprobante por acá.`;
    }
  }

  saveSession(session);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  return res.type("text/xml").send(twiml.toString());
});

app.listen(process.env.PORT || 3000, () => console.log("Listening on http://localhost:3000"));
