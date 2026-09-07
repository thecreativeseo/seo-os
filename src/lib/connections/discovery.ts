/**
 * What can be true about a Google connection, and what to say about each.
 *
 * The old code had one answer for every failure: "the authorization may need to
 * be repeated." That sentence was right roughly one time in five, and the other
 * four it sent somebody to reconnect an account that was already fine while the
 * real cause, an API not enabled on the OAuth project or a scope Google never
 * granted, stayed invisible. Worse, it was also shown when the account simply
 * had no properties, which is not a failure at all.
 *
 * So each state is named, and each carries the remedy that actually applies.
 * Nothing here is about credentials; these are shown to a person.
 */

export const CONNECTION_STATES = [
  "NOT_CONNECTED",
  "PROPERTY_SELECTION_REQUIRED",
  "READY",
  "REAUTH_REQUIRED",
  "API_NOT_ENABLED",
  "INSUFFICIENT_SCOPE",
  "NO_ACCESSIBLE_PROPERTIES",
  "PROPERTY_DISCOVERY_FAILED",
  "INVALID_PROVIDER_RESPONSE",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** The subset a failed discovery call can produce. */
export const DISCOVERY_FAILURE_CODES = [
  "REAUTH_REQUIRED",
  "API_NOT_ENABLED",
  "INSUFFICIENT_SCOPE",
  "NO_ACCESSIBLE_PROPERTIES",
  "PROPERTY_DISCOVERY_FAILED",
  "INVALID_PROVIDER_RESPONSE",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
] as const;

export type DiscoveryFailureCode = (typeof DISCOVERY_FAILURE_CODES)[number];

export function isDiscoveryFailureCode(value: string): value is DiscoveryFailureCode {
  return (DISCOVERY_FAILURE_CODES as readonly string[]).includes(value);
}

/** A short label for the card, in the product's own words rather than an enum. */
export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  NOT_CONNECTED: "Not connected",
  PROPERTY_SELECTION_REQUIRED: "Choose a property",
  READY: "Connected",
  REAUTH_REQUIRED: "Needs reconnecting",
  API_NOT_ENABLED: "API unavailable",
  INSUFFICIENT_SCOPE: "Permission not granted",
  NO_ACCESSIBLE_PROPERTIES: "No usable properties",
  PROPERTY_DISCOVERY_FAILED: "Could not load properties",
  INVALID_PROVIDER_RESPONSE: "Unexpected response",
  RATE_LIMITED: "Too many requests",
  PROVIDER_UNAVAILABLE: "Google is unavailable",
};

/** What happened, and what the person can do about it. */
export const CONNECTION_STATE_MESSAGES: Record<ConnectionState, string> = {
  NOT_CONNECTED: "Not connected yet.",
  PROPERTY_SELECTION_REQUIRED: "Google is authorized. Choose the property SEO OS should use.",
  READY: "Connected, with a property chosen.",
  REAUTH_REQUIRED: "Google authorization needs to be renewed. Reconnect this account.",
  API_NOT_ENABLED:
    "The required Google API is not available for this OAuth project. Ask an administrator to enable it.",
  INSUFFICIENT_SCOPE:
    "Google did not grant the permission required to read these properties. Reconnect and approve the requested access.",
  NO_ACCESSIBLE_PROPERTIES:
    "This Google account is connected, but it does not have access to any usable properties.",
  PROPERTY_DISCOVERY_FAILED: "Google could not return the property list right now. Try again.",
  INVALID_PROVIDER_RESPONSE:
    "Google answered in a form SEO OS did not recognise. Try again, and tell us if it continues.",
  RATE_LIMITED: "Google asked us to slow down. Try again in a few minutes.",
  PROVIDER_UNAVAILABLE: "Google is not responding at the moment. Try again shortly.",
};

/** Whether reconnecting is genuinely the remedy. Only these two states offer it. */
export function needsReauthorization(state: ConnectionState): boolean {
  return state === "REAUTH_REQUIRED" || state === "INSUFFICIENT_SCOPE";
}

/**
 * Whether the person can usefully open the property picker.
 *
 * An account with no properties is connected and not broken, so the picker
 * would only show them an empty list and a control that does nothing.
 */
export function canChooseProperty(state: ConnectionState): boolean {
  return state === "PROPERTY_SELECTION_REQUIRED" || state === "READY";
}
