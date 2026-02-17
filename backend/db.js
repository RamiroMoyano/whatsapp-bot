import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const rawPath = String(process.env.DB_PATH || "./data/bot.db").trim();
const DB_PATH = path.isAbsolute(rawPath)
  ? rawPath
  : path.resolve(process.cwd(), rawPath);
const DB_DIR = path.dirname(DB_PATH);

try {
  fs.mkdirSync(DB_DIR, { recursive: true });
} catch {}

export const db = new Database(DB_PATH);
