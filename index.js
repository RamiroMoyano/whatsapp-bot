import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import OpenAI from "openai";
import { db } from "./db.js";

dotenv.config();

console.log("BOOT VERSION:", "2026-01-27-INDEX-V4");
console.log("BOOT FILE:", import.meta.url);
console.log("PWD:", process.cwd());

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================= MIGRATIONS =================
db.exec(`
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
  '{"tone":"empatico","emergencyKeywords":["urgente","accidente"]}',
  CURRENT_TIMESTAMP
);
`);

// ================= OPENAI =================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_GLOBAL = (process.env.AI_GLOBAL || "on").toLowerCase();

// ================= ADMIN =================
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
const isAdmin = (from) => from === ADMIN_NUMBER;

// ================= DB HELPERS =================
const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value;
const setSetting = (k, v) =>
  db.prepare(`
    INSERT INTO settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(k, String(v));

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

const getCompanySafe = (session) =>
  getCompany(session.data.companyId || "babystepsbots") || getCompany("babystepsbots");

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

  if (!r)
    return { fromNumber: from, state: "MENU", cart: [], data: base, lastOrderId: null };

  return {
    fromNumber: from,
    state: r.state,
    cart: JSON.parse(r.cartJson || "[]"),
    data: { ...base, ...JSON.parse(r.dataJson || "{}") },
    lastOrderId: r.lastOrderId,
  };
}

function saveSession(s) {
  db.prepare(`
    INSERT INTO sessions VALUES (?,?,?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      state=excluded.state,
      cartJson=excluded.cartJson,
      dataJson=excluded.dataJson,
      lastOrderId=excluded.lastOrderId
  `).run(
    s.fromNumber,
    s.state,
    JSON.stringify(s.cart),
    JSON.stringify(s.data),
    s.lastOrderId
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
  c.catalog.map((p) => `${p.id}) ${p.name} — $${p.price}`).join("\n");

const cartText = (s) => {
  const c = getCompanySafe(s);
  if (!s.cart.length) return "🧺 Carrito vacío.";
  let total = 0;
  const out = {};
  s.cart.forEach((id) => (out[id] = (out[id] || 0) + 1));
  const lines = Object.entries(out).map(([id, q]) => {
    const p = c.catalog.find((x) => x.id == id);
    const sub = p.price * q;
    total += sub;
    return `• ${p.name} x${q} — $${sub}`;
  });
  return `🧾 ${c.name}\n${lines.join("\n")}\nTotal: $${total}`;
}

// ================= AI =================
async function aiReply(session, from, text) {
  if (!openai || AI_GLOBAL === "off") return "IA no disponible.";
  if (!["lite", "pro"].includes(session.data.aiMode)) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (session.data.aiCountDate !== today) {
    session.data.aiCountDate = today;
    session.data.aiCount = 0;
  }

  const limit = session.data.aiMode === "pro" ? 120 : 40;
  if (session.data.aiCount >= limit)
    return "⚠️ Límite diario de IA alcanzado. Escribí humano.";

  const c = getCompanySafe(session);

  const prompt = `
${c.prompt}

CATÁLOGO:
${c.catalog.map((p) => `${p.id}) ${p.name}: $${p.price}`).join("\n")}

Reglas:
- Tono: ${c.rules.tone || "neutral"}
- No inventar datos
- Siempre cerrar con pregunta
`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "user", content: text }],
    instructions: prompt,
  });

  session.data.aiCount++;
  saveSession(session);

  return resp.output_text;
}
// ================= UTILIDADES =================
const newOrderId = () => "PED-" + Math.random().toString(36).slice(2, 8).toUpperCase();

const isReserved = (t) =>
  [
    "menu","hola","catalogo","carrito","checkout","agregar",
    "pago","pagar","pagado","confirmar","cancelar","ayuda",
    "humano","asesor","hablar con humano"
  ].includes(t);

const isHumanTrigger = (t) =>
  ["humano","asesor","hablar con humano"].includes(t);

// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();
  const cmd = body.replace(/\s+/g, " ").toLowerCase();

  // Guardar último cliente (para admin sin número)
  if (from && !cmd.startsWith("admin")) setSetting("last_customer", from);

  const session = getSession(from);
  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // ================= HUMANO =================
  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;
    saveSession(session);
    reply = "✅ Listo. Un asesor te va a responder en breve.";
    return respond(res, reply);
  }

  if (session.state === "HUMAN" && !cmd.startsWith("admin")) {
    reply = "⏳ Un asesor ya fue notificado.";
    return respond(res, reply);
  }

  // ================= ADMIN =================
  if (cmd.startsWith("admin")) {
    if (!isAdmin(from)) return respond(res, "⛔ Comando restringido.");

    // admin whoami
    if (cmd === "admin whoami") return respond(res, `ADMIN OK: ${from}`);

    // admin company list
    if (cmd === "admin company list") {
      const rows = db.prepare(`SELECT id,name FROM companies`).all();
      return respond(
        res,
        rows.length
          ? "📋 Empresas:\n" + rows.map(r => `• ${r.id} — ${r.name}`).join("\n")
          : "No hay empresas."
      );
    }

// admin company set <companyId> [whatsapp:+...]
const companySet = cmd.match(/^admin company set ([a-z0-9_-]+)(?:\s+(.+))?$/i);
if (companySet) {
  const companyId = companySet[1].toLowerCase();
  let target = (companySet[2] || "").trim();

  // validar empresa
  const row = db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
  if (!row) {
    reply = `No existe la empresa '${companyId}'.`;
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  // target = último cliente si no se pasa número
  if (!target) target = getSetting("last_customer");
  if (!target) {
    reply = "No tengo 'último cliente' todavía. Hacé que un cliente mande un mensaje primero.";
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  }

  // normalizar formato whatsapp:
  if (!target.startsWith("whatsapp:")) {
    if (target.startsWith("+")) target = `whatsapp:${target}`;
    else if (target.match(/^\d+$/)) target = `whatsapp:+${target}`;
  }

  // setear en la sesión del cliente
  const s2 = getSession(target);
  s2.data.companyId = companyId;
  saveSession(s2);

  reply = `🏢 Empresa para ${target}: ${row.id} (${row.name}) ✅`;
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  return res.type("text/xml").send(twiml.toString());
}

    // admin ai set off|lite|pro [numero]
    const mAi = cmd.match(/^admin ai set (off|lite|pro)(?:\s+(.+))?$/i);
    if (mAi) {
      let target = mAi[2] || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");
      if (!target.startsWith("whatsapp:")) target = `whatsapp:${target.replace("+","")}`;
      const s2 = getSession(target);
      s2.data.aiMode = mAi[1];
      saveSession(s2);
      return respond(res, `🤖 IA ${mAi[1].toUpperCase()} para ${target}`);
    }

    // admin ai status
    const mStatus = cmd.match(/^admin ai status(?:\s+(.+))?$/i);
    if (mStatus) {
      let target = mStatus[1] || getSetting("last_customer");
      if (!target) return respond(res, "No hay cliente activo.");
      if (!target.startsWith("whatsapp:")) target = `whatsapp:${target.replace("+","")}`;
      const s2 = getSession(target);
      return respond(res, `🤖 IA: ${(s2.data.aiMode || "off").toUpperCase()}`);
    }

    return respond(res, "Admin OK");
  }
// ================= MENU / CATALOGO / CARRITO / AGREGAR (UNICO) =================
if (text === "menu" || text === "hola") {
  session.state = "MENU";
  session.data.humanNotified = false;
  saveSession(session);
  return respond(res, menuText(getCompanySafe(session)));
}

if (text === "catalogo") {
  return respond(res, catalogText(getCompanySafe(session)));
}

if (text === "carrito") {
  return respond(res, cartText(session));
}

const mAdd = text.match(/^agregar\s+(\d+)$/);
if (mAdd) {
  const id = Number(mAdd[1]);
  const company = getCompanySafe(session);
  const p = company.catalog.find((x) => Number(x.id) === id);
  if (!p) return respond(res, "Ese producto no existe. Escribí catalogo y elegí una opción válida.");
  session.cart.push(id);
  saveSession(session);
  return respond(res, `✅ Agregado ${p.name}\n\n${cartText(session)}\n\nPara finalizar: checkout`);
}

  // ================= IA =================
  if (
    ["lite","pro"].includes(session.data.aiMode) &&
    session.state === "MENU" &&
    !isReserved(text)
  ) {
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

  if (session.state === "ASK_NAME") {
    session.data.name = body;
    session.state = "ASK_CONTACT";
    saveSession(session);
    return respond(res, "Pasame un contacto.");
  }

  if (session.state === "ASK_CONTACT") {
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
    items.forEach(id => detailed[id] = (detailed[id] || 0) + 1);
    const itemsDetailed = Object.entries(detailed).map(([id,q])=>{
      const p = company.catalog.find(x=>x.id==id);
      const sub = p.price*q; total+=sub;
      return { id:Number(id), name:p.name, qty:q, unit:p.price, subtotal:sub };
    });

    const orderId = newOrderId();
    db.prepare(`
      INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId,
      new Date().toISOString(),
      from,
      company.id,
      session.data.name,
      session.data.contact,
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
app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Bot corriendo")
);
