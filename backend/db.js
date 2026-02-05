import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "/var/data/bot.db";

// En Render, si usás disco persistente montado en /var/data
if (DB_PATH.startsWith("/var/")) {
  try { fs.mkdirSync("/var/data", { recursive: true }); } catch {}
}

export const db = new Database(DB_PATH);

