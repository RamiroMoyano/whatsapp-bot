import express from "express";
import { db } from "../db.js";
import { parseJsonSafe, normalizeWhatsappFromNumber } from "../services/utils.js";
import { normalizePaymentStatusInput, isPaidStatusValue } from "../services/payment.js";
import { normalizeCatalogEntries } from "../services/catalog.js";
import {
  normalizeOrderWorkflowState,
  normalizeArchivedFlag,
  deriveOrderWorkflowFromRow,
  normalizeOrderRow,
  parseLegacyOrderCategory,
} from "../services/order.js";
import {
  createIntegrationId,
  loadCompanyIntegration,
  loadCompanyIntegrations,
} from "../integrations/load-company-integrations.js";
import { getIntegrationRunner } from "../integrations/registry.js";

const API_TOKEN = (process.env.API_TOKEN || "").trim();
const ADMIN_COMPANY_LIST_CACHE_TTL_MS = Number(process.env.ADMIN_COMPANY_LIST_CACHE_TTL_MS || 180000);

function requireApiAuth(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: "API_TOKEN no configurado" });
  const h = req.headers.authorization || "";
  if (h !== `Bearer ${API_TOKEN}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

let adminCompanyListCache = { items: [], updatedAt: 0 };

function invalidateAdminCompanyListCache() {
  adminCompanyListCache = { items: [], updatedAt: 0 };
}

function hasFreshAdminCompanyListCache() {
  return (
    adminCompanyListCache.items.length > 0 &&
    Date.now() - adminCompanyListCache.updatedAt <= ADMIN_COMPANY_LIST_CACHE_TTL_MS
  );
}

async function fetchAdminCompanyListCached({ allowStale = true } = {}) {
  if (hasFreshAdminCompanyListCache()) {
    return adminCompanyListCache.items;
  }
  try {
    const rows = await db
      .prepare(`SELECT id, name, createdAt, rulesJson FROM companies ORDER BY id`)
      .all();
    adminCompanyListCache = {
      items: Array.isArray(rows) ? rows : [],
      updatedAt: Date.now(),
    };
    return adminCompanyListCache.items;
  } catch (error) {
    if (allowStale && adminCompanyListCache.items.length > 0) {
      return adminCompanyListCache.items;
    }
    throw error;
  }
}

function ensureObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeIntegrationProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "custom_api" ? raw : "";
}

function sanitizeIntegrationForAdmin(integration) {
  if (!integration) return null;
  const secrets = ensureObject(integration.secrets, {});
  const config = ensureObject(integration.config, {});
  return {
    id: integration.id,
    companyId: integration.companyId,
    provider: integration.provider,
    name: integration.name,
    enabled: integration.enabled,
    configJson: integration.configJson || JSON.stringify(config),
    secretsJson: integration.secretsJson || JSON.stringify(secrets),
    config,
    secrets: {
      token: String(secrets.token || ""),
    },
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
  };
}

function sanitizeIntegrationForRender(module) {
  return {
    integrationId: String(module?.integrationId || ""),
    name: String(module?.name || ""),
    provider: String(module?.provider || ""),
    cards: Array.isArray(module?.cards) ? module.cards : [],
    alerts: Array.isArray(module?.alerts) ? module.alerts : [],
    table: module?.table && typeof module.table === "object" ? module.table : null,
    meta: module?.meta && typeof module.meta === "object" ? module.meta : {},
    error: module?.error ? String(module.error) : "",
  };
}

async function runIntegrationModule(integration) {
  const runner = getIntegrationRunner(integration?.provider);
  if (!runner) {
    throw new Error(`Provider no soportado: ${integration?.provider || "-"}`);
  }
  return runner(integration, { timeoutMs: 10000 });
}

function resolveStoredClientPassword(rules, company) {
  const candidates = [
    rules?.clientPassword,
    rules?.clientPass,
    rules?.password,
    rules?.pass,
    rules?.accessPassword,
    rules?.auth?.clientPassword,
    company?.clientPassword,
    company?.password,
  ];
  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function extractDashboardAccessForApi(rules) {
  const rawEnabled = String(rules?.dashboardEnabled ?? "").trim().toLowerCase();
  const enabled =
    rawEnabled === "" ? true : !["0", "false", "off", "disabled", "no"].includes(rawEnabled);
  const rawMode = String(rules?.dashboardMode || "").trim().toLowerCase();
  return {
    enabled,
    mode: rawMode === "limited" ? "limited" : "full",
  };
}

export default function createApiRouter({
  syncCompanySessionsAiMode,
  resolveBotCatalogForCompany,
  syncRulesSubscription,
  resetAiMemoryForMode,
  syncSessionAiModeFromCompany,
  BOT_CATALOG_PROVIDER_ID,
}) {
  const router = express.Router();

  // ===== API: Companies =====
  router.get("/api/admin-company-list", requireApiAuth, async (req, res) => {
    try {
      const rows = await fetchAdminCompanyListCached({ allowStale: true });
      res.set("Cache-Control", "no-store");
      res.json(rows);
    } catch (e) {
      res.status(503).json({ error: e?.message || String(e) });
    }
  });

  router.get("/api/companies", requireApiAuth, async (req, res) => {
    try {
      const rows = await db
        .prepare(
          `SELECT id,name,createdAt,prompt,catalogJson,rulesJson FROM companies ORDER BY id`
        )
        .all();
      res.set("Cache-Control", "no-store");
      res.json(rows);
    } catch (e) {
      res.status(503).json({ error: e?.message || String(e) });
    }
  });

  router.get("/api/companies/:id", requireApiAuth, async (req, res) => {
    try {
      const row = await db
        .prepare(`SELECT * FROM companies WHERE id=?`)
        .get(req.params.id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/companies", requireApiAuth, async (req, res) => {
    try {
      const id = String(req.body.id || "")
        .trim()
        .toLowerCase();
      const name = String(req.body.name || "").trim();
      if (!id.match(/^[a-z0-9_-]{3,40}$/))
        return res.status(400).json({ error: "ID invalido" });

      await db
        .prepare(
          `
        INSERT INTO companies(id,name,prompt,catalogJson,rulesJson,createdAt)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT (id) DO NOTHING
      `
        )
        .run(
          id,
          name || id,
          "Sos el asistente de la empresa. Respondes acorde al manual de marca.",
          "[]",
          JSON.stringify({ tone: "neutral", allowHuman: true }),
          new Date().toISOString()
        );

      invalidateAdminCompanyListCache();
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/companies/:id/save", requireApiAuth, async (req, res) => {
    const id = req.params.id;
    const name = String(req.body.name || "").trim();
    const prompt = String(req.body.prompt || "");
    const catalogJson = String(req.body.catalogJson || "[]");
    const rulesJson = String(req.body.rulesJson || "{}");

    let parsedCatalog;
    let parsedRules;
    try {
      parsedCatalog = JSON.parse(catalogJson);
      if (!Array.isArray(parsedCatalog)) throw new Error("catalogJson debe ser un array");
    } catch (e) {
      return res.status(400).json({ error: `Catalog JSON invalido: ${e.message}` });
    }

    try {
      parsedRules = JSON.parse(rulesJson);
      if (!parsedRules || Array.isArray(parsedRules) || typeof parsedRules !== "object") {
        throw new Error("rulesJson debe ser un objeto");
      }
    } catch (e) {
      return res.status(400).json({ error: `Rules JSON invalido: ${e.message}` });
    }

    const existing = await db
      .prepare(`SELECT rulesJson,catalogJson FROM companies WHERE id=?`)
      .get(id);
    const previousRules = parseJsonSafe(existing?.rulesJson || "{}", {});
    const previousOwnCatalog = normalizeCatalogEntries(
      parseJsonSafe(existing?.catalogJson || "[]", [])
    );
    const resolvedCatalog = await resolveBotCatalogForCompany(id, parsedCatalog);
    const nextCatalog = resolvedCatalog.catalogItems;
    const previousCatalog = id === BOT_CATALOG_PROVIDER_ID ? previousOwnCatalog : nextCatalog;
    const previousBotClass = String(previousRules?.botClass || "")
      .trim()
      .toLowerCase();
    const nextBotClass = String(parsedRules?.botClass || "")
      .trim()
      .toLowerCase();
    const triggerUpgrade = previousBotClass && nextBotClass && previousBotClass !== nextBotClass;

    const syncedRules = syncRulesSubscription({
      rules: parsedRules,
      catalogItems: nextCatalog,
      previousRules,
      previousCatalogItems: previousCatalog,
      now: new Date(),
      triggerUpgrade,
    });
    syncedRules.botCatalogProviderId = resolvedCatalog.sourceId;
    syncedRules.botCatalogProviderName = resolvedCatalog.sourceName;
    const finalRulesJson = JSON.stringify(syncedRules);

    await db
      .prepare(
        `UPDATE companies SET name=?, prompt=?, catalogJson=?, rulesJson=? WHERE id=?`
      )
      .run(name || id, prompt, catalogJson, finalRulesJson, id);

    invalidateAdminCompanyListCache();
    const syncResult = await syncCompanySessionsAiMode(id, syncedRules, { force: true });
    res.json({ ok: true, aiSync: syncResult });
  });

  router.post("/api/client-auth", requireApiAuth, async (req, res) => {
    try {
      const companyInput = String(
        req.body.companyId || req.body.companyInput || ""
      ).trim();
      const password = String(req.body.password || req.body.pass || "").trim();
      if (!companyInput || !password) {
        return res.status(400).json({ error: "Faltan datos" });
      }

      const lookup = companyInput.toLowerCase();
      let company = await db
        .prepare(
          `
        SELECT *
        FROM companies
        WHERE lower(id) = ? OR lower(name) = ?
        LIMIT 1
      `
        )
        .get(lookup, lookup);

      if (!company) {
        const cachedList = await fetchAdminCompanyListCached({ allowStale: true }).catch(
          () => []
        );
        const matched = (Array.isArray(cachedList) ? cachedList : []).find(
          (item) =>
            String(item?.id || "")
              .trim()
              .toLowerCase() === lookup ||
            String(item?.name || "")
              .trim()
              .toLowerCase() === lookup
        );
        if (matched?.id) {
          company = await db
            .prepare(`SELECT * FROM companies WHERE id=?`)
            .get(String(matched.id).trim());
        }
      }

      if (!company) {
        return res
          .status(401)
          .json({ error: "Empresa no encontrada o credenciales incorrectas" });
      }

      const rules = parseJsonSafe(company.rulesJson || "{}", {});
      const expected = resolveStoredClientPassword(rules, company);
      if (!expected) {
        return res
          .status(400)
          .json({ error: "La empresa no tiene password de cliente configurada" });
      }
      if (password !== expected) {
        return res.status(401).json({ error: "Credenciales incorrectas" });
      }

      const access = extractDashboardAccessForApi(rules);
      res.json({
        ok: true,
        companyId: String(company.id || "").trim(),
        companyName: String(company.name || company.id || "").trim(),
        access,
      });
    } catch (e) {
      res.status(503).json({ error: e?.message || String(e) });
    }
  });

  router.get("/api/companies/:id/integrations", requireApiAuth, async (req, res) => {
    try {
      const companyId = String(req.params.id || "").trim();
      const company = await db
        .prepare(`SELECT id FROM companies WHERE id=?`)
        .get(companyId);
      if (!company) return res.status(404).json({ error: "Empresa no encontrada" });
      const integrations = await loadCompanyIntegrations(companyId, {
        includeSecrets: true,
        includeDisabled: true,
      });
      res.json(integrations.map((item) => sanitizeIntegrationForAdmin(item)));
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/companies/:id/integrations", requireApiAuth, async (req, res) => {
    try {
      const companyId = String(req.params.id || "").trim();
      const company = await db
        .prepare(`SELECT id FROM companies WHERE id=?`)
        .get(companyId);
      if (!company) return res.status(404).json({ error: "Empresa no encontrada" });

      const provider = normalizeIntegrationProvider(req.body.provider || "custom_api");
      if (!provider) return res.status(400).json({ error: "Provider invalido" });

      const name = String(req.body.name || "").trim() || "Nueva integracion";
      const now = new Date().toISOString();
      const integrationId = createIntegrationId();
      await db
        .prepare(
          `
        INSERT INTO company_integrations(
          id, companyId, provider, name, enabled, configJson, secretsJson, createdAt, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `
        )
        .run(
          integrationId,
          companyId,
          provider,
          name,
          1,
          JSON.stringify({
            baseUrl: "",
            path: "",
            method: "GET",
            headers: {},
            authType: "none",
            authHeaderName: "x-api-key",
            bodyJson: {},
          }),
          JSON.stringify({ token: "" }),
          now,
          now
        );

      const created = await loadCompanyIntegration(companyId, integrationId, {
        includeSecrets: true,
      });
      res.json({ ok: true, integration: sanitizeIntegrationForAdmin(created) });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post(
    "/api/companies/:id/integrations/:integrationId/save",
    requireApiAuth,
    async (req, res) => {
      try {
        const companyId = String(req.params.id || "").trim();
        const integrationId = String(req.params.integrationId || "").trim();
        const existing = await loadCompanyIntegration(companyId, integrationId, {
          includeSecrets: true,
        });
        if (!existing) return res.status(404).json({ error: "Integracion no encontrada" });

        const provider = normalizeIntegrationProvider(
          req.body.provider || existing.provider
        );
        if (!provider) return res.status(400).json({ error: "Provider invalido" });

        const name = String(req.body.name || existing.name || "").trim();
        if (!name) return res.status(400).json({ error: "Nombre requerido" });

        const enabled =
          req.body.enabled === true ||
          req.body.enabled === 1 ||
          String(req.body.enabled || "").trim() === "1";

        const configJson = String(req.body.configJson || existing.configJson || "{}");
        const secretsJson = String(req.body.secretsJson || existing.secretsJson || "{}");
        let config;
        let secrets;
        try {
          config = JSON.parse(configJson);
          if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error("configJson debe ser un objeto");
          }
        } catch (error) {
          return res
            .status(400)
            .json({ error: `Config invalida: ${error?.message || error}` });
        }
        try {
          secrets = JSON.parse(secretsJson);
          if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
            throw new Error("secretsJson debe ser un objeto");
          }
        } catch (error) {
          return res
            .status(400)
            .json({ error: `Secrets invalidos: ${error?.message || error}` });
        }

        await db
          .prepare(
            `
          UPDATE company_integrations
          SET provider=?, name=?, enabled=?, configJson=?, secretsJson=?, updatedAt=?
          WHERE companyId=? AND id=?
        `
          )
          .run(
            provider,
            name,
            enabled ? 1 : 0,
            JSON.stringify(config),
            JSON.stringify(secrets),
            new Date().toISOString(),
            companyId,
            integrationId
          );

        const updated = await loadCompanyIntegration(companyId, integrationId, {
          includeSecrets: true,
        });
        res.json({ ok: true, integration: sanitizeIntegrationForAdmin(updated) });
      } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    }
  );

  router.post(
    "/api/companies/:id/integrations/:integrationId/test",
    requireApiAuth,
    async (req, res) => {
      try {
        const companyId = String(req.params.id || "").trim();
        const integrationId = String(req.params.integrationId || "").trim();
        const integration = await loadCompanyIntegration(companyId, integrationId, {
          includeSecrets: true,
        });
        if (!integration) return res.status(404).json({ error: "Integracion no encontrada" });

        const result = await runIntegrationModule(integration);
        res.json({
          ok: true,
          preview: {
            cards: Array.isArray(result.cards) ? result.cards.length : 0,
            alerts: Array.isArray(result.alerts) ? result.alerts.length : 0,
            hasTable: !!result.table,
          },
        });
      } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    }
  );

  router.post(
    "/api/companies/:id/integrations/:integrationId/delete",
    requireApiAuth,
    async (req, res) => {
      try {
        const companyId = String(req.params.id || "").trim();
        const integrationId = String(req.params.integrationId || "").trim();
        await db
          .prepare(
            `DELETE FROM company_integrations WHERE companyId=? AND id=?`
          )
          .run(companyId, integrationId);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    }
  );

  router.get(
    "/api/companies/:id/integrations/render",
    requireApiAuth,
    async (req, res) => {
      try {
        const companyId = String(req.params.id || "").trim();
        const company = await db
          .prepare(`SELECT id FROM companies WHERE id=?`)
          .get(companyId);
        if (!company) return res.status(404).json({ error: "Empresa no encontrada" });
        const integrations = await loadCompanyIntegrations(companyId, {
          includeSecrets: true,
          includeDisabled: false,
        });
        const modules = [];

        for (const integration of integrations) {
          try {
            const result = await runIntegrationModule(integration);
            modules.push(
              sanitizeIntegrationForRender({
                integrationId: integration.id,
                name: integration.name,
                provider: integration.provider,
                ...result,
              })
            );
          } catch (error) {
            modules.push(
              sanitizeIntegrationForRender({
                integrationId: integration.id,
                name: integration.name,
                provider: integration.provider,
                cards: [],
                alerts: [],
                table: null,
                meta: { source: integration.provider, updatedAt: new Date().toISOString() },
                error: error?.message || String(error),
              })
            );
          }
        }

        res.json({ modules });
      } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    }
  );

  router.post("/api/companies/:id/delete", requireApiAuth, async (req, res) => {
    try {
      await db
        .prepare(`DELETE FROM company_integrations WHERE companyId=?`)
        .run(req.params.id);
      await db.prepare(`DELETE FROM companies WHERE id=?`).run(req.params.id);
      invalidateAdminCompanyListCache();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ===== API: Assignments =====
  router.get("/api/assignments", requireApiAuth, async (req, res) => {
    try {
      const rows = await db
        .prepare(
          `
        SELECT fromNumber, companyId, updatedAt
        FROM customer_company
        ORDER BY updatedAt DESC
        LIMIT 100
      `
        )
        .all();
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/assignments", requireApiAuth, async (req, res) => {
    try {
      let fromNumber = normalizeWhatsappFromNumber(req.body.fromNumber);
      const companyId = String(req.body.companyId || "").trim();

      if (!fromNumber || !fromNumber.startsWith("whatsapp:+")) {
        return res
          .status(400)
          .json({ error: "fromNumber invalido. Usa formato whatsapp:+549..." });
      }

      const exists = await db
        .prepare(`SELECT id FROM companies WHERE id=?`)
        .get(companyId);
      if (!exists) return res.status(400).json({ error: "Empresa no existe" });

      await db
        .prepare(
          `
        INSERT INTO customer_company(fromNumber, companyId, updatedAt)
        VALUES(?,?,?)
        ON CONFLICT(fromNumber) DO UPDATE SET
          companyId=excluded.companyId,
          updatedAt=excluded.updatedAt
      `
        )
        .run(fromNumber, companyId, new Date().toISOString());

      const s = await db
        .prepare(`SELECT dataJson FROM sessions WHERE fromNumber=?`)
        .get(fromNumber);
      if (s) {
        const data = JSON.parse(s.dataJson || "{}");
        const previousCompanyId = String(data.companyId || "babystepsbots")
          .trim()
          .toLowerCase();
        const nextCompanyId = String(companyId || "")
          .trim()
          .toLowerCase();
        if (previousCompanyId !== nextCompanyId) {
          resetAiMemoryForMode(data);
          data.humanNotified = false;
          data.name = "";
          data.contact = "";
          data.notes = "";
          delete data.paymentMethodHint;
          delete data.checkoutOrderId;
          delete data.recentOrderId;
          delete data.recentOrderAt;
          delete data.recentOrderPaymentMethod;
          delete data.cartUpdatedAt;
          delete data.lastCartReminderAt;
        }
        data.companyId = companyId;
        const tempSession = { data };
        await syncSessionAiModeFromCompany(tempSession, { force: true });
        await db
          .prepare(
            `
          UPDATE sessions
          SET state='MENU', cartJson='[]', lastOrderId=NULL, dataJson=?
          WHERE fromNumber=?
        `
          )
          .run(JSON.stringify(data), fromNumber);
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/assignments/delete", requireApiAuth, async (req, res) => {
    try {
      const fromNumber = normalizeWhatsappFromNumber(req.body.fromNumber);
      if (!fromNumber || !fromNumber.startsWith("whatsapp:+")) {
        return res.status(400).json({ error: "fromNumber invalido" });
      }
      await db
        .prepare(`DELETE FROM customer_company WHERE fromNumber=?`)
        .run(fromNumber);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ===== API: Orders =====
  router.get("/api/orders", requireApiAuth, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const companyId = String(req.query.companyId || "").trim();
      const limitRaw = Number(req.query.limit || 100);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000)
        : 100;
      const offsetRaw = Number(req.query.offset || 0);
      const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

      const parseDateParam = (value, endOfDay = false) => {
        const raw = String(value || "").trim();
        if (!raw) return "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          const [yy, mm, dd] = raw.split("-").map((v) => Number(v));
          const date = endOfDay
            ? new Date(Date.UTC(yy, mm - 1, dd, 23, 59, 59, 999))
            : new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0));
          return Number.isNaN(date.getTime()) ? "" : date.toISOString();
        }
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
      };

      const fromIso = parseDateParam(req.query.from, false);
      const toIso = parseDateParam(req.query.to, true);

      const where = [];
      const params = [];

      if (companyId) {
        where.push("companyId = ?");
        params.push(companyId);
      }

      if (q) {
        const like = `%${q}%`;
        const searchFields = ["id", "fromNumber", "companyId", "name", "contact"];
        where.push(`(${searchFields.map((field) => `${field} LIKE ?`).join(" OR ")})`);
        params.push(...searchFields.map(() => like));
      }

      if (fromIso) {
        where.push("createdAt >= ?");
        params.push(fromIso);
      }

      if (toIso) {
        where.push("createdAt <= ?");
        params.push(toIso);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const sql = `
        SELECT
          id,createdAt,fromNumber,companyId,name,contact,notes,
          itemsJson,itemsDetailedJson,total,paymentStatus,paymentMethod,
          orderStatus,deliveredAt,category,workflowState,archived,archivedAt,archiveReason
        FROM orders
        ${whereSql}
        ORDER BY createdAt DESC
        LIMIT ? OFFSET ?
      `;

      const rows = await db.prepare(sql).all(...params, limit, offset);
      const normalized = rows.map((row) => normalizeOrderRow(row)).filter(Boolean);
      res.json(normalized);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get("/api/orders/:id", requireApiAuth, async (req, res) => {
    try {
      const orderId = String(req.params.id || "").trim();
      if (!orderId) return res.status(400).json({ error: "orderId requerido" });
      const companyIdQuery = String(req.query.companyId || "").trim();

      const row = await db
        .prepare(
          `
        SELECT
          id,createdAt,fromNumber,companyId,name,contact,notes,
          itemsJson,itemsDetailedJson,total,paymentStatus,paymentMethod,
          orderStatus,deliveredAt,category,workflowState,archived,archivedAt,archiveReason
        FROM orders
        WHERE id=?
        LIMIT 1
      `
        )
        .get(orderId);
      if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
      if (companyIdQuery && String(row.companyId || "").trim() !== companyIdQuery) {
        return res.status(403).json({ error: "Pedido no pertenece a esa empresa" });
      }

      return res.json(normalizeOrderRow(row));
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get("/api/orders/:id/messages", requireApiAuth, async (req, res) => {
    try {
      const orderId = String(req.params.id || "").trim();
      if (!orderId) return res.status(400).json({ error: "orderId requerido" });
      const companyIdQuery = String(req.query.companyId || "").trim();

      const limitRaw = Number(req.query.limit || 120);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
        : 120;

      const order = await db
        .prepare(`SELECT id, companyId FROM orders WHERE id=?`)
        .get(orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
      if (companyIdQuery && String(order.companyId || "").trim() !== companyIdQuery) {
        return res.status(403).json({ error: "Pedido no pertenece a esa empresa" });
      }

      const rows = await db
        .prepare(
          `
        SELECT
          id, fromNumber, companyId, orderId, direction, role, content, mediaUrl, mediaContentType, twilioSid, createdAt
        FROM ai_messages
        WHERE orderId=?
        ORDER BY createdAt ASC
        LIMIT ?
      `
        )
        .all(orderId, limit);

      const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row?.id || 0),
        fromNumber: String(row?.fromNumber || ""),
        companyId: String(row?.companyId || ""),
        orderId: String(row?.orderId || ""),
        direction: String(row?.direction || "").toLowerCase() === "out" ? "out" : "in",
        role:
          String(row?.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
        content: String(row?.content || ""),
        mediaUrl: String(row?.mediaUrl || ""),
        mediaContentType: String(row?.mediaContentType || ""),
        twilioSid: String(row?.twilioSid || ""),
        createdAt: row?.createdAt || "",
      }));

      return res.json({
        orderId,
        companyId: String(order.companyId || ""),
        count: normalized.length,
        messages: normalized,
      });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post("/api/orders/:id/category", requireApiAuth, async (req, res) => {
    try {
      const orderId = String(req.params.id || "").trim();
      if (!orderId) return res.status(400).json({ error: "orderId requerido" });

      const current = await db
        .prepare(
          `
        SELECT id, workflowState, archived, category, orderStatus, paymentStatus, archivedAt, archiveReason
        FROM orders
        WHERE id=?
      `
        )
        .get(orderId);
      if (!current) return res.status(404).json({ error: "Pedido no encontrado" });

      const stateInput = normalizeOrderWorkflowState(req.body.state);
      const legacy = parseLegacyOrderCategory(req.body.category);
      const hasArchivedInput =
        req.body.archived !== undefined &&
        req.body.archived !== null &&
        String(req.body.archived).trim() !== "";
      const archived = hasArchivedInput
        ? normalizeArchivedFlag(req.body.archived)
        : legacy.archived;
      const currentWorkflow = deriveOrderWorkflowFromRow(current);
      const state = stateInput || legacy.state || currentWorkflow.state;
      if (!state) return res.status(400).json({ error: "Estado invalido" });
      const archiveReasonInput = String(req.body.archiveReason || "").trim();

      const archivedAt = archived
        ? String(current?.archivedAt || new Date().toISOString())
        : null;
      const archiveReason = archived
        ? String(archiveReasonInput || current?.archiveReason || state)
        : "";
      const legacyCategory = archived ? `archived:${state}` : state;
      const currentPaymentStatus = String(current?.paymentStatus || "").trim();
      const isPaid = isPaidStatusValue(currentPaymentStatus);
      const nextPaymentStatus =
        state === "completed" ? (isPaid ? currentPaymentStatus : "paid") : currentPaymentStatus;
      const nextOrderStatus =
        state === "completed"
          ? "completed"
          : state === "rejected"
          ? "rejected"
          : "confirmed";

      const result = await db
        .prepare(
          `
        UPDATE orders
        SET workflowState=?, archived=?, archivedAt=?, archiveReason=?, category=?, paymentStatus=?, orderStatus=?
        WHERE id=?
      `
        )
        .run(
          state,
          archived,
          archivedAt,
          archiveReason,
          legacyCategory,
          nextPaymentStatus,
          nextOrderStatus,
          orderId
        );

      if (!result.changes) return res.status(404).json({ error: "Pedido no encontrado" });
      return res.json({
        ok: true,
        id: orderId,
        state,
        archived,
        category: legacyCategory,
        paymentStatus: nextPaymentStatus,
        orderStatus: nextOrderStatus,
      });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get(
    "/api/companies/:id/whatsapp-messages/stats",
    requireApiAuth,
    async (req, res) => {
      try {
        const companyId = String(req.params.id || "")
          .trim()
          .toLowerCase();
        if (!companyId) return res.status(400).json({ error: "companyId requerido" });

        const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const row = await db
          .prepare(
            `
          SELECT
            COUNT(*)::int AS total,
            COALESCE(SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END), 0)::int AS last30Days
          FROM ai_messages
          WHERE role='user'
            AND (
              companyId = ?
              OR (
                companyId IS NULL
                AND fromNumber IN (SELECT fromNumber FROM customer_company WHERE companyId = ?)
              )
            )
        `
          )
          .get(since30, companyId, companyId);

        return res.json({
          companyId,
          total: Number(row?.total || 0),
          last30Days: Number(row?.last30Days || 0),
        });
      } catch (e) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    }
  );

  router.post("/api/orders/:id/payment-status", requireApiAuth, async (req, res) => {
    try {
      const orderId = String(req.params.id || "").trim();
      if (!orderId) return res.status(400).json({ error: "orderId requerido" });

      const current = await db
        .prepare(`SELECT id, paymentStatus FROM orders WHERE id=?`)
        .get(orderId);
      if (!current) return res.status(404).json({ error: "Pedido no encontrado" });

      let nextPaymentStatus = normalizePaymentStatusInput(req.body.paymentStatus || "");
      if (!nextPaymentStatus && req.body.paid !== undefined) {
        nextPaymentStatus = normalizeArchivedFlag(req.body.paid) ? "paid" : "pending";
      }
      if (!nextPaymentStatus) return res.status(400).json({ error: "paymentStatus invalido" });

      const result = await db
        .prepare(`UPDATE orders SET paymentStatus=? WHERE id=?`)
        .run(nextPaymentStatus, orderId);

      if (!result.changes) return res.status(404).json({ error: "Pedido no encontrado" });
      return res.json({
        ok: true,
        id: orderId,
        paymentStatus: nextPaymentStatus,
      });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}
