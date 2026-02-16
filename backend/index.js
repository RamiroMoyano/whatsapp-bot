import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db } from "./db.js";
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

// ================= MIGRATIONS =================
db.exec(`
CREATE TABLE IF NOT EXISTS customer_company (
  fromNumber TEXT PRIMARY KEY,
  companyId TEXT NOT NULL,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNumber TEXT,
  role TEXT,
  content TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  prompt TEXT,
  catalogJson TEXT,
  rulesJson TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT,
  cartJson TEXT,
  dataJson TEXT,
  lastOrderId TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TEXT,
  fromNumber TEXT,
  companyId TEXT,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT,
  itemsDetailedJson TEXT,
  total REAL,
  paymentStatus TEXT,
  paymentMethod TEXT,
  orderStatus TEXT,
  deliveredAt TEXT
);
`);

// ================= DEFAULT COMPANIES =================
db.exec(`
INSERT OR IGNORE INTO companies VALUES
(
  'babystepsbots',
  'Babystepsbots',
  'Sos el asistente comercial de Babystepsbots. Español Argentina, claro, directo, vendedor.',
  '[{"id":1,"name":"Bot WhatsApp","price":120},{"id":2,"name":"Bot Instagram","price":100},{"id":3,"name":"Bot Unificado","price":200}]',
  '{"tone":"comercial","allowHuman":true}',
  CURRENT_TIMESTAMP
),
(
  'veterinaria_sm',
  'Veterinaria San Miguel',
  'Sos asistente de una veterinaria. Empático, calmado, priorizás urgencias.',
  '[{"id":1,"name":"Consulta","price":5000},{"id":2,"name":"Vacunación","price":8000}]',
  '{"tone":"empatico","emergencyKeywords":["urgente","accidente"],"allowHuman":true}',
  CURRENT_TIMESTAMP
);
`);

// ================= OPENAI =================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_GLOBAL = (process.env.AI_GLOBAL || "on").trim().toLowerCase();

// ================= ADMIN =================
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
const isAdmin = (from) => ADMIN_NUMBER && from === ADMIN_NUMBER;

// ================= DB HELPERS =================
const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value || "";
const setSetting = (k, v) =>
  db.prepare(`
    INSERT INTO settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(k, String(v ?? ""));

const getCompany = (id) => {
  const r = db.prepare(`SELECT * FROM companies WHERE id=?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    catalog: JSON.parse(r.catalogJson || "[]"),
    rules: JSON.parse(r.rulesJson || "{}"),
  };
};

function getCompanySafe(session) {
  const fallback = getCompany("babystepsbots");
  const id = String(session?.data?.companyId || "babystepsbots").toLowerCase();
  return getCompany(id) || fallback;
}

// ================= SESSION =================
function getSession(from) {
  const r = db.prepare(`SELECT * FROM sessions WHERE fromNumber=?`).get(from);

  const base = {
    companyId: "babystepsbots",
    aiMode: "off",
    aiCount: 0,
    aiCountDate: "",
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

function saveSession(s) {
  db.prepare(`
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
const menuText = (c) => `👋 Hola! Soy el asistente de ${c.name}
• catalogo
• carrito
• checkout
• humano`;

const catalogText = (c) =>
  `🛒 ${c.name}\n` +
  (c.catalog || []).map((p) => `${p.id}) ${p.name} — $${p.price}`).join("\n");

const cartText = (s) => {
  const c = getCompanySafe(s);
  if (!s.cart.length) return "🧺 Carrito vacío.";
  let total = 0;
  const out = {};
  s.cart.forEach((id) => (out[id] = (out[id] || 0) + 1));
  const lines = Object.entries(out).map(([id, q]) => {
    const p = (c.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = Number(p?.price || 0);
    const sub = unit * q;
    total += sub;
    return `• ${p?.name || "Producto"} x${q} — $${sub}`;
  });
  return `🧾 ${c.name}\n${lines.join("\n")}\nTotal: $${total}`;
};

// ================= AI =================
async function aiReply(session, from, text) {
  if (!openai || AI_GLOBAL === "off") return "IA no disponible.";
  if (!["lite", "pro"].includes(String(session.data.aiMode || "").toLowerCase())) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (session.data.aiCountDate !== today) {
    session.data.aiCountDate = today;
    session.data.aiCount = 0;
  }

  const limit = String(session.data.aiMode).toLowerCase() === "pro" ? 120 : 40;
  if (Number(session.data.aiCount || 0) >= limit) return "⚠️ Límite diario de IA alcanzado. Escribí humano.";

  const c = getCompanySafe(session);
  const prompt = `
${c.prompt || ""}

CATÁLOGO:
${(c.catalog || []).map((p) => `${p.id}) ${p.name}: $${p.price}`).join("\n")}

Reglas:
- Tono: ${(c.rules || {}).tone || "neutral"}
- No inventar datos
- Siempre cerrar con pregunta
`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "user", content: text }],
    instructions: prompt,
  });

  session.data.aiCount = Number(session.data.aiCount || 0) + 1;
  saveSession(session);

  return (resp.output_text || "").trim();
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

function normalizePlanTierFromText(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("pro")) return "PRO";
  if (raw.includes("lite")) return "LITE";
  if (raw.includes("basic") || raw.includes("basico") || raw.includes("sin ai")) return "BASICO";
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

function formatCatalogChoices(catalogItems) {
  if (!catalogItems.length) return "Sin opciones de catalogo.";
  return catalogItems
    .map((item) => `- ${item.id ? `${item.id}) ` : ""}${item.name}`)
    .join("\n");
}

// ================== FIN PARTE 1: PEGAR PARTE 2 DESDE AQUÍ ==================
// ===== API: Companies =====
app.get("/api/companies", requireApiAuth, (req, res) => {
  const rows = db.prepare(`SELECT id,name,createdAt,prompt,catalogJson,rulesJson FROM companies ORDER BY id`).all();
  res.json(rows);
});

app.get("/api/companies/:id", requireApiAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM companies WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

app.post("/api/companies", requireApiAuth, (req, res) => {
  const id = String(req.body.id || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  if (!id.match(/^[a-z0-9_-]{3,40}$/)) return res.status(400).json({ error: "ID inválido" });

  db.prepare(`
    INSERT OR IGNORE INTO companies(id,name,prompt,catalogJson,rulesJson,createdAt)
    VALUES(?,?,?,?,?,?)
  `).run(
    id,
    name || id,
    "Sos el asistente de la empresa. Respondés acorde al manual de marca.",
    "[]",
    JSON.stringify({ tone: "neutral", allowHuman: true }),
    new Date().toISOString()
  );

  res.json({ ok: true, id });
});

app.post("/api/companies/:id/save", requireApiAuth, (req, res) => {
  const id = req.params.id;
  const name = String(req.body.name || "").trim();
  const prompt = String(req.body.prompt || "");
  const catalogJson = String(req.body.catalogJson || "[]");
  const rulesJson = String(req.body.rulesJson || "{}");

  try { const c = JSON.parse(catalogJson); if (!Array.isArray(c)) throw new Error("catalogJson debe ser un array"); }
  catch (e) { return res.status(400).json({ error: `Catalog JSON inválido: ${e.message}` }); }

  try { const r = JSON.parse(rulesJson); if (!r || Array.isArray(r) || typeof r !== "object") throw new Error("rulesJson debe ser un objeto"); }
  catch (e) { return res.status(400).json({ error: `Rules JSON inválido: ${e.message}` }); }

  db.prepare(`UPDATE companies SET name=?, prompt=?, catalogJson=?, rulesJson=? WHERE id=?`).run(
    name || id, prompt, catalogJson, rulesJson, id
  );

  res.json({ ok: true });
});

app.post("/api/companies/:id/delete", requireApiAuth, (req, res) => {
  db.prepare(`DELETE FROM companies WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ===== API: Assignments =====
app.get("/api/assignments", requireApiAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT fromNumber, companyId, updatedAt
    FROM customer_company
    ORDER BY datetime(updatedAt) DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

app.post("/api/assignments", requireApiAuth, (req, res) => {
  let fromNumber = String(req.body.fromNumber || "").trim();
  const companyId = String(req.body.companyId || "").trim();

  if (!fromNumber.startsWith("whatsapp:")) {
    if (fromNumber.startsWith("+")) fromNumber = `whatsapp:${fromNumber}`;
    else if (fromNumber.match(/^\d+$/)) fromNumber = `whatsapp:+${fromNumber}`;
  }

  const exists = db.prepare(`SELECT id FROM companies WHERE id=?`).get(companyId);
  if (!exists) return res.status(400).json({ error: "Empresa no existe" });

  db.prepare(`
    INSERT INTO customer_company(fromNumber, companyId, updatedAt)
    VALUES(?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      companyId=excluded.companyId,
      updatedAt=excluded.updatedAt
  `).run(fromNumber, companyId, new Date().toISOString());

  const s = db.prepare(`SELECT dataJson FROM sessions WHERE fromNumber=?`).get(fromNumber);
  if (s) {
    const data = JSON.parse(s.dataJson || "{}");
    data.companyId = companyId;
    db.prepare(`UPDATE sessions SET dataJson=? WHERE fromNumber=?`).run(JSON.stringify(data), fromNumber);
  }

  res.json({ ok: true });
});

app.post("/api/assignments/delete", requireApiAuth, (req, res) => {
  const fromNumber = String(req.body.fromNumber || "").trim();
  db.prepare(`DELETE FROM customer_company WHERE fromNumber=?`).run(fromNumber);
  res.json({ ok: true });
});

// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmdRaw = body.replace(/\s+/g, " ").trim();
  const cmd = cmdRaw.toLowerCase();

  // Guardar último cliente (para admin sin número)
  if (from && !cmd.startsWith("admin")) setSetting("last_customer", from);

  const session = getSession(from);

  // ✅ imponer empresa asignada por dashboard (customer_company)
  const map = db.prepare(`SELECT companyId FROM customer_company WHERE fromNumber=?`).get(from);
  if (map?.companyId) {
    session.data.companyId = map.companyId;
    saveSession(session);
  }

  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // ================= HUMANO =================
  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;
    saveSession(session);

    await sendTelegram(
      `🙋‍♂️ HUMANO SOLICITADO\n` +
      `Empresa: ${getCompanySafe(session).name}\n` +
      `Cliente: ${from}\n` +
      `Mensaje: ${body}`
    );

    return respond(
      res,
      "✅ Listo. Un asesor fue notificado y te va a responder en breve.\n\nMientras tanto podés escribir *menu* para volver al bot."
    );
  }

  // ===== SALIR DE HUMANO CON MENU / HOLA =====
  if (session.state === "HUMAN" && (text === "menu" || text === "hola")) {
    session.state = "MENU";
    session.data.humanNotified = false;
    saveSession(session);
    return respond(res, menuText(getCompanySafe(session)));
  }

  // ===== BLOQUEO HUMANO (solo si NO pidió menu/hola) =====
  if (session.state === "HUMAN" && !cmd.startsWith("admin")) {
    return respond(res, "⏳ Un asesor ya fue notificado. Escribí *menu* para volver.");
  }

  // ================= ADMIN =================
  if (cmd.startsWith("admin")) {
    if (!isAdmin(from)) return respond(res, "⛔ Comando restringido.");

    if (cmd === "admin whoami") return respond(res, `ADMIN OK: ${from}`);

    if (cmd === "admin company list") {
      const rows = db.prepare(`SELECT id,name FROM companies ORDER BY id`).all();
      return respond(
        res,
        rows.length ? "📋 Empresas:\n" + rows.map(r => `• ${r.id} — ${r.name}`).join("\n") : "No hay empresas."
      );
    }

    // admin company set <companyId> [whatsapp:+...]
    const companySet = cmd.match(/^admin company set ([a-z0-9_-]+)(?:\s+(.+))?$/i);
    if (companySet) {
      const companyId = companySet[1].toLowerCase();
      let target = (companySet[2] || "").trim();

      const row = db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      if (!target) target = getSetting("last_customer");
      if (!target) return respond(res, "No tengo 'último cliente' todavía. Hacé que un cliente mande un mensaje primero.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      // ✅ guardar asignación persistente
      db.prepare(`
        INSERT INTO customer_company(fromNumber, companyId, updatedAt)
        VALUES(?,?,?)
        ON CONFLICT(fromNumber) DO UPDATE SET
          companyId=excluded.companyId,
          updatedAt=excluded.updatedAt
      `).run(target, companyId, new Date().toISOString());

      // opcional: también session
      const s2 = getSession(target);
      s2.data.companyId = companyId;
      saveSession(s2);

      return respond(res, `🏢 Empresa para ${target}: ${row.id} (${row.name}) ✅`);
    }

    // admin bot list <companyId>
    const botList = cmd.match(/^admin bot list ([a-z0-9_-]+)$/i);
    if (botList) {
      const companyId = botList[1].toLowerCase();
      const row = db.prepare(`SELECT id,name,catalogJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const catalogRaw = parseJsonSafe(row.catalogJson || "[]", []);
      const catalog = Array.isArray(catalogRaw)
        ? catalogRaw.map((item, idx) => ({
            id: String(item?.id ?? ""),
            name: String(item?.name || item?.title || `Producto ${idx + 1}`).trim(),
          })).filter((item) => item.name)
        : [];

      return respond(
        res,
        `🤖 Catalogo de bots (${row.id}):\n${formatCatalogChoices(catalog)}\n\nUso: admin bot set ${row.id} <id o nombre>`
      );
    }

    // admin bot status <companyId>
    const botStatus = cmd.match(/^admin bot status ([a-z0-9_-]+)$/i);
    if (botStatus) {
      const companyId = botStatus[1].toLowerCase();
      const row = db.prepare(`SELECT id,name,rulesJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const rulesRaw = parseJsonSafe(row.rulesJson || "{}", {});
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
      const botClass = String(rules.botClass || "").trim() || "Sin definir";
      const planTier = String(rules.planTier || "").trim() || "Sin definir";
      const channelMode = String(rules.channelMode || "").trim() || "Sin definir";
      const botCatalogId = String(rules.botCatalogId || "").trim() || "-";

      return respond(
        res,
        `📌 Bot empresa ${row.id}\nClase: ${botClass}\nPlan: ${planTier}\nCanal: ${channelMode}\nCatalogo ID: ${botCatalogId}`
      );
    }

    // admin bot set <companyId> <catalog-id o nombre>
    const botSet = cmdRaw.match(/^admin bot set ([a-z0-9_-]+)\s+(.+)$/i);
    if (botSet) {
      const companyId = String(botSet[1] || "").toLowerCase().trim();
      const botQueryRaw = String(botSet[2] || "").trim();
      const botQuery = botQueryRaw.toLowerCase();

      const row = db.prepare(`SELECT id,name,catalogJson,rulesJson FROM companies WHERE id=?`).get(companyId);
      if (!row) return respond(res, `No existe la empresa '${companyId}'.`);

      const catalogRaw = parseJsonSafe(row.catalogJson || "[]", []);
      const catalog = Array.isArray(catalogRaw)
        ? catalogRaw.map((item, idx) => ({
            id: String(item?.id ?? "").trim(),
            idLower: String(item?.id ?? "").trim().toLowerCase(),
            name: String(item?.name || item?.title || `Producto ${idx + 1}`).trim(),
            nameLower: String(item?.name || item?.title || `Producto ${idx + 1}`).trim().toLowerCase(),
          })).filter((item) => item.name)
        : [];
      if (!catalog.length) return respond(res, `La empresa ${row.id} no tiene productos en catalogo.`);

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
      const rules = rulesRaw && typeof rulesRaw === "object" ? rulesRaw : {};
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

      db.prepare(`UPDATE companies SET rulesJson=? WHERE id=?`).run(JSON.stringify(rules), row.id);

      return respond(
        res,
        `✅ Bot actualizado para ${row.id}\nClase: ${selected.name}\nPlan: ${rules.planTier || "-"}\nCanal: ${rules.channelMode || "-"}`
      );
    }

    // admin ai set off|lite|pro [numero]
    const mAi = cmd.match(/^admin ai set (off|lite|pro)(?:\s+(.+))?$/i);
    if (mAi) {
      let target = (mAi[2] || "").trim() || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      const s2 = getSession(target);
      s2.data.aiMode = mAi[1].toLowerCase();
      saveSession(s2);
      return respond(res, `🤖 IA ${mAi[1].toUpperCase()} para ${target}`);
    }

    // admin ai status
    const mStatus = cmd.match(/^admin ai status(?:\s+(.+))?$/i);
    if (mStatus) {
      let target = (mStatus[1] || "").trim() || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");

      if (!target.startsWith("whatsapp:")) {
        if (target.startsWith("+")) target = `whatsapp:${target}`;
        else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
      }

      const s2 = getSession(target);
      return respond(res, `🤖 IA: ${(s2.data.aiMode || "off").toUpperCase()}`);
    }

    return respond(res, "Admin OK");
  }

  // ================= MENU / CATALOGO / CARRITO / AGREGAR =================
  if (text === "menu" || text === "hola") {
    session.state = "MENU";
    session.data.humanNotified = false;
    saveSession(session);
    return respond(res, menuText(getCompanySafe(session)));
  }

  if (text === "catalogo") return respond(res, catalogText(getCompanySafe(session)));
  if (text === "carrito") return respond(res, cartText(session));

  const mAdd = text.match(/^agregar\s+(\d+)$/);
  if (mAdd) {
    const id = Number(mAdd[1]);
    const company = getCompanySafe(session);
    const p = (company.catalog || []).find((x) => Number(x.id) === id);
    if (!p) return respond(res, "Ese producto no existe. Escribí catalogo y elegí una opción válida.");
    session.cart.push(id);
    saveSession(session);
    return respond(res, `✅ Agregado ${p.name}\n\n${cartText(session)}\n\nPara finalizar: checkout`);
  }

  // ================= IA =================
  if (["lite","pro"].includes(String(session.data.aiMode || "").toLowerCase()) && session.state === "MENU" && !isReserved(text)) {
    const ai = await aiReply(session, from, body);
    if (ai) return respond(res, ai);
  }

  // ================= CHECKOUT =================
  if (text === "checkout") {
    if (!session.cart.length) return respond(res, "Carrito vacío.");
    session.state = "ASK_NAME";
    saveSession(session);
    return respond(res, "¿A nombre de quién va el pedido?");
  }

  if (session.state === "ASK_NAME" && !isReserved(text)) {
    session.data.name = body;
    session.state = "ASK_CONTACT";
    saveSession(session);
    return respond(res, "Pasame un contacto.");
  }

  if (session.state === "ASK_CONTACT" && !isReserved(text)) {
    session.data.contact = body;
    session.state = "READY";
    saveSession(session);
    return respond(res, `Resumen:\n${cartText(session)}\nConfirmar: confirmar`);
  }

  // ================= CONFIRMAR =================
  if (text === "confirmar" && session.state === "READY") {
    const company = getCompanySafe(session);
    const items = [...session.cart];

    let total = 0;
    const detailed = {};
    items.forEach((id) => (detailed[id] = (detailed[id] || 0) + 1));

    const itemsDetailed = Object.entries(detailed).map(([id, q]) => {
      const p = (company.catalog || []).find((x) => Number(x.id) === Number(id));
      const unit = Number(p?.price || 0);
      const sub = unit * q;
      total += sub;
      return { id: Number(id), name: p?.name || "Producto", qty: q, unit, subtotal: sub };
    });

    const orderId = newOrderId();
    db.prepare(`INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      orderId,
      new Date().toISOString(),
      from,
      company.id,
      session.data.name || "",
      session.data.contact || "",
      "",
      JSON.stringify(items),
      JSON.stringify(itemsDetailed),
      total,
      "pending",
      "",
      "confirmed",
      null
    );

    session.cart = [];
    session.state = "MENU";
    session.lastOrderId = orderId;
    saveSession(session);

    return respond(res, `🎉 Pedido ${orderId} confirmado.\nTotal: $${total}`);
  }

  // ================= DEFAULT =================
  saveSession(session);
  return respond(res, reply);
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

app.listen(process.env.PORT || 3000, () => console.log("🚀 Bot corriendo"));
