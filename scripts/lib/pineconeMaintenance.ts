/** Names are explicit: an old namespace may still serve a production or preview deployment. */
export function requestedPruneNamespaces(args: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--prune") continue;
    const name = args[++i];
    if (!name || !/^corpus-[0-9a-f]{24}$/.test(name)) {
      throw new Error("--prune requires an explicit corpus namespace (corpus- followed by 24 lowercase hex characters). Confirm that no deployment uses it before pruning.");
    }
    names.push(name);
  }
  return [...new Set(names)];
}

export function validatePruneNamespaces(current: string, requested: string[]): void {
  if (requested.includes(current)) throw new Error("Cannot prune the corpus namespace used by this build.");
}
