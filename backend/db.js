import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

function resolveDbPath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "/tmp/bot.db";
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function ensureDirOrFallback(targetPath) {
  const primaryDir = path.dirname(targetPath);
  try {
    fs.mkdirSync(primaryDir, { recursive: true });
    return targetPath;
  } catch (e) {
    const fallbackPath = "/tmp/bot.db";
    const fallbackDir = path.dirname(fallbackPath);
    fs.mkdirSync(fallbackDir, { recursive: true });
    console.warn(
      `[db] No se pudo crear directorio '${primaryDir}', usando fallback '${fallbackPath}': ${e?.message || e}`
    );
    return fallbackPath;
  }
}

const configuredPath = resolveDbPath(process.env.DB_PATH || "./data/bot.db");
const finalDbPath = ensureDirOrFallback(configuredPath);

console.log(`[db] SQLite path: ${finalDbPath}`);
export const db = new Database(finalDbPath);
