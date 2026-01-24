import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import { db } from "./db.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// ====== CONFIG ======
const CATALOG = [
  { id: 1, name: "Bot para WhatsApp", price: 100 },
  { id: 2, name: "Bot para Instagram", price: 80 },
  { id: 3, name: "Bot combinado (WhatsApp + Instagram)", price: 160 },
];

const PAYMENT = {
  transfer: {
    alias: process.env.TRANSFER_ALIAS || "",
    titular: process.env.TRANSFER_TITULAR || "",
    banco: process.env.TRANSFER_BANCO || "",
  },
  mpLinks: {
    1: process.env.MP_LINK_WHATSAPP || "",
    2: process.env.MP_LINK_INSTAGRAM || "",
    3: process.env.MP_LINK_COMBINADO || "",
  },
};

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").trim();
function isAdmin(from) {
  return ADMIN_NUMBER && from === ADMIN_NUMBER;
}

// Telegram (Node 22+ tiene fetch nativo)
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram: faltan env vars", {
      hasToken: !!TELEGRAM_BOT_TOKEN,
      hasChat: !!TELEGRAM_CHAT_ID,
    });
    return;
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
    } else {
      console.log("Telegram OK:", data?.result?.message_id);
    }
  } catch (e) {
    console.error("Telegram notify failed:", e?.message || e);
  }
}

// ====== Enviar WhatsApp saliente (notificar al cliente) ======
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || "").trim(); // ej: "whatsapp:+14155238886"

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log("WhatsApp notify: faltan env vars Twilio", {
      hasSid: !!TWILIO_ACCOUNT_SID,
      hasToken: !!TWILIO_AUTH_TOKEN,
      hasFrom: !!TWILIO_WHATSAPP_FROM,
      to,
    });
    return false;
  }
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to,
      body,
    });
    console.log("WhatsApp notify OK:", { to });
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
    return {
      id: Number(id),
      name: p?.name || "UNKNOWN",
      qty,
      unit,
      subtotal: unit * qty,
    };
  });
}

function waLink(fromNumber) {
  const digits = (fromNumber || "").replace("whatsapp:", "").replace("+", "").trim();
  return digits ? `https://wa.me/${digits}` : "";
}

function menuText() {
  return `👋 Hola! Soy tu asistente de compras.

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
1) Bot para WhatsApp USD $100
2) Bot para Instagram USD $80
3) Bot combinado USD $160

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
    return `Todavía no tengo cargado el link de MP para ese producto.\nCargalo en variables de entorno (Render) y redeploy.`;
  }
  return `Para múltiples ítems, por ahora te paso el link de MP manual.\n(Después lo automatizamos con MP API).`;
}

function paymentTransferText() {
  const { alias, titular, banco } = PAYMENT.transfer;
  return `🏦 Transferencia
• Alias/CBU: ${alias || "—"}
• Titular: ${titular || "—"}
• Banco: ${banco || "—"}

Cuando transfieras, mandá: pagado (y si querés el comprobante).`;
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
    "admin",
    "admin ayuda",
    "admin pedidos",
    "admin hoy",
    "admin telegram",
    "admin pendientes",
    "admin pagados",
    "admin entregados",
  ].includes(text);
}

function isHumanTrigger(text) {
  return text === "humano" || text === "asesor" || text === "hablar con humano";
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
  if (!row) {
    return {
      fromNumber,
      state: "MENU",
      cart: [],
      data: { name: "", contact: "", notes: "", humanNotified: false },
      lastOrderId: null,
      lastOrderItems: [],
    };
  }
  const data = JSON.parse(row.dataJson || "{}");
  const cart = JSON.parse(row.cartJson || "[]");
  return {
    fromNumber,
    state: row.state,
    cart,
    data,
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

const setPaidStmt = db.prepare(`
  UPDATE orders
  SET paymentStatus='paid',
      paymentMethod=@paymentMethod,
      orderStatus='paid'
  WHERE id=@id
`);

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

// ====== HEALTH ======
app.get("/", (req, res) => res.send("OK - server running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== WEBHOOK ======
app.post("/whatsapp", (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();

  const session = getSession(from);
  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // ===== HANDOFF A HUMANO =====
  // Permite admin aun si está HUMAN
  if (session.state === "HUMAN" && text !== "menu" && text !== "hola" && !text.startsWith("admin")) {
    if (!session.data?.humanNotified) {
      session.data = session.data || {};
      session.data.humanNotified = true;
      reply = "✅ Listo. Un asesor te va a responder en breve.";
      sendTelegram(`🙋‍♂️ Solicitud de HUMANO\nCliente: ${from}\nMensaje: ${body}`);
    } else {
      reply = "✅ Un asesor ya fue notificado.";
    }

    saveSession(session);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());
    return;
  }

  if (isHumanTrigger(text)) {
    session.state = "HUMAN";
    session.data = session.data || {};
    session.data.humanNotified = true;

    const extra = session.lastOrderId ? `\nÚltimo pedido: ${session.lastOrderId}` : "";
    sendTelegram(`🙋‍♂️ Solicitud de HUMANO\nCliente: ${from}${extra}\nMensaje: ${body}`);

    reply = "✅ Listo. Un asesor te va a responder en breve.";
    saveSession(session);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // -------- ADMIN COMMANDS (solo tu numero) --------
  if (text.startsWith("admin")) {
    if (!isAdmin(from)) {
      reply = "⛔ Comando restringido.";
    } else {
      if (text === "admin" || text === "admin ayuda") {
        reply = `🛠 Admin:
• admin pedidos
• admin pedido PED-XXXXXX
• admin hoy
• admin telegram
• admin contacted PED-XXXXXX
• admin pendientes
• admin pagados
• admin entregados
• admin status PED-XXXXXX confirmed|paid|delivered
• admin auto whatsapp:+54...`;
      }

      if (text === "admin pedidos") {
        const rows = listLastOrdersStmt.all(5);
        if (!rows.length) reply = "No hay pedidos todavía.";
        else {
          const lines = rows.map(
            (r) => `• ${r.id} — ${r.paymentStatus} — USD $${r.total} — ${r.fromNumber} — ${r.createdAt}`
          );
          reply = `📦 Últimos pedidos:\n${lines.join("\n")}\n\nUsá: admin pedido PED-XXXXXX`;
        }
      }

      if (text === "admin pendientes") {
        const rows = listPendingOrdersStmt.all(10);
        if (!rows.length) reply = "✅ No hay pendientes de pago.";
        else {
          const lines = rows.map((r) => `• ${r.id} — pending — USD $${r.total} — ${r.fromNumber}`);
          reply = `⏳ Pendientes de pago:\n${lines.join("\n")}`;
        }
      }

      if (text === "admin pagados") {
        const rows = listPaidNotDeliveredStmt.all(10);
        if (!rows.length) reply = "✅ No hay pagados pendientes de entrega.";
        else {
          const lines = rows.map((r) => `• ${r.id} — paid — USD $${r.total} — ${r.fromNumber}`);
          reply = `💰 Pagados (sin entregar):\n${lines.join("\n")}`;
        }
      }

      if (text === "admin entregados") {
        const rows = listDeliveredOrdersStmt.all(10);
        if (!rows.length) reply = "📭 No hay entregados todavía.";
        else {
          const lines = rows.map((r) => `• ${r.id} — delivered — USD $${r.total} — ${r.fromNumber}`);
          reply = `📦 Entregados:\n${lines.join("\n")}`;
        }
      }

      const m = text.match(/^admin\s+pedido\s+(ped-[a-z0-9]+)$/i);
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
            `Contactado: ${row.contactedAt ? "✅ " + row.contactedAt : "❌ no"}\n` +
            `Contactado por: ${row.contactedBy || "—"}\n` +
            `Total: USD $${row.total}\n\n` +
            `Items:\n${itemsText || "—"}`;
        }
      }

      if (text === "admin hoy") {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();

        const rows = listTodayOrdersStmt.all({ start, end });
        if (!rows.length) reply = "📭 No hay pedidos hoy.";
        else {
          const lines = rows.map((r) => `• ${r.id} — ${r.paymentStatus} — USD $${r.total} — ${r.fromNumber}`);
          reply = `📅 Pedidos de hoy:\n${lines.join("\n")}`;
        }
      }

      if (text === "admin telegram") {
        sendTelegram("✅ Test Telegram OK (enviado desde WhatsApp bot)");
        reply = "Listo ✅ mandé un test a Telegram. Mirá tu Telegram y también los logs de Render.";
      }

      // admin contacted PED-XXXXXX
      const c = text.match(/^admin\s+contacted\s+(ped-[a-z0-9]+)$/i);
      if (c) {
        const orderId = c[1].toUpperCase();
        const row = getOrderByIdStmt.get(orderId);
        if (!row) {
          reply = `No encontré el pedido ${orderId}`;
        } else {
          setContactedStmt.run({
            id: orderId,
            contactedAt: new Date().toISOString(),
            contactedBy: from,
          });
          reply = `✅ Marcado como CONTACTADO: ${orderId}`;
          sendTelegram(`📞 Pedido CONTACTADO\n${orderId}\nCliente: ${row.fromNumber}\nTotal: USD $${row.total}`);
        }
      }

      // admin status PED-XXXXXX confirmed|paid|delivered (telegram + notify customer)
      const s = text.match(/^admin\s+status\s+(ped-[a-z0-9]+)\s+(confirmed|paid|delivered)$/i);
      if (s) {
        const orderId = s[1].toUpperCase();
        const status = s[2].toLowerCase();

        const row = getOrderByIdStmt.get(orderId);
        if (!row) {
          reply = `No encontré el pedido ${orderId}`;
        } else {
          if (status === "delivered") {
            setDeliveredStmt.run({ id: orderId, deliveredAt: new Date().toISOString() });
            reply = `✅ Marcado como ENTREGADO: ${orderId}`;
            sendTelegram(`📦 Pedido ENTREGADO\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);

            // Notificar cliente por WhatsApp (saliente)
            sendWhatsApp(row.fromNumber, `📦 ¡Listo! Tu pedido ${orderId} fue marcado como ENTREGADO. Gracias 🙌`);
          } else if (status === "paid") {
            setPaidByAdminStmt.run({ id: orderId });
            reply = `✅ Marcado como PAGADO: ${orderId}`;
            sendTelegram(`💰 Pedido PAGADO\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);

            // Notificar cliente por WhatsApp (saliente)
            sendWhatsApp(row.fromNumber, `✅ Pago registrado para tu pedido ${orderId}. En breve coordinamos la entrega.`);
          } else if (status === "confirmed") {
            setConfirmedByAdminStmt.run({ id: orderId });
            reply = `✅ Marcado como CONFIRMADO: ${orderId}`;
            sendTelegram(`🧾 Pedido CONFIRMADO (admin)\n${orderId}\nTotal: USD $${row.total}\nCliente: ${row.fromNumber}`);
          } else {
            // fallback (no debería entrar)
            setOrderStatusStmt.run({ orderStatus: status, id: orderId });
            reply = `✅ Status actualizado (${status}): ${orderId}`;
          }
        }
      }

      // admin auto whatsapp:+549...
      const a = text.match(/^admin\s+auto\s+(whatsapp:\+\d+)$/i);
      if (a) {
        const target = a[1];
        const s2 = getSession(target);
        s2.state = "MENU";
        s2.data = s2.data || {};
        s2.data.humanNotified = false;
        saveSession(s2);
        reply = `✅ Volví a modo automático a: ${target}`;
      }
    }

    saveSession(session);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Menu / Hola
  if (text === "hola" || text === "menu") {
    session.state = "MENU";
    session.data = session.data || {};
    session.data.humanNotified = false;
    reply = menuText();
  }

  // Cancelar
  if (text === "cancelar") {
    session.state = "MENU";
    session.cart = [];
    session.data = { name: "", contact: "", notes: "", humanNotified: false };
    session.lastOrderId = null;
    reply = "🧹 Listo, reinicié todo.\n\n" + menuText();
  }

  // Ayuda / catalogo / carrito
  if (text === "ayuda") reply = "Flujo: catalogo → agregar 1 → carrito → checkout → confirmar → pago";
  if (text === "catalogo") reply = catalogText();
  if (text === "carrito") reply = cartText(session);

  // Agregar producto
  const addMatch = text.match(/^agregar\s+(\d+)$/);
  if (addMatch) {
    const id = Number(addMatch[1]);
    const p = CATALOG.find((x) => x.id === id);
    if (!p) reply = "Ese producto no existe. Escribí catalogo y elegí 1, 2 o 3.";
    else {
      session.cart.push(id);
      reply = `✅ Agregado: ${p.name}\n\n${cartText(session)}\n\nPara finalizar: checkout`;
    }
  }

  // Checkout
  if (text === "checkout") {
    if (session.cart.length === 0) reply = "Tu carrito está vacío. Escribí catalogo.";
    else {
      session.state = "ASK_NAME";
      reply = `Perfecto ✅\n\n${cartText(session)}\n\n¿A nombre de quién va el pedido?`;
    }
  }

  // Datos
  if (session.state === "ASK_NAME" && !isReserved(text)) {
    session.data = session.data || {};
    session.data.name = body;
    session.state = "ASK_CONTACT";
    reply = "Genial. Pasame un contacto (email o WhatsApp alternativo).";
  } else if (session.state === "ASK_CONTACT" && !isReserved(text)) {
    session.data = session.data || {};
    session.data.contact = body;
    session.state = "ASK_NOTES";
    reply = "¿Qué querés que haga el bot? (ventas, FAQs, turnos, etc). Si no, escribí: no";
  } else if (session.state === "ASK_NOTES" && !isReserved(text)) {
    session.data = session.data || {};
    session.data.notes = text === "no" ? "" : body;
    session.state = "READY";
    reply =
      `✅ Resumen del pedido\n\n${cartText(session)}\n\n` +
      `👤 Nombre: ${session.data.name}\n` +
      `📩 Contacto: ${session.data.contact}\n` +
      `📝 Notas: ${session.data.notes || "—"}\n\n` +
      `Para confirmar: confirmar\nPara cancelar: cancelar`;
  }

  // Confirmar (guarda + notifica)
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

      const adminMsg =
        `🛎️ Nuevo pedido ${orderId}\n` +
        `Total: USD $${total}\n` +
        `Cliente: ${from}\n` +
        (link ? `Contactar: ${link}\n` : "") +
        `Nombre: ${session.data.name || "—"}\n` +
        `Contacto: ${session.data.contact || "—"}\n` +
        `Notas: ${session.data.notes || "—"}\n` +
        `Items:\n` +
        itemsDetailed.map((i) => `- ${i.name} x${i.qty} (USD $${i.subtotal})`).join("\n");

      sendTelegram(adminMsg);

      session.lastOrderId = orderId;
      session.state = "MENU";
      session.cart = [];
      session.data = { name: "", contact: "", notes: "", humanNotified: false };

      reply = `🎉 Pedido confirmado: *${orderId}*\n\nPara pagar escribí: pago`;
    }
  }

  // Pago
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

  // ====== MEJORA: Telegram cuando el cliente dice "pagado" ======
  if (text === "pagado") {
    if (!session.lastOrderId) {
      reply = "Perfecto ✅ ¿De qué pedido? (no veo uno reciente).";
    } else {
      setPaidStmt.run({ id: session.lastOrderId, paymentMethod: "manual" });

      const row = getOrderByIdStmt.get(session.lastOrderId);
      sendTelegram(
        `🧾 Cliente dijo "PAGADO"\nPedido: ${session.lastOrderId}\nCliente: ${from}\nTotal: USD $${row?.total ?? "?"}\nContactar: ${waLink(from)}`
      );

      reply = `Genial ✅ Registré que pagaste el pedido *${session.lastOrderId}*.\nEn breve te contacto para la entrega.`;
    }
  }

  // Test
  if (text === "testpedido") {
    const orderId = newOrderId();
    const createdAt = new Date().toISOString();
    const items = [1, 3];
    const itemsDetailed = formatItems(items);
    const total = calcTotal(items);

    insertOrderStmt.run({
      id: orderId,
      createdAt,
      fromNumber: from,
      name: "Test",
      contact: "test@demo.com",
      notes: "pedido de prueba",
      itemsJson: JSON.stringify(items),
      itemsDetailedJson: JSON.stringify(itemsDetailed),
      total,
      paymentStatus: "pending",
      paymentMethod: "",
      orderStatus: "confirmed",
      deliveredAt: null,
    });

    session.lastOrderId = orderId;
    reply = `✅ Guardé un pedido de prueba: ${orderId}`;
  }

  saveSession(session);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

app.listen(process.env.PORT || 3000, () => console.log("Listening on http://localhost:3000"));
