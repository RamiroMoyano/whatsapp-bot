import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const DASHBOARD_DATABASE_URL = String(
  process.env.DASHBOARD_DATABASE_URL || process.env.DATABASE_URL || "",
).trim();

const DB_QUERY_TIMEOUT_MS = Number(process.env.DASHBOARD_DB_QUERY_TIMEOUT_MS || 10000);

function toPgSql(sql, params = []) {
  let index = 0;
  const text = String(sql).replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text, values: params };
}

function normalizeRowKeys(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "rulesjson") out.rulesJson = value;
    else if (key === "catalogjson") out.catalogJson = value;
    else if (key === "createdat") out.createdAt = value;
    else if (key === "updatedat") out.updatedAt = value;
    else if (key === "companyid") out.companyId = value;
    else out[key] = value;
  }
  return out;
}

function createDisabledDb() {
  const unavailable = async () => {
    throw new Error("Dashboard DB fallback no configurado");
  };
  return {
    enabled: false,
    query: unavailable,
    getAdminCompaniesLite: unavailable,
    getCompanyById: unavailable,
    findCompanyByIdentifier: unavailable,
    getCompanyIntegrations: unavailable,
    saveCompanyById: unavailable,
  };
}

let dashboardDb = createDisabledDb();

if (DASHBOARD_DATABASE_URL) {
  const pool = new Pool({
    connectionString: DASHBOARD_DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: false,
  });

  async function query(sql, params = []) {
    const { text, values } = toPgSql(sql, params);
    const queryPromise = pool.query(text, values);
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error("Dashboard DB query timeout"));
      }, DB_QUERY_TIMEOUT_MS);
    });
    const result = await Promise.race([queryPromise, timeoutPromise]);
    return result;
  }

  dashboardDb = {
    enabled: true,
    async query(sql, params = []) {
      return query(sql, params);
    },
    async getAdminCompaniesLite() {
      const result = await query(
        `SELECT id, name, createdat AS "createdAt", rulesjson AS "rulesJson"
           FROM companies
          ORDER BY id`,
      );
      return Array.isArray(result.rows) ? result.rows.map(normalizeRowKeys) : [];
    },
    async getCompanyById(companyId) {
      const result = await query(
        `SELECT *
           FROM companies
          WHERE id = ?
          LIMIT 1`,
        [String(companyId || "").trim()],
      );
      return result.rows?.[0] ? normalizeRowKeys(result.rows[0]) : null;
    },
    async findCompanyByIdentifier(input) {
      const normalized = String(input || "").trim().toLowerCase();
      if (!normalized) return null;
      const result = await query(
        `SELECT *
           FROM companies
          WHERE LOWER(id) = ?
             OR LOWER(name) = ?
          LIMIT 1`,
        [normalized, normalized],
      );
      return result.rows?.[0] ? normalizeRowKeys(result.rows[0]) : null;
    },
    async getCompanyIntegrations(companyId) {
      const result = await query(
        `SELECT
            id,
            companyid AS "companyId",
            provider,
            name,
            enabled,
            configjson AS "configJson",
            secretsjson AS "secretsJson",
            createdat AS "createdAt",
            updatedat AS "updatedAt"
           FROM company_integrations
          WHERE companyid = ?
          ORDER BY createdat ASC`,
        [String(companyId || "").trim()],
      );
      return Array.isArray(result.rows) ? result.rows.map(normalizeRowKeys) : [];
    },
    async saveCompanyById(companyId, payload = {}) {
      const id = String(companyId || "").trim();
      if (!id) throw new Error("Company ID requerido");
      const current = await this.getCompanyById(id);
      if (!current) throw new Error("Empresa no encontrada");

      const nextName = String(payload.name ?? current.name ?? id).trim() || id;
      const nextPrompt = String(payload.prompt ?? current.prompt ?? "").trim();
      const nextCatalogJson = String(payload.catalogJson ?? current.catalogJson ?? "[]");
      const nextRulesJson = String(payload.rulesJson ?? current.rulesJson ?? "{}");

      const result = await query(
        `UPDATE companies
            SET name = ?,
                prompt = ?,
                catalogjson = ?,
                rulesjson = ?
          WHERE id = ?
        RETURNING *`,
        [nextName, nextPrompt, nextCatalogJson, nextRulesJson, id],
      );
      return result.rows?.[0] ? normalizeRowKeys(result.rows[0]) : null;
    },
  };
}

export { dashboardDb };
