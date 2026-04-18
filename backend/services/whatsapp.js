import twilio from "twilio";

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();

/**
 * Sends a proactive (outbound) WhatsApp message via Twilio REST API.
 * Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars.
 * `from` and `to` can be plain digits or include "whatsapp:" prefix / "+" prefix.
 */
export async function sendWhatsappProactiveMessage({ from, to, body }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log("[wa-notify] TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN no configurados — omitiendo");
    return { ok: false, error: "credentials_missing" };
  }

  const normalize = (n) => String(n || "").replace(/^whatsapp:/i, "").replace(/\s/g, "");
  const fromNum = normalize(from).replace(/\D/g, "");
  const toNum = normalize(to).replace(/\D/g, "");
  if (!fromNum || !toNum) return { ok: false, error: "invalid_numbers" };

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const msg = await client.messages.create({
      from: `whatsapp:+${fromNum}`,
      to: `whatsapp:+${toNum}`,
      body: String(body || ""),
    });
    console.log(`[wa-notify] Enviado OK — sid=${msg.sid} to=+${toNum}`);
    return { ok: true, sid: msg.sid };
  } catch (e) {
    console.error("[wa-notify] Error al enviar:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

const STATE_MESSAGES = {
  preparing: (orderId, name) =>
    `🍳 Tu pedido *#${orderId}* en *${name}* ya está siendo preparado. Te avisamos cuando esté listo. 👌`,
  ready: (orderId, name) =>
    `✅ ¡Tu pedido *#${orderId}* en *${name}* está listo para retirar! Podés pasar cuando quieras. 🎉`,
  completed: (orderId, name) =>
    `🙌 Tu pedido *#${orderId}* en *${name}* fue entregado. ¡Gracias por tu compra!`,
};

/** Returns the notification message body for a given state, or null if no message is defined. */
export function buildOrderStateNotificationBody(state, orderId, companyName) {
  const fn = STATE_MESSAGES[String(state || "")];
  return fn ? fn(String(orderId || ""), String(companyName || "")) : null;
}
