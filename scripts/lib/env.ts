import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Minimal .env reader for the offline scripts. Next.js loads these files for the application,
 *  but `vite-node scripts/…` runs outside that, and asking an operator to export the key by hand
 *  invites it landing in shell history. Existing process variables always win. */
export function loadEnvFiles(root: string, files = [".env.local", ".env"]): void {
  for (const file of files) {
    const location = path.join(root, file);
    if (!existsSync(location)) continue;
    for (const line of readFileSync(location, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
      if (!match || line.trimStart().startsWith("#")) continue;
      const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}
