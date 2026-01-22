import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "/var/data/bot.db";

// En local Windows, si no existe /var/data, usamos carpeta del proyecto
const resolvedPath = DB_PATH.startsWith("/var/") ? DB_PATH : DB_PATH;

if (resolvedPath.startsWith("/var/")) {
  try { fs.mkdirSync("/var/data", { recursive: true }); } catch {}
}

export const db = new Database(resolvedPath);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  fromNumber TEXT NOT NULL,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT NOT NULL,
  itemsDetailedJson TEXT NOT NULL,
  total INTEGER NOT NULL,
  paymentStatus TEXT DEFAULT 'pending',
  paymentMethod TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  cartJson TEXT NOT NULL,
  dataJson TEXT NOT NULL,
  lastOrderId TEXT
);
`);
import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "/var/data/bot.db";

if (DB_PATH.startsWith("/var/")) {
  try { fs.mkdirSync("/var/data", { recursive: true }); } catch {}
}

export const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  fromNumber TEXT NOT NULL,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT NOT NULL,
  itemsDetailedJson TEXT NOT NULL,
  total INTEGER NOT NULL,
  paymentStatus TEXT DEFAULT 'pending',
  paymentMethod TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  cartJson TEXT NOT NULL,
  dataJson TEXT NOT NULL,
  lastOrderId TEXT
);
`);
import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "/var/data/bot.db";

if (DB_PATH.startsWith("/var/")) {
  try { fs.mkdirSync("/var/data", { recursive: true }); } catch {}
}

export const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  fromNumber TEXT NOT NULL,
  name TEXT,
  contact TEXT,
  notes TEXT,
  itemsJson TEXT NOT NULL,
  itemsDetailedJson TEXT NOT NULL,
  total INTEGER NOT NULL,
  paymentStatus TEXT DEFAULT 'pending',
  paymentMethod TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  fromNumber TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  cartJson TEXT NOT NULL,
  dataJson TEXT NOT NULL,
  lastOrderId TEXT
);
`);
