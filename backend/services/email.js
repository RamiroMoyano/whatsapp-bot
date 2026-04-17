import fetch from "node-fetch";
import { parseJsonSafe } from "./utils.js";

const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || "Bot <no-reply@resend.dev>").trim();

export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log("[email] RESEND_API_KEY no configurado — email omitido");
    return { ok: false, error: "RESEND_API_KEY no configurado" };
  }
  if (!to || !subject) return { ok: false, error: "Faltan campos obligatorios" };

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || `<p>${text || subject}</p>`,
      }),
    });

    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[email] Resend error:", r.status, data);
      return { ok: false, error: data?.message || `HTTP ${r.status}` };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error("[email] sendEmail failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function notifyEmailOrderCreated(company, from, created) {
  const rules = parseJsonSafe(company?.rulesJson || "{}", {});
  const ownerEmail = String(rules?.ownerEmail || "").trim();
  if (!ownerEmail) return;

  const companyName = String(company?.name || company?.id || "").trim();
  const orderId = String(created?.orderId || "-");
  const total = Number(created?.total || 0);
  const paymentMethod = String(created?.paymentMethod || "-");
  const fromDisplay = String(from || "-").replace("whatsapp:", "");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
  .card { background: #fff; max-width: 520px; margin: 32px auto; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .header { background: #1a1f36; padding: 24px 28px; }
  .header h1 { color: #fff; margin: 0; font-size: 18px; }
  .header p { color: #8892b0; margin: 4px 0 0; font-size: 13px; }
  .body { padding: 28px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .row:last-child { border-bottom: none; }
  .label { color: #666; font-size: 14px; }
  .value { font-weight: 600; font-size: 14px; color: #1a1f36; }
  .total { font-size: 20px; color: #2563eb; }
  .footer { background: #f8f9fa; padding: 16px 28px; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
  <div class="card">
    <div class="header">
      <h1>📦 Nuevo pedido recibido</h1>
      <p>${companyName}</p>
    </div>
    <div class="body">
      <div class="row"><span class="label">ID de pedido</span><span class="value">${orderId}</span></div>
      <div class="row"><span class="label">Cliente</span><span class="value">${fromDisplay}</span></div>
      <div class="row"><span class="label">Medio de pago</span><span class="value">${paymentMethod}</span></div>
      <div class="row"><span class="label">Total</span><span class="value total">$${total.toLocaleString("es-AR")}</span></div>
    </div>
    <div class="footer">Este mensaje fue generado automáticamente por tu bot de WhatsApp.</div>
  </div>
</body>
</html>`;

  return sendEmail({
    to: ownerEmail,
    subject: `📦 Nuevo pedido ${orderId} — $${total.toLocaleString("es-AR")}`,
    html,
  });
}
