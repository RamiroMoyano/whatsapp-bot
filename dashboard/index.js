import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import adminRouter from "./routes/admin.js";
import panelRouter from "./routes/panel.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

// ===== Compat: alias legado (/c) al panel cliente real (/panel) =====
app.get("/c", (req, res) => res.redirect("/panel"));
app.get("/c/logout", (req, res) => res.redirect("/panel/logout"));
app.get("/c/catalogo", (req, res) => res.redirect("/panel/catalogo"));
app.get("/c/pedidos", (req, res) => res.redirect("/panel/pedidos"));
app.get("/c/pedidos/export", (req, res) => res.redirect("/panel/pedidos/export"));
app.get("/c/soporte", (req, res) => res.redirect("/panel/soporte"));
app.get("/c/conversaciones", (req, res) => res.redirect("/panel/conversaciones"));
app.get("/c/integraciones", (req, res) => res.redirect("/panel/integraciones"));
app.get("/c/suscripcion", (req, res) => res.redirect("/panel/suscripcion"));
app.get("/c/cuenta", (req, res) => res.redirect("/panel/cuenta"));

// ===== Route modules =====
app.use(adminRouter);
app.use(panelRouter);

// ===== Health / debug =====
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/", (_, res) => res.send("OK"));
app.get("/__whoami", (req, res) => {
  res.json({
    bootFile: import.meta.url,
    pwd: process.cwd(),
    node: process.version,
  });
});

app.get("/__routes", (req, res) => {
  function extractRoutes(router) {
    const stack = router?.stack || [];
    const routes = [];

    for (const layer of stack) {
      // En algunos casos hay sub-routers
      if (layer?.handle?.stack) {
        routes.push(...extractRoutes(layer.handle));
      }

      if (!layer.route) continue;
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods || {})
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      routes.push({ path, methods });
    }

    return routes;
  }

  const r1 = extractRoutes(app._router);
  const r2 = extractRoutes(app.router);

  const info = {
    expressRouterKeys: {
      has_app__router: !!app._router,
      app__router_stack_len: app._router?.stack?.length ?? null,
      has_app_router: !!app.router,
      app_router_stack_len: app.router?.stack?.length ?? null,
    },
    routes: [...r1, ...r2]
      .filter((x, i, a) => a.findIndex(y => y.path === x.path && y.methods.join(",") === x.methods.join(",")) === i)
      .sort((a, b) => (a.path > b.path ? 1 : -1)),
  };

  info.count = info.routes.length;
  res.json(info);
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
