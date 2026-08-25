import { NextResponse } from "next/server";

// The README's deployment check hits this route, so "ok" must be unreachable when a live
// deployment is missing the credentials search depends on. Configuration is inspected only;
// active probing belongs to the authenticated cron monitor, not to a lightweight health check.
export function GET() {
  const mock = process.env.MOCK_DATABRICKS === "true";
  const credentials = Boolean(process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN);
  const searchConfigured = mock || (credentials && Boolean(process.env.DATABRICKS_INDEX_NAME));
  const chatConfigured = credentials && Boolean(process.env.DATABRICKS_CHAT_MODEL);
  // Search is the core function; chat degrades gracefully behind a configuration message.
  const status = !searchConfigured ? "unavailable" : chatConfigured ? "ok" : "degraded";
  return NextResponse.json({ status, searchMode: mock ? "mock" : "live", searchConfigured, chatConfigured }, { status: searchConfigured ? 200 : 503 });
}
