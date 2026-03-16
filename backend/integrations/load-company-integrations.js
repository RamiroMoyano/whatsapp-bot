import crypto from "crypto";
import { db } from "../db.js";

function parseJsonSafe(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

export function createIntegrationId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `int_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function normalizeIntegrationRow(row, options = {}) {
  if (!row) return null;
  const includeSecrets = options.includeSecrets === true;
  const config = parseJsonSafe(row.configJson || "{}", {});
  const secrets = parseJsonSafe(row.secretsJson || "{}", {});
  const normalized = {
    id: String(row.id || ""),
    companyId: String(row.companyId || ""),
    provider: String(row.provider || "").trim().toLowerCase(),
    name: String(row.name || "").trim(),
    enabled: row.enabled === true || row.enabled === 1 || String(row.enabled || "") === "1",
    configJson: String(row.configJson || "{}"),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || ""),
    config: config && typeof config === "object" && !Array.isArray(config) ? config : {},
  };

  if (includeSecrets) {
    normalized.secretsJson = String(row.secretsJson || "{}");
    normalized.secrets = secrets && typeof secrets === "object" && !Array.isArray(secrets) ? secrets : {};
  }

  return normalized;
}

export async function loadCompanyIntegrations(companyIdRaw, options = {}) {
  const companyId = String(companyIdRaw || "").trim();
  if (!companyId) return [];
  const includeSecrets = options.includeSecrets === true;
  const includeDisabled = options.includeDisabled !== false;
  const where = [`companyId = ?`];
  const params = [companyId];
  if (!includeDisabled) {
    where.push(`enabled = ?`);
    params.push(1);
  }
  const rows = await db.prepare(`
    SELECT id, companyId, provider, name, enabled, configJson, secretsJson, createdAt, updatedAt
    FROM company_integrations
    WHERE ${where.join(" AND ")}
    ORDER BY createdAt ASC
  `).all(...params);
  return rows.map((row) => normalizeIntegrationRow(row, { includeSecrets })).filter(Boolean);
}

export async function loadCompanyIntegration(companyIdRaw, integrationIdRaw, options = {}) {
  const companyId = String(companyIdRaw || "").trim();
  const integrationId = String(integrationIdRaw || "").trim();
  if (!companyId || !integrationId) return null;
  const row = await db.prepare(`
    SELECT id, companyId, provider, name, enabled, configJson, secretsJson, createdAt, updatedAt
    FROM company_integrations
    WHERE companyId = ? AND id = ?
  `).get(companyId, integrationId);
  return normalizeIntegrationRow(row, { includeSecrets: options.includeSecrets === true });
}
