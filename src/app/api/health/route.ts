import { NextResponse } from "next/server";
export function GET() { return NextResponse.json({ status: "ok", searchMode: process.env.MOCK_DATABRICKS === "true" ? "mock" : "live", chatConfigured: Boolean(process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN && process.env.DATABRICKS_CHAT_MODEL) }); }
