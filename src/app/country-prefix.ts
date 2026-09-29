/** How channel names show their country prefix ("TR: Kanal D"). */
export type CountryPrefixMode = "show" | "hide" | "badge";

export const COUNTRY_PREFIX_MODES: CountryPrefixMode[] = ["show", "hide", "badge"];

/// Same prefixes the backend recognizes (xmltv.rs COUNTRY_PREFIX_RE):
/// "TR: x", "DE| x", "TR - x", "[UK] x" (brackets need no separator). A
/// hyphen needs a space next to it: "Al-Jazeera" and "TV-1000" are names.
const PREFIX_RE = /^\s*(?:\[([A-Za-z]{2})\]\s*[:|-]?|([A-Za-z]{2})(?:\s*[:|]|\s+-|-\s))\s*/;

/// Two-letter prefixes that are no country ("SD:"/"HD:" are quality marks).
const NOT_COUNTRIES = new Set(["SD", "HD", "TV"]);

export interface CountrySplit {
  /// Upper-case country code, when the name has one.
  code?: string;
  /// The name without the prefix (the full name when there is none).
  name: string;
}

/** Splits "TR: Kanal D" into "TR" and "Kanal D". "SD:"/"HD:"/"TV:" are no
 *  countries, and a name that would be empty keeps its prefix. */
export function splitCountryPrefix(name: string | undefined | null): CountrySplit {
  const full = name ?? "";
  const match = PREFIX_RE.exec(full);
  if (!match) return { name: full };
  const code = (match[1] ?? match[2]).toUpperCase();
  const rest = full.slice(match[0].length).trim();
  if (NOT_COUNTRIES.has(code) || !rest) return { name: full };
  return { code, name: rest };
}

/** The name as the mode shows it: "hide" and "badge" drop the prefix text
 *  ("badge" shows the code separately). */
export function displayName(name: string | undefined | null, mode: CountryPrefixMode): string {
  if (mode === "show") return name ?? "";
  return splitCountryPrefix(name).name;
}

export function toCountryPrefixMode(value: string | undefined | null): CountryPrefixMode {
  return COUNTRY_PREFIX_MODES.includes(value as CountryPrefixMode)
    ? (value as CountryPrefixMode)
    : "show";
}
