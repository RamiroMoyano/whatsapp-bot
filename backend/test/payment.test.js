import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePaymentMethodInput,
  paymentMethodLabel,
  extractCompanyPaymentConfig,
  extractCheckoutFieldsFromText,
} from "../services/payment.js";

describe("normalizePaymentMethodInput", () => {
  test("detects transferencia variants", () => {
    assert.equal(normalizePaymentMethodInput("transferencia"), "transferencia");
    assert.equal(normalizePaymentMethodInput("transfer"), "transferencia");
    assert.equal(normalizePaymentMethodInput("banco"), "transferencia");
    assert.equal(normalizePaymentMethodInput("por CBU"), "transferencia");
  });
  test("detects debito", () => {
    assert.equal(normalizePaymentMethodInput("debito"), "debito");
    assert.equal(normalizePaymentMethodInput("débito"), "debito");
  });
  test("detects tarjeta/credito", () => {
    assert.equal(normalizePaymentMethodInput("tarjeta"), "tarjeta");
    assert.equal(normalizePaymentMethodInput("crédito"), "tarjeta");
    assert.equal(normalizePaymentMethodInput("credit card"), "tarjeta");
  });
  test("detects efectivo", () => {
    assert.equal(normalizePaymentMethodInput("efectivo"), "efectivo");
    assert.equal(normalizePaymentMethodInput("cash"), "efectivo");
  });
  test("returns empty string for unknown input", () => {
    assert.equal(normalizePaymentMethodInput("pizza"), "");
    assert.equal(normalizePaymentMethodInput(""), "");
  });
});

describe("paymentMethodLabel", () => {
  test("maps to display labels", () => {
    assert.equal(paymentMethodLabel("transferencia"), "Transferencia");
    assert.equal(paymentMethodLabel("debito"), "Debito");
    assert.equal(paymentMethodLabel("efectivo"), "Efectivo");
    assert.equal(paymentMethodLabel("tarjeta"), "Tarjeta de credito");
  });
  test("unknown method returns default label", () => {
    assert.equal(paymentMethodLabel("something else"), "No definido");
  });
});

describe("extractCompanyPaymentConfig", () => {
  test("returns defaults for empty rules", () => {
    const cfg = extractCompanyPaymentConfig({});
    assert.equal(cfg.enabled.cash, false);
    assert.equal(cfg.enabled.transfer, false);
    assert.equal(typeof cfg.transfer, "object");
  });

  test("reads methods from paymentMethods object", () => {
    const cfg = extractCompanyPaymentConfig({
      paymentMethods: { cash: true, transfer: true },
    });
    assert.equal(cfg.enabled.cash, true);
    assert.equal(cfg.enabled.transfer, true);
    assert.equal(cfg.enabled.debit, false);
  });

  test("auto-enables transfer when CBU is present", () => {
    const cfg = extractCompanyPaymentConfig({
      paymentTransfer: { cbu: "0000003100001234567890" },
    });
    assert.equal(cfg.enabled.transfer, true);
    assert.equal(cfg.transfer.cbu, "0000003100001234567890");
  });

  test("merges legacy flat fields", () => {
    const cfg = extractCompanyPaymentConfig({
      paymentTransferAlias: "mi.alias",
      paymentTransferBankName: "Banco Galicia",
    });
    assert.equal(cfg.transfer.alias, "mi.alias");
    assert.equal(cfg.transfer.bankName, "Banco Galicia");
    assert.equal(cfg.enabled.transfer, true); // auto-enabled by alias
  });
});

describe("extractCheckoutFieldsFromText", () => {
  test("extracts payment method", () => {
    const r = extractCheckoutFieldsFromText("Quiero pagar con transferencia");
    assert.equal(r.paymentMethod, "transferencia");
  });

  test("extracts phone contact", () => {
    const r = extractCheckoutFieldsFromText("Juan Perez +5491123456789");
    assert.ok(r.contact.includes("5491123456789"));
  });

  test("extracts name (first non-reserved line)", () => {
    const r = extractCheckoutFieldsFromText("Maria García\ntransferencia");
    assert.ok(r.name.includes("Maria"));
  });

  test("returns empty fields for empty input", () => {
    const r = extractCheckoutFieldsFromText("");
    assert.equal(r.name, "");
    assert.equal(r.contact, "");
    assert.equal(r.paymentMethod, "");
  });
});
