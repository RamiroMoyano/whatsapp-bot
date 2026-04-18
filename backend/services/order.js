import { db } from "../db.js";
import { parseJsonSafe, newOrderId, roundMoney, formatChatMoney, getCompanyCatalogCurrency } from "./utils.js";
import { normalizePaymentMethodInput, paymentMethodLabel, paymentMethodsReplyText } from "./payment.js";
import { sendTelegram } from "./telegram.js";

export const RECENT_ORDER_LINK_WINDOW_MS = Math.max(5 * 60 * 1000, Number(process.env.RECENT_ORDER_LINK_WINDOW_MS || 6 * 60 * 60 * 1000));
export const CART_REMINDER_AFTER_MS = Math.max(5 * 60 * 1000, Number(process.env.CART_REMINDER_AFTER_MS || 30 * 60 * 1000));

// ===== Normalización de estado de órdenes =====

export function normalizeOrderWorkflowState(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("reject") || raw.includes("rechaz") || raw.includes("cancel") || raw.includes("anul")) return "rejected";
  if (raw.includes("complet") || raw.includes("entreg") || raw.includes("finaliz") || raw.includes("cerrad")) return "completed";
  if (raw.includes("pend")) return "pending";
  return "";
}

export function normalizeArchivedFlag(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "si" || raw === "on";
}

export function parseLegacyOrderCategory(value) {
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

export function inferOrderWorkflowStateFromStatus(orderStatus, paymentStatus) {
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

export function deriveOrderWorkflowFromRow(row) {
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

export function normalizeOrderRow(row) {
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

// ===== Checkout / carrito =====

export function buildCheckoutItemsFromSession(session, company) {
  const raw = Array.isArray(session?.cart) ? [...session.cart] : [];
  let total = 0;
  const grouped = {};
  raw.forEach((item) => {
    const id = typeof item === "object" ? item.id : item;
    const lockedPrice = typeof item === "object" ? item.price : null;
    const key = Number(id);
    if (!Number.isFinite(key)) return;
    if (!grouped[key]) grouped[key] = { qty: 0, lockedPrice };
    grouped[key].qty += 1;
  });

  const items = raw.map((item) => (typeof item === "object" ? item.id : item));

  const itemsDetailed = Object.entries(grouped).map(([id, { qty, lockedPrice }]) => {
    const p = (company?.catalog || []).find((x) => Number(x.id) === Number(id));
    const unit = lockedPrice != null ? lockedPrice : Number(p?.price || 0);
    const subtotal = unit * qty;
    total += subtotal;
    return { id: Number(id), name: p?.name || `Producto ${id}`, qty, unit, subtotal };
  });

  return { items, itemsDetailed, total };
}

export function mergeCheckoutNotes(existingNotesRaw, nextNotesRaw) {
  const existingNotes = String(existingNotesRaw || "").trim();
  const nextNotes = String(nextNotesRaw || "").trim();
  if (!existingNotes) return nextNotes;
  if (!nextNotes) return existingNotes;
  if (existingNotes.includes(nextNotes)) return existingNotes;
  return `${existingNotes}\n${nextNotes}`;
}

export async function appendOrderNote(orderIdRaw, noteRaw) {
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

export async function resolvePendingSessionOrder(session) {
  const sessionOrderId = String(session?.lastOrderId || "").trim();
  const checkoutOrderId = String(session?.data?.checkoutOrderId || "").trim();
  if (!sessionOrderId || !checkoutOrderId || sessionOrderId !== checkoutOrderId) return null;
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

export async function resolveRecentReceiptOrder(session) {
  const orderId = String(session?.data?.recentOrderId || session?.lastOrderId || "").trim();
  if (!orderId) return null;
  const recentAtRaw = Number(session?.data?.recentOrderAt || 0);
  if (!recentAtRaw || (Date.now() - recentAtRaw) > RECENT_ORDER_LINK_WINDOW_MS) return null;
  const row = await db.prepare(`
    SELECT id, companyId, workflowState, archived, category, orderStatus, paymentStatus, paymentMethod
    FROM orders
    WHERE id=?
  `).get(orderId);
  if (!row) return null;
  const sameCompany =
    String(row.companyId || "").trim().toLowerCase() ===
    String(session?.data?.companyId || "babystepsbots").trim().toLowerCase();
  if (!sameCompany) return null;
  return row;
}

export function markRecentOrder(session, orderIdRaw, paymentMethodRaw = "") {
  const orderId = String(orderIdRaw || "").trim();
  if (!orderId) return;
  session.lastOrderId = orderId;
  session.data.recentOrderId = orderId;
  session.data.recentOrderAt = Date.now();
  const paymentMethod = normalizePaymentMethodInput(paymentMethodRaw || "");
  if (paymentMethod) {
    session.data.recentOrderPaymentMethod = paymentMethod;
  } else {
    delete session.data.recentOrderPaymentMethod;
  }
}

export function clearCheckoutProgress(session, options = {}) {
  const keepRecentOrder = options.keepRecentOrder !== false;
  session.state = "MENU";
  session.data.name = "";
  session.data.contact = "";
  session.data.notes = "";
  session.data.address = "";
  delete session.data.paymentMethodHint;
  delete session.data.checkoutOrderId;
  if (!keepRecentOrder) {
    delete session.data.recentOrderId;
    delete session.data.recentOrderAt;
    delete session.data.recentOrderPaymentMethod;
    session.lastOrderId = null;
  }
}

export async function buildUniqueOrderId() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = newOrderId();
    const exists = await db.prepare(`SELECT id FROM orders WHERE id=?`).get(candidate);
    if (!exists?.id) return candidate;
  }
  return `PED-${Date.now().toString(36).toUpperCase()}`;
}

export async function createOrUpdateCheckoutOrder(session, from, company, options = {}) {
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
      mergedName, mergedContact, mergedNotes,
      nextItemsJson, nextItemsDetailedJson, nextTotal,
      "pending", finalMethod, "confirmed", "pending",
      false, null, "", "pending",
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
    orderId, now, from, company.id,
    orderName, orderContact, orderNotes,
    JSON.stringify(snapshot.items),
    JSON.stringify(snapshot.itemsDetailed),
    snapshot.total,
    "pending", finalMethod, "confirmed",
    null, "pending", "pending", false, null, ""
  );

  session.lastOrderId = orderId;
  session.data.checkoutOrderId = orderId;
  session.cart = [];
  return { orderId, total: snapshot.total, paymentMethod: finalMethod, reused: false };
}

export function buildOrderRegisteredReply(company, orderId, total, paymentMethodRaw) {
  const paymentMethod = normalizePaymentMethodInput(paymentMethodRaw);
  const paymentLabelText = paymentMethodLabel(paymentMethod);
  const totalText = formatChatMoney(Number(total || 0), getCompanyCatalogCurrency(company));
  const lines = [
    `Pedido ${orderId} registrado.`,
    `Total: ${totalText}`,
    `Medio de pago: ${paymentLabelText}.`,
    "",
  ];

  if (paymentMethod === "transferencia") {
    lines.push(paymentMethodsReplyText(company, { orderId }));
    lines.push("");
    lines.push("Si queres, envia comprobante (opcional) o indica cuando realizas la transferencia.");
    lines.push("Si despues queres sumar otro producto, iniciamos un pedido nuevo.");
    return lines.join("\n");
  }
  if (paymentMethod === "efectivo") {
    lines.push("Perfecto. Indica lugar y horario para coordinar pago en efectivo y entrega.");
    lines.push("Si queres comprar algo mas, armamos otro pedido aparte.");
    return lines.join("\n");
  }
  if (paymentMethod === "debito" || paymentMethod === "tarjeta") {
    lines.push("Perfecto. Si queres, envia el comprobante del pago con tarjeta de forma opcional para agilizar la validacion.");
    lines.push("Tambien podes indicar cualquier detalle util sobre el pago o la entrega.");
    lines.push("Si despues queres agregar otro producto, iniciamos un pedido nuevo.");
    return lines.join("\n");
  }

  lines.push(paymentMethodsReplyText(company, { orderId }));
  return lines.join("\n");
}

export async function notifyTelegramOrderCreated(company, fromNumber, created) {
  const orderId = String(created?.orderId || "").trim();
  if (!orderId) return false;
  if (created?.reused) return false;

  const total = Number(created?.total || 0);
  const paymentLabelText = paymentMethodLabel(created?.paymentMethod || "");
  const companyName = String(company?.name || company?.id || "-").trim();
  const customer = String(fromNumber || "-").trim();

  return sendTelegram(
    `PEDIDO GENERADO\n` +
    `Empresa: ${companyName}\n` +
    `Cliente: ${customer}\n` +
    `Pedido: ${orderId}\n` +
    `Total: ${formatChatMoney(total, getCompanyCatalogCurrency(company))}\n` +
    `Pago: ${paymentLabelText}`
  );
}

// ===== Logging de mensajes =====

export async function logWhatsappMessage({
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
      from, cid, oid || null, dir, safeRole,
      body, media || null, mediaType || null,
      messageSid || null, at
    );
  } catch (e) {
    console.error("ai_messages insert error:", e?.message || e);
  }
}

// ===== Backfill de columnas de workflow (ejecutar al inicio) =====

export async function backfillOrdersWorkflowColumns() {
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
