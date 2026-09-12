import { NextResponse } from "next/server";

/** Largest JSON body any route accepts. The schemas cap query text at a few thousand characters,
 *  so a body past this is never legitimate and is refused before it is read into memory. */
export const MAX_BODY_BYTES = 64 * 1024;

// Every POST route reaches a paid provider or a retrieval pass, and none of them is
// authenticated, so the first line of defense is refusing requests that a first-party page
// would never send.
//
// A cross-origin page can POST here without a preflight only as a CORS "simple request", which
// cannot carry an application/json content type. Requiring that type forces a preflight, and the
// preflight fails because this app sets no CORS headers. Browsers that send Sec-Fetch-Site
// (all current ones) are checked as well: it is set by the browser, not the page, so it cannot
// be forged, and a value other than same-origin (or "none" for a direct navigation or
// non-browser client) means a third-party site is driving the request. The header is optional
// so curl, tests, and the deployment check keep working.
export function rejectUnsafeRequest(request: Request): NextResponse | null {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return NextResponse.json({ error: "Requests must be application/json." }, { status: 415 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "Cross-site requests are not accepted." }, { status: 403 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  return null;
}
