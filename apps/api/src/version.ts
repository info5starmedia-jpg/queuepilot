/**
 * Single source of truth for the app version (family-packaging track).
 * MUST equal apps/api/package.json's "version" — a unit test guards that.
 * The dashboard sidebar span is cosmetic; the updater compares against this.
 */
export const APP_VERSION = "0.16.1";
