/**
 * Cookie-consent handling. Accepting banners is what actually plants the cookies a
 * warmup is for; ignoring them leaves the profile looking like it never engaged.
 * Ordered: known CMPs first (precise), generic text matches last.
 */
export const CONSENT_SELECTORS: string[] = [
  // OneTrust
  "#onetrust-accept-btn-handler",
  // Cookiebot
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  // Quantcast Choice
  ".qc-cmp2-summary-buttons button[mode='primary']",
  // Didomi
  "#didomi-notice-agree-button",
  // TrustArc
  "#truste-consent-button",
  // Google Funding Choices
  ".fc-cta-consent",
  // Osano
  ".osano-cm-accept-all",
  // Usercentrics
  "button[data-testid='uc-accept-all-button']",
  // CookieYes / generic ids
  ".cky-btn-accept",
  "#cookie-accept",
  "#accept-cookies",
  "#acceptAllCookies",
  "button#accept-all",
  // Amazon
  "#sp-cc-accept",
  // eBay
  "#gdpr-banner-accept",
];

/**
 * Generic accept buttons, matched against the element's whole text (anchored, case-insensitive).
 * Substring matching is a trap: `has-text('OK')` would happily click "Cookie settings".
 */
// QueuePilot (security audit 2026-11-19): bare "Continue" / "OK" / "Okay" and
// plain links / submit inputs are gone from the generic path — on a sign-in
// or checkout step they would submit a form, and the warmer never does that.
export const CONSENT_TEXT = /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i (agree|accept)|agree( and close)?|got it|yes,? i agree|accept & close|accept and continue|consent)\s*$/i;

/** Elements worth testing against CONSENT_TEXT (never inside a form — see handleConsent). */
export const CONSENT_CLICKABLES = "button:not(form button), [role='button']:not(form [role='button'])";

/** Frames that commonly host a consent dialog. */
export const CONSENT_FRAME_HINTS = /sp_message_iframe|consent|cmp|privacy|gdpr|cookie/i;
