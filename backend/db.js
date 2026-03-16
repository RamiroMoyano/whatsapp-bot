import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  throw new Error("Falta DATABASE_URL para conectar a Postgres");
}

const ssl = String(process.env.PGSSLMODE || "").toLowerCase() === "disable"
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
});

const ROW_KEY_MAP = {
  fromnumber: "fromNumber",
  companyid: "companyId",
  orderid: "orderId",
  direction: "direction",
  mediaurl: "mediaUrl",
  mediacontenttype: "mediaContentType",
  twiliosid: "twilioSid",
  createdat: "createdAt",
  updatedat: "updatedAt",
  catalogjson: "catalogJson",
  rulesjson: "rulesJson",
  configjson: "configJson",
  secretsjson: "secretsJson",
  cartjson: "cartJson",
  datajson: "dataJson",
  lastorderid: "lastOrderId",
  itemsjson: "itemsJson",
  itemsdetailedjson: "itemsDetailedJson",
  paymentstatus: "paymentStatus",
  paymentmethod: "paymentMethod",
  orderstatus: "orderStatus",
  deliveredat: "deliveredAt",
  workflowstate: "workflowState",
  archivedat: "archivedAt",
  archivereason: "archiveReason",
};

function normalizeRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const [rawKey, value] of Object.entries(row)) {
    const mapped = ROW_KEY_MAP[String(rawKey || "").toLowerCase()];
    if (mapped && out[mapped] === undefined) {
      out[mapped] = value;
    }
  }
  return out;
}

function toPgSql(sql) {
  let idx = 0;
  return String(sql || "").replace(/\?/g, () => `$${++idx}`);
}

async function query(sql, params = []) {
  const finalSql = toPgSql(sql);
  return pool.query(finalSql, params);
}

export const db = {
  async exec(sql) {
    await pool.query(sql);
  },
  prepare(sql) {
    return {
      async get(...params) {
        const res = await query(sql, params);
        return normalizeRow(res.rows[0]);
      },
      async all(...params) {
        const res = await query(sql, params);
        return Array.isArray(res.rows) ? res.rows.map(normalizeRow) : [];
      },
      async run(...params) {
        const res = await query(sql, params);
        return { changes: res.rowCount || 0 };
      },
    };
  },
};

export async function initDb() {
  await db.exec(`
CREATE TABLE IF NOT EXISTS customer_company (
  fromNumber TEXT PRIMARY KEY,
  companyId TEXT NOT NULL,
  updatedAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  createdAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGSERIAL PRIMARY KEY,
  fromNumber TEXT,
  companyId TEXT,
  orderId TEXT,
  direction TEXT,
  role TEXT,
  content TEXT,
  mediaUrl TEXT,
  mediaContentType TEXT,
  twilioSid TEXT,
  createdAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  prompt TEXT,
  catalogJson TEXT,
  rulesJson TEXT,
  createdAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS company_integrations (
  id TEXT PRIMARY KEY,
  companyId TEXT NOT NULL,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  configJson TEXT NOT NULL DEFAULT '{}',
  secretsJson TEXT NOT NULL DEFAULT '{}',
  createdAt TIMESTAMPTZ,
  updatedAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT,
  cartJson TEXT,
  dataJson TEXT,
  lastOrderId TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TIMESTAMPTZ,
  fromNumber TEXT,
  companyId TEXT,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT,
  itemsDetailedJson TEXT,
  total DOUBLE PRECISION,
  paymentStatus TEXT,
  paymentMethod TEXT,
  orderStatus TEXT,
  deliveredAt TIMESTAMPTZ,
  category TEXT,
  workflowState TEXT,
  archived BOOLEAN DEFAULT FALSE,
  archivedAt TIMESTAMPTZ,
  archiveReason TEXT
);
  `);

  await db.exec(`
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS companyId TEXT;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS orderId TEXT;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS direction TEXT;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS mediaUrl TEXT;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS mediaContentType TEXT;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS twilioSid TEXT;
    CREATE INDEX IF NOT EXISTS idx_ai_messages_company_created ON ai_messages(companyId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_from_created ON ai_messages(fromNumber, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_order_created ON ai_messages(orderId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_company_order_created ON ai_messages(companyId, orderId, createdAt DESC);
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_company_integrations_company ON company_integrations(companyId);
    CREATE INDEX IF NOT EXISTS idx_company_integrations_company_enabled ON company_integrations(companyId, enabled);
  `);

  await db.exec(`
    INSERT INTO companies(id,name,prompt,catalogJson,rulesJson,createdAt)
    VALUES
      (
        'babystepsbots',
        'Babystepsbots',
        'Sos el asistente comercial de Babystepsbots. Español Argentina, claro, directo, vendedor.',
        '[{"id":1,"name":"Bot WhatsApp","price":120},{"id":2,"name":"Bot Instagram","price":100},{"id":3,"name":"Bot Unificado","price":200}]',
        '{"tone":"comercial","allowHuman":true}',
        NOW()
      ),
      (
        'veterinaria_sm',
        'Veterinaria San Miguel',
        'Sos asistente de una veterinaria. Empático, calmado, priorizás urgencias.',
        '[{"id":1,"name":"Consulta","price":5000},{"id":2,"name":"Vacunación","price":8000}]',
        '{"tone":"empatico","emergencyKeywords":["urgente","accidente"],"allowHuman":true}',
        NOW()
      )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      prompt = CASE
        WHEN companies.prompt IS NULL OR btrim(companies.prompt) = '' THEN EXCLUDED.prompt
        ELSE companies.prompt
      END,
      catalogJson = CASE
        WHEN companies.catalogJson IS NULL OR btrim(companies.catalogJson) = '' OR btrim(companies.catalogJson) = '[]'
          THEN EXCLUDED.catalogJson
        ELSE companies.catalogJson
      END,
      rulesJson = CASE
        WHEN companies.rulesJson IS NULL OR btrim(companies.rulesJson) = '' OR btrim(companies.rulesJson) = '{}'
          THEN EXCLUDED.rulesJson
        ELSE companies.rulesJson
      END;
  `);
}
