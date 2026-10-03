import { TranslateService } from "@ngx-translate/core";

/// Backend messages meant for the user (bail!/context texts in src-tauri,
/// reachable from the PIN commands and check_source) and their translation.
/// Keep in sync with parental.rs, xtream.rs (check) and m3u.rs (check_link).
const KNOWN_ERRORS: Record<string, string> = {
  "Wrong PIN": "PARENTAL.WRONG_PIN",
  "The PIN must be 4 to 8 digits": "PARENTAL.PIN_FORMAT_INVALID",
  "Set a parental PIN in the settings first": "PARENTAL.SET_PIN_FIRST",
  "The provider rejected the username or password": "ERROR.CREDENTIALS_REJECTED",
  "The server did not answer like an Xtream Codes server": "ERROR.NOT_XTREAM_SERVER",
  "The link does not point to an M3U playlist": "ERROR.NOT_M3U_PLAYLIST",
  "This programme is already scheduled for recording": "TOAST.RECORDING_ALREADY_SCHEDULED",
};

/**
 * The top-level message of a backend error. Commands format anyhow errors
 * with {:?}, which appends the cause chain ("...\n\nCaused by:\n    0: ...");
 * only the first line is meant for a toast.
 */
export function firstErrorLine(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e ?? "")).trim();
  const first = text.split(/\r?\n/, 1)[0].trim();
  return first || text;
}

/** The translation key of a backend error meant for the user, if it is one. */
export function knownErrorKey(e: unknown): string | undefined {
  return KNOWN_ERRORS[firstErrorLine(e).replace(/\.$/, "")];
}

/** A backend error as text for the user: translated when known, else its first line. */
export function errorText(e: unknown, translate: TranslateService): string {
  const key = knownErrorKey(e);
  return key ? translate.instant(key) : firstErrorLine(e);
}
