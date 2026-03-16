import { runCustomApiIntegration } from "./custom-api.js";

export const integrationRegistry = {
  custom_api: runCustomApiIntegration,
};

export function getIntegrationRunner(providerRaw) {
  const provider = String(providerRaw || "").trim().toLowerCase();
  return integrationRegistry[provider] || null;
}

