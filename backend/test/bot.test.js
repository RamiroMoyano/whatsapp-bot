import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  findFaqMatch,
  isSubscriptionActive,
  checkRateLimit,
  isWithinBusinessHours,
  _rlMap,
} from "../services/bot.js";

// ─── findFaqMatch ─────────────────────────────────────────────────────────────

describe("findFaqMatch", () => {
  const faqs = [
    { question: "horario de atención", answer: "Lunes a viernes 9-18hs" },
    { question: "envíos a todo el país", answer: "Sí, enviamos a todo el país" },
    { question: "medios de pago aceptados", answer: "Efectivo y transferencia" },
  ];

  test("exact match returns answer", () => {
    assert.equal(findFaqMatch("horario de atención", faqs), "Lunes a viernes 9-18hs");
  });

  test("partial keyword match (≥50% of words) returns answer", () => {
    // "horario" alone (1/3 words) → below threshold, but "horario atención" (2/3) → match
    assert.equal(findFaqMatch("cual es el horario y atención", faqs), "Lunes a viernes 9-18hs");
  });

  test("no match returns null", () => {
    assert.equal(findFaqMatch("pizza con extra queso", faqs), null);
  });

  test("empty faqItems returns null", () => {
    assert.equal(findFaqMatch("horario", []), null);
  });

  test("null/undefined faqItems returns null", () => {
    assert.equal(findFaqMatch("horario", null), null);
    assert.equal(findFaqMatch("horario", undefined), null);
  });

  test("faq item with no answer is skipped", () => {
    const noAnswer = [{ question: "horario de atención", answer: "" }];
    assert.equal(findFaqMatch("horario de atención", noAnswer), null);
  });

  test("case-insensitive matching", () => {
    assert.equal(findFaqMatch("HORARIO DE ATENCIÓN", faqs), "Lunes a viernes 9-18hs");
  });
});

// ─── isSubscriptionActive ────────────────────────────────────────────────────

describe("isSubscriptionActive", () => {
  test("babystepsbots provider is always active", () => {
    assert.equal(isSubscriptionActive({ id: "babystepsbots" }), true);
  });

  test("empty id is treated as provider (always active)", () => {
    assert.equal(isSubscriptionActive({ id: "" }), true);
  });

  test("active status returns true", () => {
    assert.equal(
      isSubscriptionActive({
        id: "empresa1",
        rulesJson: JSON.stringify({ subscriptionStatus: "Activa" }),
      }),
      true
    );
  });

  test("inactive status returns false", () => {
    for (const status of ["Inactiva", "Cancelada", "Suspendida", "cancelled"]) {
      assert.equal(
        isSubscriptionActive({
          id: "empresa1",
          rulesJson: JSON.stringify({ subscriptionStatus: status }),
        }),
        false,
        `Expected false for status "${status}"`
      );
    }
  });

  test("expired subscriptionCurrentEnd returns false", () => {
    assert.equal(
      isSubscriptionActive({
        id: "empresa1",
        rulesJson: JSON.stringify({ subscriptionCurrentEnd: "2020-01-01T00:00:00Z" }),
      }),
      false
    );
  });

  test("future subscriptionCurrentEnd returns true", () => {
    assert.equal(
      isSubscriptionActive({
        id: "empresa1",
        rulesJson: JSON.stringify({ subscriptionCurrentEnd: "2099-01-01T00:00:00Z" }),
      }),
      true
    );
  });

  test("missing rulesJson defaults to active", () => {
    assert.equal(isSubscriptionActive({ id: "empresa1" }), true);
  });
});

// ─── checkRateLimit ──────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  beforeEach(() => {
    _rlMap.clear();
  });

  test("first message is always allowed", () => {
    const r = checkRateLimit("emp1", "+549111", 10);
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  test("stays under limit returns ok=true", () => {
    checkRateLimit("emp1", "+549111", 3);
    checkRateLimit("emp1", "+549111", 3);
    const r = checkRateLimit("emp1", "+549111", 3);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
  });

  test("exceeds limit returns ok=false", () => {
    checkRateLimit("emp1", "+549111", 2);
    checkRateLimit("emp1", "+549111", 2);
    const r = checkRateLimit("emp1", "+549111", 2);
    assert.equal(r.ok, false);
    assert.ok(typeof r.resetInMinutes === "number");
  });

  test("different companies are counted separately", () => {
    checkRateLimit("emp1", "+549111", 1);
    const r = checkRateLimit("emp2", "+549111", 1);
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  test("different customers in same company are counted separately", () => {
    checkRateLimit("emp1", "+549111", 1);
    const r = checkRateLimit("emp1", "+549222", 1);
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  test("limitPerHour=0 coerces to limit=1 (Math.max(1,0))", () => {
    // passing 0 does NOT disable — Math.max(1,0) clamps to 1 msg/hr
    const first = checkRateLimit("emp1", "+549111", 0);
    assert.equal(first.ok, true);
    const second = checkRateLimit("emp1", "+549111", 0);
    assert.equal(second.ok, false);
  });
});

// ─── isWithinBusinessHours ───────────────────────────────────────────────────

describe("isWithinBusinessHours", () => {
  test("returns true when businessHoursEnabled is false/missing", () => {
    assert.equal(isWithinBusinessHours({ rulesJson: "{}" }), true);
    assert.equal(isWithinBusinessHours({}), true);
  });

  test("returns true when all days are enabled and window is 00:00-23:59", () => {
    const rulesJson = JSON.stringify({
      businessHoursEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessHoursDays: [0, 1, 2, 3, 4, 5, 6],
      businessHoursTz: "America/Argentina/Buenos_Aires",
    });
    assert.equal(isWithinBusinessHours({ rulesJson }), true);
  });

  test("returns false when today's day is not in enabledDays", () => {
    // Use only day 8 (invalid), so no real day matches
    const rulesJson = JSON.stringify({
      businessHoursEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessHoursDays: [8], // no valid day
      businessHoursTz: "America/Argentina/Buenos_Aires",
    });
    assert.equal(isWithinBusinessHours({ rulesJson }), false);
  });

  test("returns true on parse error (fail-open)", () => {
    // Invalid timezone triggers the catch → returns true
    const rulesJson = JSON.stringify({
      businessHoursEnabled: true,
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessHoursDays: [0, 1, 2, 3, 4, 5, 6],
      businessHoursTz: "Not/ATimezone",
    });
    assert.equal(isWithinBusinessHours({ rulesJson }), true);
  });
});
