import { normalizeTextForMatch, isTruthyFlag } from "./utils.js";

export function extractCompanyPaymentConfig(rulesRaw) {
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

export function paymentMethodsPromptText(company) {
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

export function paymentMethodsReplyText(company, options = {}) {
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

export function normalizePaymentMethodInput(value) {
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

export function normalizePaymentStatusInput(value) {
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

export function isPaidStatusValue(value) {
  return normalizePaymentStatusInput(value) === "paid";
}

export function paymentMethodLabel(methodRaw) {
  const method = normalizePaymentMethodInput(methodRaw);
  if (method === "transferencia") return "Transferencia";
  if (method === "debito") return "Debito";
  if (method === "tarjeta") return "Tarjeta de credito";
  if (method === "efectivo") return "Efectivo";
  return "No definido";
}

export function availablePaymentMethodKeys(company) {
  const payment = extractCompanyPaymentConfig(company?.rules || {});
  const methods = [];
  if (payment.enabled.cash) methods.push("efectivo");
  if (payment.enabled.debit) methods.push("debito");
  if (payment.enabled.transfer) methods.push("transferencia");
  if (payment.enabled.credit) methods.push("tarjeta");
  return methods.length ? methods : ["efectivo", "debito", "transferencia", "tarjeta"];
}

export function paymentMethodSelectionPrompt(company) {
  const methods = availablePaymentMethodKeys(company).map((item) => paymentMethodLabel(item));
  return (
    `Perfecto. Ahora elegi medio de pago: ${methods.join(", ")}.\n` +
    `Ejemplo: efectivo / transferencia / debito / tarjeta`
  );
}

export function extractCheckoutFieldsFromText(textRaw) {
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
    if (["si", "no", "ok", "listo", "hecho", "ahora", "hoy", "manana", "mañana"].includes(normalized)) continue;
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
      .replace(/débito/gi, " ")
      .replace(/tarjeta/gi, " ")
      .replace(/credito/gi, " ")
      .replace(/crédito/gi, " ")
      .replace(/cash/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/[a-zA-Z]/.test(single)) name = single;
  }

  return { name, contact, paymentMethod };
}
