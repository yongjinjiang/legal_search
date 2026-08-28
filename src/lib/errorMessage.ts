/** Turn a failed API response into a message safe to show a visitor.
 *
 *  The edge rate-limit rule denies with an HTML body, not this application's JSON shape, so a
 *  response must never be parsed before its status is known: `await response.json()` on a denied
 *  request throws a SyntaxError whose text ("Unexpected token '<'…") would otherwise be rendered
 *  as if it were the error. Everything the application itself reports arrives as {"error": "…"}.
 */
export async function readError(response: Response, fallback: string): Promise<string> {
  // Vercel's WAF denies with 403; 429 covers any limiter that uses the conventional status.
  if (response.status === 429 || response.status === 403) return "Too many requests. Please wait a moment and try again.";
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 ? body.error : fallback;
  } catch {
    return fallback;
  }
}
