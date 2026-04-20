import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonSafe,
  normalizeTextForMatch,
  normalizeWhatsappFromNumber,
  formatChatMoney,
  roundMoney,
  isReserved,
  isHumanTrigger,
} from "../services/utils.js";

describe("parseJsonSafe", () => {
  test("returns parsed object", () => {
    assert.deepEqual(parseJsonSafe('{"a":1}', {}), { a: 1 });
  });
  test("returns fallback on invalid JSON", () => {
    assert.deepEqual(parseJsonSafe("not-json", { fallback: true }), { fallback: true });
  });
  test("returns fallback on null input", () => {
    assert.deepEqual(parseJsonSafe(null, []), []);
  });
  test("returns fallback on empty string", () => {
    assert.deepEqual(parseJsonSafe("", 42), 42);
  });
});

describe("normalizeTextForMatch", () => {
  test("lowercases", () => {
    assert.equal(normalizeTextForMatch("HOLA"), "hola");
  });
  test("strips accents", () => {
    assert.equal(normalizeTextForMatch("catálogo"), "catalogo");
    assert.equal(normalizeTextForMatch("Ñoño"), "nono");
  });
  test("handles empty / null", () => {
    assert.equal(normalizeTextForMatch(""), "");
    assert.equal(normalizeTextForMatch(null), "");
  });
});

describe("normalizeWhatsappFromNumber", () => {
  test("strips whatsapp: prefix and normalizes", () => {
    assert.equal(
      normalizeWhatsappFromNumber("whatsapp:+5491112345678"),
      "whatsapp:+5491112345678"
    );
  });
  test("adds whatsapp: prefix to bare number with plus", () => {
    assert.equal(
      normalizeWhatsappFromNumber("+5491112345678"),
      "whatsapp:+5491112345678"
    );
  });
  test("adds + when missing", () => {
    assert.equal(
      normalizeWhatsappFromNumber("5491112345678"),
      "whatsapp:+5491112345678"
    );
  });
  test("returns empty string for empty input", () => {
    assert.equal(normalizeWhatsappFromNumber(""), "");
  });
  test("preserves 'unknown' as-is", () => {
    assert.equal(normalizeWhatsappFromNumber("unknown"), "unknown");
  });
});

describe("roundMoney", () => {
  test("rounds to 2 decimal places", () => {
    assert.equal(roundMoney(1.125), 1.13);
    assert.equal(roundMoney(10.999), 11);
    assert.equal(roundMoney(0.1 + 0.2), 0.3); // classic float
  });
  test("returns 0 for non-finite input", () => {
    assert.equal(roundMoney(NaN), 0);
    assert.equal(roundMoney(Infinity), 0);
  });
  test("handles zero", () => {
    assert.equal(roundMoney(0), 0);
  });
});

describe("formatChatMoney", () => {
  test("formats ARS amount as string", () => {
    const result = formatChatMoney(1000, "ARS");
    assert.equal(typeof result, "string");
    assert.ok(result.includes("1"), "should include '1'");
  });
  test("handles non-finite values", () => {
    const result = formatChatMoney(NaN, "USD");
    assert.ok(result.includes("0"));
  });
  test("falls back for unsupported currency code", () => {
    const result = formatChatMoney(50, "XXX");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("50"));
  });
});

describe("isReserved", () => {
  test("known reserved words return true", () => {
    assert.equal(isReserved("menu"), true);
    assert.equal(isReserved("catalogo"), true);
    assert.equal(isReserved("checkout"), true);
    assert.equal(isReserved("carrito"), true);
    assert.equal(isReserved("humano"), true);
  });
  test("unknown words return false", () => {
    assert.equal(isReserved("pizza"), false);
    assert.equal(isReserved(""), false);
  });
});

describe("isHumanTrigger", () => {
  test("trigger words return true", () => {
    assert.equal(isHumanTrigger("humano"), true);
    assert.equal(isHumanTrigger("asesor"), true);
    assert.equal(isHumanTrigger("hablar con humano"), true);
  });
  test("non-trigger words return false", () => {
    assert.equal(isHumanTrigger("menu"), false);
    assert.equal(isHumanTrigger(""), false);
  });
});
