import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import {
  getCompany,
  getIgSession,
  hasMetaMessage,
  initInstagramDb,
  logIgMessage,
  saveIgSession,
} from "./db.js";

dotenv.config();

const app = express();
app.disable("x-powered-by");

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

const PORT = Number(process.env.PORT || 3001);
const VERIFY_TOKEN = String(process.env.IG_VERIFY_TOKEN || "").trim();
const APP_SECRET = String(process.env.IG_APP_SECRET || "").trim();
const PAGE_ACCESS_TOKEN = String(process.env.IG_PAGE_ACCESS_TOKEN || "").trim();
const DEFAULT_COMPANY_ID = String(process.env.IG_DEFAULT_COMPANY_ID || "babystepsbots").trim().toLowerCase();
const GRAPH_VERSION = String(process.env.IG_GRAPH_VERSION || "v22.0").trim();
const FALLBACK_IG_BUSINESS_ID = String(process.env.IG_BUSINESS_ID || "").trim();

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isHumanTrigger(textRaw) {
  const text = normalizeText(textRaw);
  return ["humano", "asesor", "hablar con humano", "agente", "persona"].includes(text);
}

function verifyMetaSignature(req) {
  if (!APP_SECRET) return false;
  const header = String(req.get("x-hub-signature-256") || "").trim();
  if (!header.startsWith("sha256=")) return false;
  const sent = header.slice("sha256=".length);
  const computed = crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");

  const sentBuf = Buffer.from(sent, "utf8");
  const computedBuf = Buffer.from(computed, "utf8");
  if (sentBuf.length !== computedBuf.length) return false;
  return crypto.timingSafeEqual(sentBuf, computedBuf);
}

function menuText(company) {
  return (
    `Hola! Soy el asistente de ${company.name} en Instagram.\n` +
    `Opciones:\n` +
    `- menu\n` +
    `- catalogo\n` +
    `- humano`
  );
}

function catalogText(company) {
  const catalog = Array.isArray(company?.catalog) ? company.catalog : [];
  if (!catalog.length) return `Catalogo de ${company.name}: sin productos cargados por ahora.`;
  const lines = catalog.slice(0, 50).map((item) => {
    const id = String(item?.id ?? "-").trim();
    const name = String(item?.name || "Producto").trim();
    const price = Number(item?.price || 0);
    const money = Number.isFinite(price) ? `$${Math.round(price * 100) / 100}` : "$0";
    return `${id}) ${name} - ${money}`;
  });
  return `Catalogo de ${company.name}:\n${lines.join("\n")}\n\nPara hablar con una persona: humano`;
}

async function sendInstagramText({ igBusinessId, igUserId, text }) {
  const businessId = String(igBusinessId || FALLBACK_IG_BUSINESS_ID).trim();
  if (!businessId) throw new Error("Falta IG_BUSINESS_ID y no vino recipient.id en el evento.");
  if (!PAGE_ACCESS_TOKEN) throw new Error("Falta IG_PAGE_ACCESS_TOKEN.");

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(businessId)}/messages`;
  const resp = await fetch(`${url}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: igUserId },
      messaging_type: "RESPONSE",
      message: { text: String(text || "").trim() || "OK" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Graph API ${resp.status}: ${body}`);
  }
}

async function getOrCreateSession(igUserId) {
  const existing = await getIgSession(igUserId);
  if (existing) return existing;
  const session = {
    igUserId,
    state: "MENU",
    data: {
      companyId: DEFAULT_COMPANY_ID,
      humanNotified: false,
    },
  };
  await saveIgSession(session);
  return session;
}

function extractIncomingEvents(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  if (!Array.isArray(root.entry)) return [];
  const events = [];
  for (const entry of root.entry) {
    const entryId = String(entry?.id || "").trim();
    const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const item of messaging) {
      const senderId = String(item?.sender?.id || "").trim();
      const recipientId = String(item?.recipient?.id || "").trim() || entryId;
      const messageText = String(item?.message?.text || "").trim();
      const mid = String(item?.message?.mid || "").trim();
      const timestamp = Number(item?.timestamp || 0);
      if (!senderId) continue;
      if (!messageText) continue;
      events.push({
        igUserId: senderId,
        igBusinessId: recipientId,
        text: messageText,
        mid,
        eventTime: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null,
        raw: item,
      });
    }
  }
  return events;
}

async function handleIncomingMessage(event) {
  const session = await getOrCreateSession(event.igUserId);
  const companyId = String(session?.data?.companyId || DEFAULT_COMPANY_ID).trim().toLowerCase() || DEFAULT_COMPANY_ID;
  const company = await getCompany(companyId) || {
    id: DEFAULT_COMPANY_ID,
    name: DEFAULT_COMPANY_ID,
    prompt: "",
    catalog: [],
    rules: {},
  };

  const normalized = normalizeText(event.text);
  let reply = "";

  if (normalized === "menu" || normalized === "hola") {
    session.state = "MENU";
    session.data.humanNotified = false;
    reply = menuText(company);
  } else if (normalized === "catalogo") {
    reply = catalogText(company);
  } else if (isHumanTrigger(normalized)) {
    session.state = "HUMAN";
    session.data.humanNotified = true;
    reply = "Listo. Te derivamos con un asesor humano. En breve te respondemos por este chat.";
  } else if (session.state === "HUMAN") {
    reply = "Tu solicitud ya esta derivada a un asesor. Si queres volver al menu, escribe: menu";
  } else {
    reply = (
      `Puedo ayudarte con informacion de productos y derivarte con un asesor.\n` +
      `Escribi: catalogo, menu o humano`
    );
  }

  await saveIgSession(session);

  await logIgMessage({
    igUserId: event.igUserId,
    igBusinessId: event.igBusinessId,
    companyId: company.id,
    direction: "out",
    content: reply,
    eventTime: new Date().toISOString(),
    rawPayload: null,
  });

  await sendInstagramText({
    igBusinessId: event.igBusinessId,
    igUserId: event.igUserId,
    text: reply,
  });
}

app.get("/instagram/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "").trim();
  const token = String(req.query["hub.verify_token"] || "").trim();
  const challenge = String(req.query["hub.challenge"] || "").trim();

  if (!VERIFY_TOKEN) {
    return res.status(500).send("IG_VERIFY_TOKEN no configurado");
  }
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/instagram/webhook", async (req, res) => {
  try {
    if (!APP_SECRET) return res.status(500).send("IG_APP_SECRET no configurado");
    if (!verifyMetaSignature(req)) return res.sendStatus(401);

    const events = extractIncomingEvents(req.body);
    if (!events.length) return res.status(200).send("EVENT_RECEIVED");

    for (const event of events) {
      const duplicate = await hasMetaMessage(event.mid);
      if (duplicate) continue;

      const session = await getOrCreateSession(event.igUserId);
      const companyId = String(session?.data?.companyId || DEFAULT_COMPANY_ID).trim().toLowerCase() || DEFAULT_COMPANY_ID;

      await logIgMessage({
        igUserId: event.igUserId,
        igBusinessId: event.igBusinessId,
        companyId,
        direction: "in",
        content: event.text,
        metaMessageId: event.mid,
        eventTime: event.eventTime,
        rawPayload: event.raw,
      });

      await handleIncomingMessage(event);
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("instagram webhook error:", e?.message || e);
    return res.status(200).send("EVENT_RECEIVED");
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "instagram-bot",
    defaultCompany: DEFAULT_COMPANY_ID,
  });
});

initInstagramDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[instagram-bot] listening on ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("initInstagramDb failed:", e?.message || e);
    process.exit(1);
  });

