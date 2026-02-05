import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const DASH_USER = (process.env.DASH_USER || "").trim();
const DASH_PASS = (process.env.DASH_PASS || "").trim();
const DASH_COOKIE_SECRET = (process.env.DASH_COOKIE_SECRET || "").trim();

const API_BASE_URL = (process.env.API_BASE_URL || "").trim();
const API_TOKEN = (process.env.API_TOKEN || "").trim();

function signToken(token) {
  const h = crypto.createHmac("sha256", DASH_COOKIE_SECRET || "dev");
  h.update(token);
  return h.digest("hex");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const [k, ...rest] = p.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function setCookie(res, name, value) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function requireDashboardAuth(req, res, next) {
  if (!DASH_USER || !DASH_PASS || !DASH_COOKIE_SECRET) {
    return res.status(500).send("Faltan env: DASH_USER, DASH_PASS, DASH_COOKIE_SECRET");
  }
  const cookie = parseCookies(req)["dash"];
  if (!cookie) return res.redirect("/admin/login");

  const [token, sig] = cookie.split(".");
  if (!token || !sig) return res.redirect("/admin/login");
  if (signToken(token) !== sig) return res.redirect("/admin/login");
  next();
}

async function api(path, { method = "GET", body } = {}) {
  if (!API_BASE_URL || !API_TOKEN) throw new Error("API_BASE_URL/API_TOKEN faltan en dashboard");
  const r = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `API error ${r.status}`);
  return data;
}

// Login
app.get("/admin/login", (req, res) => {
  res.type("text/html").send(`
    <h2>Login</h2>
    <form method="POST" action="/admin/login">
      <input name="user" placeholder="user"/><br/>
      <input name="pass" type="password" placeholder="pass"/><br/>
      <button>Entrar</button>
    </form>
  `);
});

app.post("/admin/login", (req, res) => {
  const user = (req.body.user || "").trim();
  const pass = (req.body.pass || "").trim();
  if (user !== DASH_USER || pass !== DASH_PASS) return res.status(401).send("Credenciales incorrectas");

  const token = crypto.randomBytes(24).toString("hex");
  setCookie(res, "dash", `${token}.${signToken(token)}`);
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  clearCookie(res, "dash");
  res.redirect("/admin/login");
});

// Home: lista companies
app.get("/admin", requireDashboardAuth, async (req, res) => {
  const companies = await api("/api/companies");
  const rows = companies.map(c => `
    <li>
      <b>${c.id}</b> — ${c.name || ""} 
      <a href="/admin/company/${encodeURIComponent(c.id)}">Editar</a>
    </li>
  `).join("");

  res.type("text/html").send(`
    <h2>Empresas</h2>
    <a href="/admin/logout">Logout</a>
    <ul>${rows}</ul>
  `);
});

// Edit company (simple)
app.get("/admin/company/:id", requireDashboardAuth, async (req, res) => {
  const c = await api(`/api/companies/${encodeURIComponent(req.params.id)}`);
  res.type("text/html").send(`
    <h2>Editar ${c.id}</h2>
    <form method="POST" action="/admin/company/${encodeURIComponent(c.id)}/save">
      <label>Nombre</label><br/>
      <input name="name" value="${(c.name || "").replaceAll('"', '&quot;')}"/><br/><br/>
      <label>Prompt</label><br/>
      <textarea name="prompt" rows="8" cols="80">${c.prompt || ""}</textarea><br/><br/>
      <label>Catalog JSON</label><br/>
      <textarea name="catalogJson" rows="10" cols="80">${c.catalogJson || "[]"}</textarea><br/><br/>
      <label>Rules JSON</label><br/>
      <textarea name="rulesJson" rows="10" cols="80">${c.rulesJson || "{}"}</textarea><br/><br/>
      <button>Guardar</button>
      <a href="/admin">Volver</a>
    </form>
  `);
});

app.post("/admin/company/:id/save", requireDashboardAuth, async (req, res) => {
  await api(`/api/companies/${encodeURIComponent(req.params.id)}/save`, {
    method: "POST",
    body: {
      name: req.body.name,
      prompt: req.body.prompt,
      catalogJson: req.body.catalogJson,
      rulesJson: req.body.rulesJson,
    }
  });
  res.redirect(`/admin/company/${encodeURIComponent(req.params.id)}`);
});

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("Dashboard running"));
