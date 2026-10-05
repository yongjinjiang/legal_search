/** Presentation guard for common opinion pinpoints, not a complete legal citation parser. */
export function inlineReferenceIssue(text: string): string | undefined {
  if (/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/.test(text)) return "inline_source_marker";
  if (/https?:\/\//i.test(text)) return "model_url";
  if (/\b(?:PDF\s+(?:pages?|pp?\.?)|pages?)\s*\d/i.test(text)) return "pdf_page_reference";
  if (/\b(?:ante|post|supra|infra|id\.)\s*,?\s*at\s+\d/i.test(text)) return "relative_pinpoint";
  if (/\b\d+\s+(?:U\.?\s*S\.?|S\.?\s*Ct\.?|F\.?\s*(?:2d|3d|4th)|F\.?\s*Supp\.?(?:\s*(?:2d|3d))?)\s*(?:,\s*at\s+\d+|\d+\s*,\s*(?:at\s+)?\d+)/i.test(text)) return "reporter_pinpoint";
  // Bare "p. 385" and "at 3" occur in secondary-authority quotes and quantities, respectively.
  // They do not establish an opinion pinpoint and are deliberately not rejected on that alone.
  return undefined;
}
