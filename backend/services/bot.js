/**
 * Pure bot-logic helpers extracted from index.js so they can be unit-tested
 * without spinning up the full server or touching the database.
 */
import { parseJsonSafe } from "./utils.js";

// ─── Subscription ────────────────────────────────────────────────────────────

export function isSubscriptionActive(company) {
  const id = String(company?.id || "").toLowerCase();
  if (!id || id === "babystepsbots") return true;
  const rules = parseJsonSafe(company?.rulesJson || "{}", {});
  const status = String(rules?.subscriptionStatus || "Activa").trim().toLowerCase();
  const inactive = ["inactiva", "cancelada", "suspendida", "inactive", "cancelled", "canceled", "suspended"].includes(status);
  if (inactive) return false;
  const endAt = rules?.subscriptionCurrentEnd;
  if (endAt) {
    const endDate = new Date(endAt);
    if (!isNaN(endDate.getTime()) && endDate < new Date()) return false;
  }
  return true;
}

// ─── Rate limiting (per-customer, per-company, in-memory) ────────────────────

export const _rlMap = new Map(); // key "companyId:from" → { count, windowStart }
export const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function checkRateLimit(companyId, from, limitPerHour) {
  const limit = Math.max(1, Number(limitPerHour) || 0);
  if (!limit) return { ok: true, count: 0 }; // 0 = disabled
  const key = `${companyId}:${from}`;
  const now = Date.now();
  const entry = _rlMap.get(key);
  if (!entry || now - entry.windowStart >= RL_WINDOW_MS) {
    _rlMap.set(key, { count: 1, windowStart: now });
    return { ok: true, count: 1, remaining: limit - 1 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    const resetIn = Math.ceil((entry.windowStart + RL_WINDOW_MS - now) / 60000);
    return { ok: false, count: entry.count, resetInMinutes: resetIn };
  }
  return { ok: true, count: entry.count, remaining: limit - entry.count };
}

// ─── Business hours ──────────────────────────────────────────────────────────

export function isWithinBusinessHours(company) {
  const rules = parseJsonSafe(company?.rulesJson || "{}", {});
  if (!rules.businessHoursEnabled) return true;

  const tz = String(rules.businessHoursTz || "America/Argentina/Buenos_Aires").trim();
  const startStr = String(rules.businessHoursStart || "00:00").trim();
  const endStr = String(rules.businessHoursEnd || "23:59").trim();
  const enabledDays = Array.isArray(rules.businessHoursDays)
    ? rules.businessHoursDays.map(Number)
    : [0, 1, 2, 3, 4, 5, 6];

  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const weekdayStr = (parts.find((p) => p.type === "weekday")?.value || "").toLowerCase().slice(0, 3);
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const current = hour * 60 + minute;

    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    const start = (sh || 0) * 60 + (sm || 0);
    const end = (eh || 0) * 60 + (em || 0);

    if (!enabledDays.includes(dayOfWeek)) return false;
    if (current < start || current >= end) return false;
    return true;
  } catch {
    return true; // on error, don't block
  }
}

// ─── FAQ matching ─────────────────────────────────────────────────────────────

export function findFaqMatch(text, faqItems) {
  if (!Array.isArray(faqItems) || !faqItems.length) return null;
  const msgLower = String(text || "").toLowerCase();
  for (const item of faqItems) {
    const q = String(item.question || "").toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) continue;
    const matches = words.filter((w) => msgLower.includes(w));
    if (matches.length >= Math.ceil(words.length * 0.5)) {
      const answer = String(item.answer || "").trim();
      if (answer) return answer;
    }
  }
  return null;
}
