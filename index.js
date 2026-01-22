import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const sessions = new Map();

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

// Guardado local (un pedido por linea) - se crea cuando se confirma o con testpedido
const ORDERS_FILE = `${process.cwd()}\\orders.jsonl`;

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

function saveOrderToFile(order) {
  fs.appendFileSync(ORDERS_FILE, JSON.stringify(order) + "\n", { encoding: "utf8" });
}

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      state: "MENU", // MENU | ASK_NAME | ASK_CONTACT | ASK_NOTES | READY
      cart: [],
      data: { name: "", contact: "", notes: "" },
      lastOrder: null,
    });
  }
  return sessions.get(from);
}

function menuText() {
  return `👋 Hola! Soy tu asistente de compras.

Escribí:
• catalogo
• agregar 1
• carrito
• checkout
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
  const unique = [...new Set(session.lastOrder.items)];
  if (unique.length === 1) {
    const id = unique[0];
    const link = PAYMENT.mpLinks[id];
    if (link) return `✅ Link MercadoPago:\n${link}\n\nCuando pagues, mandá: pagado`;
    return `Todavía no tengo cargado el link de MP para ese producto.\nPegalo en .env y reiniciá el bot.`;
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
  ].includes(text);
}

app.post("/whatsapp", (req, res) => {
  const from = req.body.From || "unknown";
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();

  const session = getSession(from);
  let reply = "No entendí 😅. Escribí: menu / catalogo / ayuda";

  // Menu / Hola
  if (text === "hola" || text === "menu") {
    session.state = "MENU";
    reply = menuText();
  }

  // Cancelar
  if (text === "cancelar") {
    session.state = "MENU";
    session.cart = [];
    session.data = { name: "", contact: "", notes: "" };
    session.lastOrder = null;
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

  // Datos (estados)
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
    session.state = "READY";
    reply =
      `✅ Resumen del pedido\n\n${cartText(session)}\n\n` +
      `👤 Nombre: ${session.data.name}\n` +
      `📩 Contacto: ${session.data.contact}\n` +
      `📝 Notas: ${session.data.notes || "—"}\n\n` +
      `Para confirmar: confirmar\nPara cancelar: cancelar`;
  }

  // Confirmar
  if (text === "confirmar") {
    if (session.cart.length === 0) {
      reply = "No hay carrito activo. Escribí catalogo.";
    } else if (session.state !== "READY") {
      reply = "Todavía falta completar el checkout. Escribí: checkout";
    } else {
      const orderId = newOrderId();

      session.lastOrder = {
        id: orderId,
        items: [...session.cart],
        data: { ...session.data },
        createdAt: new Date().toISOString(),
      };

      const enriched = {
        ...session.lastOrder,
        from,
        itemsDetailed: formatItems(session.lastOrder.items),
        total: calcTotal(session.lastOrder.items),
      };

      saveOrderToFile(enriched);

      session.state = "MENU";
      session.cart = [];
      session.data = { name: "", contact: "", notes: "" };

      reply = `🎉 Pedido confirmado: *${orderId}*\n\nPara pagar escribí: pago`;
    }
  }

  // Pago
  if (text === "pago" || text === "pagar") {
    if (!session.lastOrder) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else reply = paymentMenuText(session.lastOrder.id);
  }

  if (text === "pagar transferencia") {
    if (!session.lastOrder) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else reply = paymentTransferText();
  }

  if (text === "pagar mp") {
    if (!session.lastOrder) reply = "No tengo un pedido confirmado reciente. Hacé: checkout → confirmar";
    else reply = paymentMpText(session);
  }

  if (text === "pagado") {
    if (!session.lastOrder) reply = "Perfecto ✅ ¿De qué pedido? (no veo uno reciente).";
    else reply = `Genial ✅ Ya registré el pago del pedido *${session.lastOrder.id}*. En breve te contacto para la entrega.`;
  }

  // Atajo para testear guardado sin depender de Twilio
  if (text === "testpedido") {
    const orderId = newOrderId();
    const fake = {
      id: orderId,
      items: [1, 3],
      data: { name: "Test", contact: "test@demo.com", notes: "pedido de prueba" },
      createdAt: new Date().toISOString(),
      from,
    };

    const enriched = {
      ...fake,
      itemsDetailed: formatItems(fake.items),
      total: calcTotal(fake.items),
    };

    saveOrderToFile(enriched);
    session.lastOrder = fake;

    reply = `✅ Guardé un pedido de prueba: ${orderId}\n\nArchivo: ${ORDERS_FILE}`;
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

app.get("/", (req, res) => res.send("OK - server running"));
app.listen(process.env.PORT || 3000, () => console.log("Listening on http://localhost:3000"));

