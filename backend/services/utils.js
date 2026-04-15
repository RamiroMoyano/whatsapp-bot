// Utilidades compartidas entre módulos

export const SUPPORTED_CURRENCIES = new Set(["ARS", "USD", "EUR", "GBP", "BRL"]);

export const newOrderId = () => "PED-" + Math.random().toString(36).slice(2, 8).toUpperCase();

export const isReserved = (t) =>
  [
    "menu","hola","catalogo","carrito","checkout",
    "pago","pagar","pagado","confirmar","cancelar","ayuda",
    "humano","asesor","hablar con humano"
  ].includes(t);

export const isHumanTrigger = (t) => ["humano","asesor","hablar con humano"].includes(t);

export function parseJsonSafe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw ?? "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function normalizeTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeCurrencyCode(value, fallback = "USD") {
  const raw = String(value || "").trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.has(raw)) return raw;
  return fallback;
}

export function getCompanyCatalogCurrency(company) {
  const rules = company?.rules && typeof company.rules === "object" ? company.rules : {};
  return normalizeCurrencyCode(
    rules.catalogCurrency ||
    rules.subscriptionCurrency ||
    "USD"
  );
}

export function formatChatMoney(value, currencyCode = "USD") {
  const amount = Number(value || 0);
  const currency = normalizeCurrencyCode(currencyCode);
  if (!Number.isFinite(amount)) return `${currency} 0`;
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount * 100) / 100}`;
  }
}

export function normalizeWhatsappFromNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toLowerCase() === "unknown") return "unknown";

  let phone = raw;
  if (phone.toLowerCase().startsWith("whatsapp:")) {
    phone = phone.slice("whatsapp:".length).trim();
  }

  if (!phone) return "";
  let compact = phone.replace(/[^\d+]/g, "");
  if (!compact) return "";

  if (compact.startsWith("+")) {
    compact = `+${compact.slice(1).replace(/\+/g, "")}`;
  } else {
    compact = `+${compact.replace(/\+/g, "")}`;
  }

  return `whatsapp:${compact}`;
}

export function isTruthyFlag(value) {
  if (value === true) return true;
  const raw = String(value || "").trim().toLowerCase();
  return ["1", "true", "on", "si", "yes"].includes(raw);
}

export function roundMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
