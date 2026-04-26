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
    const v = value instanceof Date ? value.toISOString() : value;
    if (key === "rulesjson") out.rulesJson = v;
    else if (key === "catalogjson") out.catalogJson = v;
    else if (key === "createdat") out.createdAt = v;
    else if (key === "updatedat") out.updatedAt = v;
    else if (key === "companyid") out.companyId = v;
    else out[key] = v;
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
    getCompanyOrders: unavailable,
    saveCompanyById: unavailable,
    getAssignments: unavailable,
    saveAssignment: unavailable,
    deleteAssignment: unavailable,
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
    async getCompanyOrders(companyId, options = {}) {
      const normalizedCompanyId = String(companyId || "").trim();
      if (!normalizedCompanyId) return [];
      const filterFrom = options.from ? new Date(options.from) : null;
      const filterTo = options.to ? new Date(options.to) : null;
      const limit = Math.max(1, Math.min(5000, Number(options.limit) || 500));
      const clauses = [`companyid = ?`];
      const params = [normalizedCompanyId];
      if (filterFrom && !Number.isNaN(filterFrom.getTime())) {
        clauses.push(`createdat >= ?`);
        params.push(filterFrom.toISOString());
      }
      if (filterTo && !Number.isNaN(filterTo.getTime())) {
        clauses.push(`createdat <= ?`);
        params.push(filterTo.toISOString());
      }
      params.push(limit);
      const result = await query(
        `SELECT
            id,
            createdat AS "createdAt",
            fromnumber AS "fromNumber",
            companyid AS "companyId",
            name,
            contact,
            notes,
            itemsjson AS "itemsJson",
            itemsdetailedjson AS "itemsDetailedJson",
            total,
            paymentstatus AS "paymentStatus",
            paymentmethod AS "paymentMethod",
            orderstatus AS "orderStatus",
            deliveredat AS "deliveredAt",
            category,
            workflowstate AS "workflowState",
            archived,
            archivedat AS "archivedAt",
            archivereason AS "archiveReason"
           FROM orders
          WHERE ${clauses.join(" AND ")}
          ORDER BY createdat DESC
          LIMIT ?`,
        params,
      );
      return Array.isArray(result.rows) ? result.rows.map(normalizeRowKeys) : [];
    },
    async getAllOrders(options = {}) {
      const q = String(options.q || "").trim().toLowerCase();
      const filterCompanyId = String(options.companyId || "").trim();
      const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
      const clauses = [];
      const params = [];
      if (filterCompanyId) {
        clauses.push(`companyid = ?`);
        params.push(filterCompanyId);
      }
      if (q) {
        clauses.push(`(LOWER(id) LIKE ? OR LOWER(fromnumber) LIKE ? OR LOWER(name) LIKE ? OR LOWER(contact) LIKE ?)`);
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      params.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const result = await query(
        `SELECT
            id,
            createdat AS "createdAt",
            fromnumber AS "fromNumber",
            companyid AS "companyId",
            name,
            contact,
            total,
            paymentstatus AS "paymentStatus",
            paymentmethod AS "paymentMethod",
            orderstatus AS "orderStatus"
           FROM orders
          ${where}
          ORDER BY createdat DESC
          LIMIT ?`,
        params,
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
    async getAssignments() {
      const result = await query(
        `SELECT
            fromnumber AS "fromNumber",
            companyid AS "companyId",
            updatedat AS "updatedAt"
           FROM customer_company
          ORDER BY updatedat DESC, fromnumber ASC`,
      );
      return Array.isArray(result.rows) ? result.rows.map(normalizeRowKeys) : [];
    },
    async saveAssignment(fromNumber, companyId) {
      const normalizedFrom = String(fromNumber || "").trim();
      const normalizedCompanyId = String(companyId || "").trim();
      if (!normalizedFrom) throw new Error("fromNumber requerido");
      if (!normalizedCompanyId) throw new Error("companyId requerido");
      await query(
        `INSERT INTO customer_company(fromnumber, companyid, updatedat)
         VALUES (?, ?, NOW())
         ON CONFLICT(fromnumber) DO UPDATE SET
           companyid = EXCLUDED.companyid,
           updatedat = EXCLUDED.updatedat`,
        [normalizedFrom, normalizedCompanyId],
      );
      const result = await query(
        `SELECT
            fromnumber AS "fromNumber",
            companyid AS "companyId",
            updatedat AS "updatedAt"
           FROM customer_company
          WHERE fromnumber = ?
          LIMIT 1`,
        [normalizedFrom],
      );
      return result.rows?.[0] ? normalizeRowKeys(result.rows[0]) : null;
    },
    async deleteAssignment(fromNumber) {
      const normalizedFrom = String(fromNumber || "").trim();
      if (!normalizedFrom) throw new Error("fromNumber requerido");
      await query(`DELETE FROM customer_company WHERE fromnumber = ?`, [normalizedFrom]);
    },
  };
}

export { dashboardDb };
