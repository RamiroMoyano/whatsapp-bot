import fetch from "node-fetch";
import { normalizeIntegrationPayload } from "./normalize.js";

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildHeaders(config = {}, secrets = {}) {
  const headers = isObject(config.headers) ? { ...config.headers } : {};
  const authType = String(config.authType || "none").trim().toLowerCase();
  const token = String(secrets.token || "").trim();
  if (!token) return headers;

  if (authType === "bearer") {
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  if (authType === "header") {
    const headerName = String(config.authHeaderName || "x-api-key").trim() || "x-api-key";
    headers[headerName] = token;
  }

  return headers;
}

function buildUrl(config = {}) {
  const baseUrl = String(config.baseUrl || "").trim();
  const path = String(config.path || "").trim();
  if (!baseUrl) throw new Error("Falta baseUrl en la integracion");
  if (!path) throw new Error("Falta path en la integracion");
  return new URL(path, baseUrl).toString();
}

export async function runCustomApiIntegration(integration, options = {}) {
  const config = integration?.config && typeof integration.config === "object" ? integration.config : {};
  const secrets = integration?.secrets && typeof integration.secrets === "object" ? integration.secrets : {};
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs || config.timeoutMs || 10000)));
  const method = String(config.method || "GET").trim().toUpperCase();
  const headers = buildHeaders(config, secrets);
  const bodyPayload = isObject(config.bodyJson) || Array.isArray(config.bodyJson) ? config.bodyJson : null;
  const requestOptions = {
    method,
    headers,
  };

  if (bodyPayload !== null && method !== "GET" && method !== "HEAD") {
    if (!requestOptions.headers["Content-Type"] && !requestOptions.headers["content-type"]) {
      requestOptions.headers["Content-Type"] = "application/json";
    }
    requestOptions.body = JSON.stringify(bodyPayload);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildUrl(config), {
      ...requestOptions,
      signal: controller.signal,
    });
    const rawText = await response.text();
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { alerts: [rawText || "La API respondio sin contenido util."] };
    }

    if (!response.ok) {
      const message = isObject(payload) && payload.error
        ? String(payload.error)
        : `HTTP ${response.status}`;
      throw new Error(message);
    }

    return normalizeIntegrationPayload(payload, { source: "custom_api" });
  } finally {
    clearTimeout(timer);
  }
}

