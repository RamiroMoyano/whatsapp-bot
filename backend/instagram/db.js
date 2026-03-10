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

function parseJsonSafe(raw, fallback = {}) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

export async function initInstagramDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ig_sessions (
      ig_user_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'MENU',
      data_json TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ig_messages (
      id BIGSERIAL PRIMARY KEY,
      ig_user_id TEXT NOT NULL,
      ig_business_id TEXT,
      company_id TEXT,
      direction TEXT NOT NULL,
      content TEXT,
      meta_message_id TEXT,
      event_time TIMESTAMPTZ,
      raw_payload TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_ig_sessions_updated ON ig_sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ig_messages_user_created ON ig_messages(ig_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ig_messages_company_created ON ig_messages(company_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_messages_meta_mid_unique ON ig_messages(meta_message_id) WHERE meta_message_id IS NOT NULL;
  `);
}

export async function getIgSession(igUserId) {
  const id = String(igUserId || "").trim();
  if (!id) return null;
  const res = await pool.query(
    `SELECT ig_user_id, state, data_json, updated_at
     FROM ig_sessions
     WHERE ig_user_id=$1`,
    [id]
  );
  const row = res.rows?.[0];
  if (!row) return null;
  return {
    igUserId: String(row.ig_user_id || ""),
    state: String(row.state || "MENU"),
    data: parseJsonSafe(row.data_json || "{}", {}),
    updatedAt: row.updated_at || null,
  };
}

export async function saveIgSession(session) {
  const igUserId = String(session?.igUserId || "").trim();
  if (!igUserId) return;
  const state = String(session?.state || "MENU").trim() || "MENU";
  const dataJson = JSON.stringify(session?.data && typeof session.data === "object" ? session.data : {});
  await pool.query(
    `INSERT INTO ig_sessions(ig_user_id, state, data_json, updated_at)
     VALUES($1,$2,$3,NOW())
     ON CONFLICT (ig_user_id) DO UPDATE SET
       state=EXCLUDED.state,
       data_json=EXCLUDED.data_json,
       updated_at=EXCLUDED.updated_at`,
    [igUserId, state, dataJson]
  );
}

export async function hasMetaMessage(mid) {
  const metaMessageId = String(mid || "").trim();
  if (!metaMessageId) return false;
  const res = await pool.query(
    `SELECT 1 AS ok FROM ig_messages WHERE meta_message_id=$1 LIMIT 1`,
    [metaMessageId]
  );
  return !!res.rows?.length;
}

export async function logIgMessage({
  igUserId,
  igBusinessId = "",
  companyId = "",
  direction = "in",
  content = "",
  metaMessageId = "",
  eventTime = null,
  rawPayload = null,
}) {
  const userId = String(igUserId || "").trim();
  if (!userId) return;
  const dir = String(direction || "").trim().toLowerCase() === "out" ? "out" : "in";
  const payloadText = rawPayload == null
    ? null
    : typeof rawPayload === "string"
      ? rawPayload
      : JSON.stringify(rawPayload);
  await pool.query(
    `INSERT INTO ig_messages(
      ig_user_id, ig_business_id, company_id, direction, content, meta_message_id, event_time, raw_payload, created_at
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      userId,
      String(igBusinessId || "").trim() || null,
      String(companyId || "").trim() || null,
      dir,
      String(content || "").trim() || null,
      String(metaMessageId || "").trim() || null,
      eventTime || null,
      payloadText,
    ]
  );
}

export async function getCompany(companyIdRaw) {
  const companyId = String(companyIdRaw || "").trim().toLowerCase();
  if (!companyId) return null;
  const res = await pool.query(
    `SELECT id, name, prompt, catalogJson, rulesJson
     FROM companies
     WHERE id=$1
     LIMIT 1`,
    [companyId]
  );
  const row = res.rows?.[0];
  if (!row) return null;

  const catalog = Array.isArray(parseJsonSafe(row.catalogjson || "[]", []))
    ? parseJsonSafe(row.catalogjson || "[]", [])
    : [];
  const rules = parseJsonSafe(row.rulesjson || "{}", {});

  return {
    id: String(row.id || ""),
    name: String(row.name || row.id || "").trim() || "Empresa",
    prompt: String(row.prompt || "").trim(),
    catalog,
    rules,
  };
}

