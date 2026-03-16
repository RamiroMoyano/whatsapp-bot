function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTone(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["success", "ok", "green"].includes(raw)) return "success";
  if (["warning", "warn", "amber", "yellow"].includes(raw)) return "warning";
  if (["danger", "error", "critical", "red"].includes(raw)) return "danger";
  return "info";
}

function normalizeCard(card, index = 0) {
  if (isObject(card)) {
    const title = String(card.title || card.label || card.name || "").trim();
    if (!title) return null;
    const value = card.value ?? card.amount ?? card.total ?? "-";
    return {
      title,
      value: String(value),
      tone: normalizeTone(card.tone),
    };
  }

  if (Array.isArray(card) && card.length >= 2) {
    return {
      title: String(card[0] || `Indicador ${index + 1}`),
      value: String(card[1] ?? "-"),
      tone: "info",
    };
  }

  return null;
}

function normalizeAlerts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (isObject(item) && item.text) return String(item.text).trim();
      return "";
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeTable(table) {
  if (!isObject(table)) return null;
  const title = String(table.title || table.name || "Tabla").trim();
  const columns = Array.isArray(table.columns)
    ? table.columns.map((column) => String(column || "").trim()).filter(Boolean)
    : [];
  const rows = Array.isArray(table.rows)
    ? table.rows
      .map((row) => {
        if (!Array.isArray(row)) return null;
        return row.map((cell) => String(cell ?? ""));
      })
      .filter(Boolean)
    : [];

  if (!columns.length || !rows.length) return null;

  return {
    title,
    columns,
    rows: rows.slice(0, 50),
  };
}

function deriveCardsFromFlatObject(payload) {
  if (!isObject(payload)) return [];
  return Object.entries(payload)
    .filter(([key, value]) => !["cards", "alerts", "table", "meta", "rows", "columns"].includes(key))
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => ({
      title: key.replace(/[_-]+/g, " ").trim() || "Dato",
      value: String(value),
      tone: "info",
    }));
}

export function normalizeIntegrationPayload(payload, options = {}) {
  const source = isObject(payload) ? payload : {};
  const explicitCards = Array.isArray(source.cards)
    ? source.cards.map((item, index) => normalizeCard(item, index)).filter(Boolean)
    : [];
  const cards = explicitCards.length ? explicitCards : deriveCardsFromFlatObject(source);
  const alerts = normalizeAlerts(source.alerts || source.warnings || source.messages || []);
  const table = normalizeTable(source.table);
  const meta = isObject(source.meta) ? source.meta : {};

  return {
    cards,
    alerts,
    table,
    meta: {
      source: String(meta.source || options.source || "custom_api"),
      updatedAt: String(meta.updatedAt || new Date().toISOString()),
    },
  };
}

