import { db } from "../db.js";

// ================= SESSION LOCK =================
// Serializa mensajes del mismo usuario para evitar race conditions
const _sessionLocks = new Map();

export async function withUserLock(from, fn) {
  while (_sessionLocks.has(from)) {
    await _sessionLocks.get(from);
  }
  let release;
  const lock = new Promise((r) => { release = r; });
  _sessionLocks.set(from, lock);
  try {
    return await fn();
  } finally {
    _sessionLocks.delete(from);
    release();
  }
}

// ================= SESSION =================
export async function getSession(from) {
  const r = await db.prepare(`SELECT * FROM sessions WHERE fromNumber=?`).get(from);

  const base = {
    companyId: "babystepsbots",
    aiMode: "off",
    aiCount: 0,
    aiCountDate: "",
    aiHistory: [],
    lastAiAt: 0,
    humanNotified: false,
  };

  if (!r) return { fromNumber: from, state: "MENU", cart: [], data: base, lastOrderId: null };

  return {
    fromNumber: from,
    state: r.state || "MENU",
    cart: JSON.parse(r.cartJson || "[]"),
    data: { ...base, ...(JSON.parse(r.dataJson || "{}") || {}) },
    lastOrderId: r.lastOrderId || null,
  };
}

export async function saveSession(s) {
  await db.prepare(`
    INSERT INTO sessions(fromNumber,state,cartJson,dataJson,lastOrderId)
    VALUES (?,?,?,?,?)
    ON CONFLICT(fromNumber) DO UPDATE SET
      state=excluded.state,
      cartJson=excluded.cartJson,
      dataJson=excluded.dataJson,
      lastOrderId=excluded.lastOrderId
  `).run(
    s.fromNumber,
    s.state,
    JSON.stringify(s.cart || []),
    JSON.stringify(s.data || {}),
    s.lastOrderId || null
  );
}
