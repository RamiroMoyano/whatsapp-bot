import { normalizeTextForMatch, formatChatMoney, getCompanyCatalogCurrency, roundMoney } from "./utils.js";
import { paymentMethodSelectionPrompt, extractCheckoutFieldsFromText, normalizePaymentMethodInput } from "./payment.js";

export function pickCatalogEmoji(itemRaw, index = 0) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const text = normalizeTextForMatch(`${item.name || ""} ${item.category || ""} ${item.rubro || ""}`);
  if (text.includes("perro") || text.includes("can") || text.includes("mascotas")) return "🐶";
  if (text.includes("gato") || text.includes("felin")) return "🐱";
  if (text.includes("ropa") || text.includes("remera") || text.includes("camisa") || text.includes("prenda")) return "👕";
  if (text.includes("zapatilla") || text.includes("calzado") || text.includes("zapato")) return "👟";
  if (text.includes("comida") || text.includes("alimento") || text.includes("comestible")) return "🍝";
  if (text.includes("bebida") || text.includes("jugo") || text.includes("agua")) return "🥤";
  if (text.includes("electronico") || text.includes("tech") || text.includes("gadget")) return "📱";
  if (text.includes("libro") || text.includes("curso") || text.includes("capacitacion")) return "📚";
  if (text.includes("bot") || text.includes("ia") || text.includes("inteligencia")) return "🤖";
  if (text.includes("servicio") || text.includes("plan") || text.includes("suscripcion")) return "⭐";
  const emojis = ["🔹","🔸","🟢","🟡","🟠","🔵","🟣","⚪","🟤","⚫"];
  return emojis[index % emojis.length];
}

export function normalizeCatalogMatchText(value) {
  return normalizeTextForMatch(value)
    .replace(/[^a-z0-9\s,+\-\/x]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMeaningfulCatalogValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  return !!raw && !["-", "n/a", "na", "null", "undefined", "sin dato", "s/d"].includes(raw);
}

export function buildCatalogCategoryPathFromItem(itemRaw) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const categoryRaw = String(item.category ?? item.type ?? "").trim();
  if (isMeaningfulCatalogValue(categoryRaw)) return categoryRaw;

  const parts = [item.rubro, item.seccion, item.subseccion]
    .map((value) => String(value ?? "").trim())
    .filter((value) => isMeaningfulCatalogValue(value));
  if (!parts.length) return "-";

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.length ? unique.join(" > ") : "-";
}

export function getCatalogGroupKeyset(itemRaw) {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const sources = [
    buildCatalogCategoryPathFromItem(item),
    item.rubro,
    item.seccion,
    item.subseccion,
    item.category,
    item.type,
    item.tags,
  ];

  const keywords = new Set();
  for (const source of sources) {
    const values = Array.isArray(source) ? source : [source];
    for (const value of values) {
      const normalized = normalizeCatalogMatchText(value);
      if (!normalized) continue;
      keywords.add(normalized);
      for (const token of normalized.split(" ")) {
        if (token.length >= 3) keywords.add(token);
      }
    }
  }
  return keywords;
}

export function extractWeightGramsFromText(value) {
  const raw = normalizeCatalogMatchText(value);
  if (!raw) return 0;
  const kgMatch = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos)\b/);
  if (kgMatch) {
    const n = Number(String(kgMatch[1]).replace(",", "."));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  const gMatch = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(g|gr|grs|gramo|gramos)\b/);
  if (gMatch) {
    const n = Number(String(gMatch[1]).replace(",", "."));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

export function extractNameTokensForCatalogSearch(value) {
  const raw = normalizeCatalogMatchText(value);
  if (!raw) return [];
  const clean = ` ${raw} `
    .replace(/\b\d+(?:[.,]\d+)?\s*(kg|kilo|kilos|g|gr|grs|gramo|gramos)\b/g, " ")
    .replace(/\b\d+\s*(x|unidades?|u|uds?)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\b(de|del|la|el|los|las|para|con|sin|quiero|agregar|agregame|sumame|sumar|suma|comprar|compra|pedido|carrito|checkout|info|informacion|detalle|detalles|contame|cuentame|mas|sobre|mostrame|mostrar|ver|me|interesa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  return clean.split(" ").filter((token) => token.length >= 3);
}

export function scoreCatalogItemByTokens(item, tokens) {
  if (!tokens.length) return 0;
  const text = normalizeCatalogMatchText(
    `${item?.name || ""} ${item?.category || ""} ${item?.rubro || ""} ${item?.seccion || ""} ${item?.subseccion || ""}`
  );
  if (!text) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits;
}

export function computeWeightedSelectionByGrams(textRaw, catalogRaw) {
  const requestedGrams = extractWeightGramsFromText(textRaw);
  if (!requestedGrams) return [];
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const tokens = extractNameTokensForCatalogSearch(textRaw);

  const candidates = catalog
    .map((item) => {
      const id = Number(item?.id);
      const weight = extractWeightGramsFromText(item?.name || "");
      if (!Number.isFinite(id) || !weight) return null;
      const score = scoreCatalogItemByTokens(item, tokens);
      return { id, weight, score };
    })
    .filter(Boolean)
    .filter((item) => (tokens.length ? item.score > 0 : true));

  if (!candidates.length) return [];

  const bestScore = Math.max(...candidates.map((c) => c.score));
  const scoped = candidates
    .filter((c) => c.score === bestScore)
    .sort((a, b) => b.weight - a.weight);
  const maxWeight = scoped[0]?.weight || 0;
  const minWeight = scoped[scoped.length - 1]?.weight || 0;
  if (!maxWeight || !minWeight) return [];

  const maxUnits = Math.min(60, Math.ceil(requestedGrams / minWeight) + 8);
  const limit = Math.max(requestedGrams + maxWeight * 2, requestedGrams);
  const dp = Array.from({ length: limit + 1 }, () => null);
  dp[0] = { units: 0, counts: Array(scoped.length).fill(0) };

  for (let total = 0; total <= limit; total += 1) {
    const state = dp[total];
    if (!state) continue;
    if (state.units >= maxUnits) continue;
    for (let i = 0; i < scoped.length; i += 1) {
      const nextTotal = total + scoped[i].weight;
      if (nextTotal > limit) continue;
      const nextUnits = state.units + 1;
      const current = dp[nextTotal];
      if (current && current.units <= nextUnits) continue;
      const counts = state.counts.slice();
      counts[i] += 1;
      dp[nextTotal] = { units: nextUnits, counts };
    }
  }

  let bestTotal = -1;
  let bestExcess = Number.POSITIVE_INFINITY;
  let bestUnits = Number.POSITIVE_INFINITY;
  for (let total = 0; total <= limit; total += 1) {
    const state = dp[total];
    if (!state || !state.units) continue;
    const excess = total >= requestedGrams ? total - requestedGrams : Number.POSITIVE_INFINITY;
    if (excess < bestExcess || (excess === bestExcess && state.units < bestUnits)) {
      bestExcess = excess;
      bestUnits = state.units;
      bestTotal = total;
    }
  }

  if (bestTotal < 0 || !dp[bestTotal]) return [];
  const selectedIds = [];
  dp[bestTotal].counts.forEach((qty, idx) => {
    for (let i = 0; i < qty; i += 1) selectedIds.push(scoped[idx].id);
  });
  return selectedIds;
}

export function isPureCatalogSelectionText(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;

  const compact = ` ${raw} `
    .replace(/\b(\d{1,2})\s*x\s*(\d{1,3})\b/g, " ")
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\b(y|e|and|,|\/|\+|-|del|de|el|la|los|las)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !compact;
}

export function looksLikeCatalogInfoIntent(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;
  const keywords = [
    "contame","cuentame","info","informacion","mas","detalle","detalles",
    "caracteristica","caracteristicas","que incluye","que trae",
    "como funciona","diferencia","explicame",
  ];
  if (raw.includes("?")) return true;
  return keywords.some((word) => raw.includes(word));
}

export function looksLikeCatalogAddIntent(textRaw) {
  const raw = normalizeCatalogMatchText(textRaw);
  if (!raw) return false;
  const keywords = [
    "agrega","agregame","agregar","sumame","sumar","suma",
    "anadi","añadi","aniadi","adiciona","quiero","me interesa",
    "llevo","comprar","compra","adquirir","elijo","elegi",
  ];
  return keywords.some((word) => raw.includes(word));
}

export function looksLikeCatalogSelectionIntent(textRaw) {
  return (
    isPureCatalogSelectionText(textRaw) ||
    looksLikeCatalogAddIntent(textRaw) ||
    looksLikeCatalogInfoIntent(textRaw) ||
    extractWeightGramsFromText(textRaw) > 0
  );
}

export function extractCatalogSelectionsFromText(textRaw, catalogRaw) {
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const normalizedText = normalizeCatalogMatchText(textRaw);
  const isInfoIntent = looksLikeCatalogInfoIntent(textRaw);
  const isAddIntent = looksLikeCatalogAddIntent(textRaw);
  const isPureSelection = isPureCatalogSelectionText(textRaw);
  const idToProduct = new Map();
  for (const item of catalog) {
    const id = Number(item?.id);
    if (!Number.isFinite(id)) continue;
    idToProduct.set(id, item);
  }

  const selectedIds = [];
  const selectedOnce = new Set();
  const invalidIds = [];
  let weightedMatched = false;

  const addId = (id, qty = 1, explicitQuantity = false) => {
    if (!idToProduct.has(id)) {
      if (!invalidIds.includes(id)) invalidIds.push(id);
      return;
    }
    if (explicitQuantity) {
      const safeQty = Math.max(1, Math.min(20, Number(qty) || 1));
      for (let i = 0; i < safeQty; i += 1) selectedIds.push(id);
      selectedOnce.add(id);
      return;
    }
    if (selectedOnce.has(id)) return;
    selectedIds.push(id);
    selectedOnce.add(id);
  };

  let working = ` ${normalizedText} `;
  working = working.replace(/\b\d+(?:[.,]\d+)?\s*(kg|kilo|kilos|g|gr|grs|gramo|gramos)\b/g, " ");
  const qtyPattern = /\b(\d{1,2})\s*x\s*(\d{1,3})\b/g;
  for (const match of normalizedText.matchAll(qtyPattern)) {
    const qty = Number(match[1]);
    const id = Number(match[2]);
    if (Number.isFinite(id)) addId(id, qty, true);
  }
  working = working.replace(qtyPattern, " ");

  const numericPattern = /\b(\d{1,3})\b/g;
  for (const match of working.matchAll(numericPattern)) {
    const id = Number(match[1]);
    if (!Number.isFinite(id)) continue;
    addId(id, 1, false);
  }

  const genericWords = new Set(["bot","whatsapp","con","sin","para","de","del","la","el","los","las","ai"]);

  for (const [id, item] of idToProduct.entries()) {
    if (selectedOnce.has(id)) continue;
    const itemName = normalizeCatalogMatchText(item?.name || "");
    if (!itemName) continue;

    if (working.includes(` ${itemName} `)) {
      addId(id, 1, false);
      continue;
    }

    const strongTokens = itemName
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !genericWords.has(token));
    if (!strongTokens.length) continue;

    const allTokensPresent = strongTokens.every((token) => working.includes(token));
    if (allTokensPresent) addId(id, 1, false);
  }

  const unitsByNameMatch = normalizedText.match(/\b(\d{1,2})\s*(?:x|unidades?|u|uds?)?\s+(?:de\s+)?(.+)$/);
  if (unitsByNameMatch) {
    const qty = Math.max(1, Math.min(20, Number(unitsByNameMatch[1]) || 1));
    const targetText = unitsByNameMatch[2] || "";
    const targetTokens = extractNameTokensForCatalogSearch(targetText);
    if (targetTokens.length) {
      const scored = [...idToProduct.entries()]
        .map(([id, item]) => ({ id, score: scoreCatalogItemByTokens(item, targetTokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
        addId(scored[0].id, qty, true);
      }
    }
  }

  if ((isAddIntent || isPureSelection) && !isInfoIntent) {
    const weightedIds = computeWeightedSelectionByGrams(textRaw, catalog);
    if (weightedIds.length) {
      weightedMatched = true;
      for (const id of weightedIds) addId(id, 1, true);
    }
  }

  const groupStopWords = new Set([
    "catalogo","producto","productos","opcion","opciones","quiero","agregar","agregame",
    "sumame","sumar","suma","compra","comprar","pedido","pedidos","carrito","checkout",
    "info","informacion","detalle","detalles","contame","cuentame","mas","sobre",
    "del","de","la","el","los","las","para","con","sin","mostrame","mostrar","ver",
    "tengo","que","me","interesa",
  ]);

  const queryTokens = normalizedText
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !groupStopWords.has(token));

  const groupMatchesRaw = [];
  if (queryTokens.length) {
    for (const [id, item] of idToProduct.entries()) {
      const keyset = getCatalogGroupKeyset(item);
      if (!keyset.size) continue;

      const keyList = [...keyset];
      let hits = 0;
      for (const token of queryTokens) {
        const matched = keyList.some((key) => {
          if (key === token) return true;
          if (key.length >= 4 && key.includes(token)) return true;
          if (token.length >= 5 && token.includes(key)) return true;
          return false;
        });
        if (matched) hits += 1;
      }

      if (hits > 0) {
        groupMatchesRaw.push({ id, hits, category: buildCatalogCategoryPathFromItem(item) });
      }
    }
  }

  let groupMatchedIds = [];
  let groupLabels = [];
  if (groupMatchesRaw.length) {
    groupMatchesRaw.sort((a, b) => b.hits - a.hits || a.id - b.id);
    const minHits = queryTokens.length > 1 ? 2 : 1;
    const filtered = groupMatchesRaw.filter((row) => row.hits >= minHits);
    const scoped = filtered.length ? filtered : groupMatchesRaw;

    const uniqueIds = [];
    const seenIds = new Set();
    for (const row of scoped) {
      if (selectedOnce.has(row.id)) continue;
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      uniqueIds.push(row.id);
    }
    groupMatchedIds = uniqueIds;

    const labels = [];
    const seenLabels = new Set();
    for (const row of scoped) {
      const label = String(row.category || "-").trim();
      if (!isMeaningfulCatalogValue(label)) continue;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      labels.push(label);
      if (labels.length >= 3) break;
    }
    groupLabels = labels;
  }

  return {
    selectedIds,
    invalidIds,
    groupMatchedIds,
    groupLabels,
    hasSelectionIntent: looksLikeCatalogSelectionIntent(textRaw),
    isInfoIntent,
    isAddIntent,
    isPureSelection,
    weightedMatched,
  };
}

export function summarizeCatalogSelection(idsRaw, catalogRaw) {
  const ids = Array.isArray(idsRaw) ? idsRaw : [];
  const catalog = Array.isArray(catalogRaw) ? catalogRaw : [];
  const counts = new Map();
  for (const id of ids) {
    const key = Number(id);
    if (!Number.isFinite(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lines = [];
  for (const [id, qty] of counts.entries()) {
    const product = catalog.find((item) => Number(item?.id) === id);
    const label = product?.name || `Producto ${id}`;
    lines.push(qty > 1 ? `${label} x${qty}` : label);
  }
  return lines;
}

export function catalogItemDetailsText(itemRaw, currencyCode = "USD") {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const name = String(item.name || "Producto").trim();
  const priceText = formatChatMoney(Number(item.price || 0), currencyCode);
  const explicitDescription = String(
    item.description || item.details || item.detail || item.summary || item.info || ""
  ).trim();

  if (explicitDescription) {
    return `${name} - ${priceText}\n${explicitDescription}`;
  }

  const normalizedName = normalizeTextForMatch(name);
  if (normalizedName.includes("base")) {
    return `${name} - ${priceText}\nIncluye flujo comercial base sin IA avanzada, ideal para empezar.`;
  }
  if (normalizedName.includes("lite")) {
    return `${name} - ${priceText}\nIncluye IA LITE con memoria/contexto moderado y asistencia comercial.`;
  }
  if (normalizedName.includes("pro")) {
    return `${name} - ${priceText}\nIncluye IA PRO con mayor memoria/contexto y respuestas mas personalizadas.`;
  }
  if (normalizedName.includes("dashboard")) {
    return `${name} - ${priceText}\nPanel con metricas operativas para seguimiento comercial y pedidos.`;
  }
  return `${name} - ${priceText}\nSi queres, te detallo alcance y casos de uso para este producto.`;
}

export function buildCatalogInfoReply(company, selectedIdsRaw) {
  const selectedIds = Array.isArray(selectedIdsRaw) ? selectedIdsRaw : [];
  const catalog = Array.isArray(company?.catalog) ? company.catalog : [];
  const uniqueIds = [...new Set(selectedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  const selectedItems = uniqueIds
    .map((id) => catalog.find((item) => Number(item?.id) === id))
    .filter(Boolean);

  if (!selectedItems.length) {
    return "Decime que opcion queres revisar (por ID o nombre).\nEjemplo: info 2, info bot ai lite.";
  }

  const lines = [];
  const currency = getCompanyCatalogCurrency(company);
  lines.push(`Te paso info de ${selectedItems.length} opcion(es):`);
  lines.push("");
  for (const item of selectedItems) {
    lines.push(`${pickCatalogEmoji(item, Number(item?.id || 0))} ${catalogItemDetailsText(item, currency)}`);
    lines.push("");
  }
  lines.push("Si queres agregar al carrito, escribi: agregar <id> (ej: agregar 2).");
  lines.push("Tambien podes agregar varios por nombre o por IDs.");
  return lines.join("\n").trim();
}

export function buildCatalogFilteredReply(company, selectedIdsRaw, labelsRaw = []) {
  const selectedIds = Array.isArray(selectedIdsRaw) ? selectedIdsRaw : [];
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter(Boolean) : [];
  const catalog = Array.isArray(company?.catalog) ? company.catalog : [];
  const uniqueIds = [...new Set(selectedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  const selectedItems = uniqueIds
    .map((id) => catalog.find((item) => Number(item?.id) === id))
    .filter(Boolean);

  if (!selectedItems.length) {
    return "No encontre productos para ese rubro/seccion. Escribi catalogo para ver opciones.";
  }

  const lines = [];
  const currency = getCompanyCatalogCurrency(company);
  const context = labels.length ? ` en ${labels.join(" / ")}` : "";
  lines.push(`Encontre ${selectedItems.length} producto(s)${context}:`);
  lines.push("");
  for (const [idx, item] of selectedItems.slice(0, 40).entries()) {
    const category = buildCatalogCategoryPathFromItem(item);
    const suffix = category !== "-" ? ` [${category}]` : "";
    lines.push(`${pickCatalogEmoji(item, idx)} ${item.name} - ${formatChatMoney(Number(item.price || 0), currency)}${suffix} (ID ${item.id})`);
  }
  if (selectedItems.length > 40) {
    lines.push("");
    lines.push(`Mostrando 40 de ${selectedItems.length}. Pedi un filtro mas especifico para acotar.`);
  }
  lines.push("");
  lines.push("Para agregar al carrito: agregar <id>  (ej: agregar 2)");
  lines.push("Para ver detalle: info <id>");
  return lines.join("\n");
}

export function contextualCheckoutFallback(session, company, options = {}) {
  const state = String(session?.state || "MENU");
  const cartCount = Array.isArray(session?.cart) ? session.cart.length : 0;
  const activeOrderId = String(options.activeOrderId || "").trim();

  if (state === "ASK_NAME") return "Necesito tu nombre para continuar con el pedido.";
  if (state === "ASK_CONTACT") return "Necesito un telefono de contacto para continuar.";
  if (state === "ASK_NOTES") {
    return "Agrega notas u observaciones para el pedido (opcional).\nSi no queres agregar nada, dejalo vacio o responde: ok";
  }
  if (state === "ASK_PAYMENT_METHOD") return paymentMethodSelectionPrompt(company);
  if (state === "ASK_PAYMENT_DETAILS") {
    return (
      `Contame detalle de coordinacion para el pedido ${activeOrderId || "(sin ID)"}.\n` +
      "Ejemplo: dia, horario y lugar. Si no aplica, responde con -"
    );
  }
  if (state === "MENU" && activeOrderId && !cartCount) {
    return (
      `Tenes un pedido activo (${activeOrderId}).\n` +
      "Podes enviar detalle de pago/entrega o escribir menu para iniciar un nuevo flujo."
    );
  }
  if (state === "MENU" && cartCount > 0) {
    const hasName = !!String(session?.data?.name || "").trim();
    const hasContact = !!String(session?.data?.contact || "").trim();
    const hasPayment = !!String(session?.data?.paymentMethodHint || "").trim();
    const missing = [];
    if (!hasName) missing.push("nombre");
    if (!hasContact) missing.push("contacto");
    if (!hasPayment) missing.push("medio de pago");

    if (!missing.length) {
      return (
        "Ya tengo carrito y datos base. Escribi checkout para continuar,\n" +
        "o envia todo junto: nombre + telefono + medio de pago.\n" +
        "Si queres ver detalles de un producto: info <id>."
      );
    }
    return (
      `Ya tengo tu carrito. Falta: ${missing.join(", ")}.\n` +
      "Tambien podes enviar todo en un solo mensaje (ej: Pedro 3812345678 efectivo).\n" +
      "Si queres ver detalles de un producto: info <id>."
    );
  }
  return "No entendi. Escribi: menu / catalogo / ayuda";
}

export function looksLikeCheckoutOperationalMessage(textRaw) {
  const raw = normalizeTextForMatch(textRaw);
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return true;

  const keywords = [
    "catalogo","carrito","checkout","agregar","comprar","compra","pedido","pago",
    "pagado","comprobante","transfer","efectivo","debito","credito","tarjeta",
    "confirmar","me interesa","quiero el","quiero esos","sumame","sumar","llevo",
  ];
  if (keywords.some((word) => raw.includes(word))) return true;

  const extracted = extractCheckoutFieldsFromText(textRaw);
  return !!(extracted.contact || extracted.paymentMethod);
}

export function formatCatalogChoices(catalogItems) {
  if (!catalogItems.length) return "Sin opciones de catalogo.";
  return catalogItems
    .map((item) => `- ${item.id ? `${item.id}) ` : ""}${item.name}`)
    .join("\n");
}

export function normalizeCatalogEntries(catalogRaw) {
  if (!Array.isArray(catalogRaw)) return [];
  return catalogRaw
    .map((item, idx) => ({
      id: String(item?.id ?? "").trim(),
      idLower: String(item?.id ?? "").trim().toLowerCase(),
      name: String(item?.name || item?.title || `Producto ${idx + 1}`).trim(),
      nameLower: String(item?.name || item?.title || `Producto ${idx + 1}`).trim().toLowerCase(),
      price: roundMoney(item?.price ?? item?.amount ?? 0),
    }))
    .filter((item) => item.name);
}
