/**
 * Token aliases — Jancy's `@my-alias` discipline. Users keep API keys and
 * tokens OUT of CSV files and resolver specs; `@alias` maps to the real
 * secret in the SecretStore port (DPAPI on Windows), exactly like proxy
 * passwords. A spec containing a bare token still works; aliases just make
 * the safe way the easy way.
 */

export interface AliasStore {
  set(alias: string, secret: string): void;
  get(alias: string): string | null;
  remove(alias: string): void;
  list(): { alias: string }[];
}

/**
 * Substitutes every `@alias` occurrence. Unknown aliases stay verbatim so
 * the downstream error names the alias instead of silently sending "@x"
 * to a third-party API.
 */
export function substituteAliases(spec: string, store: AliasStore): string {
  return spec.replace(/@([A-Za-z0-9_.-]+)/g, (m, alias: string) => {
    const secret = store.get(alias);
    return secret ?? m;
  });
}

/** Alias view over the shared SecretStore (keys prefixed `alias.`). */
export function secretAliasStore(secrets: {
  set(key: string, value: string): void;
  get(key: string): string | null;
  delete(key: string): void;
}): AliasStore {
  const key = (alias: string) => `alias.${alias}`;
  return {
    set(alias, secret) {
      secrets.set(key(alias), secret);
    },
    get(alias) {
      return secrets.get(key(alias));
    },
    remove(alias) {
      secrets.delete(key(alias));
    },
    list() {
      // The SecretStore port is get-by-key; aliases are enumerable through
      // the dedicated route handlers, not here.
      return [];
    },
  };
}
