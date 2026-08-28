/** RFC 4180 reader. The chunk file embeds newlines and doubled quotes inside `chunk_text`, so a
 *  line-splitting parser would silently truncate opinions mid-passage. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i];
    if (quoted) {
      if (character !== '"') { field += character; continue; }
      if (body[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += character;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((entry) => entry.length > 1 || entry[0] !== "");
  if (!header) return [];
  return data.map((entry) => Object.fromEntries(header.map((name, index) => [name, entry[index] ?? ""])));
}
