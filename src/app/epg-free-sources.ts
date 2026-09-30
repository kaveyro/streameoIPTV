import { CountryCount } from "./models/epgExtras";

/** A curated free XMLTV guide; `country` is an ISO 3166 region code. */
export interface FreeEpgSource {
  label: string;
  url: string;
  country: string;
}

/// Curated free public XMLTV EPG sources for one-click adding (settings page
/// and first-run setup). The country lets the settings point out guides that
/// cover the same one twice and the setup preselect guides for the playlist.
export const FREE_EPG_SOURCES: readonly FreeEpgSource[] = [
  { label: "IPTV-EPG · Deutschland", url: "https://iptv-epg.org/files/epg-de.xml", country: "DE" },
  { label: "IPTV-EPG · Türkiye", url: "https://iptv-epg.org/files/epg-tr.xml", country: "TR" },
  {
    label: "IPTV-EPG · United Kingdom",
    url: "https://iptv-epg.org/files/epg-uk.xml",
    country: "GB",
  },
  {
    label: "IPTV-EPG · United States",
    url: "https://iptv-epg.org/files/epg-us.xml",
    country: "US",
  },
  { label: "IPTV-EPG · France", url: "https://iptv-epg.org/files/epg-fr.xml", country: "FR" },
  { label: "IPTV-EPG · Nederland", url: "https://iptv-epg.org/files/epg-nl.xml", country: "NL" },
  { label: "IPTV-EPG · España", url: "https://iptv-epg.org/files/epg-es.xml", country: "ES" },
  { label: "IPTV-EPG · Italia", url: "https://iptv-epg.org/files/epg-it.xml", country: "IT" },
  {
    label: "EPGShare · Germany",
    url: "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    country: "DE",
  },
  {
    label: "EPGShare · Turkey",
    url: "https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz",
    country: "TR",
  },
  {
    label: "EPGShare · UK",
    url: "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz",
    country: "GB",
  },
  {
    label: "EPGShare · USA",
    url: "https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz",
    country: "US",
  },
];

/// Share of the prefixed channels the preselected countries should cover.
const TOP_COUNTRIES_SHARE = 0.8;
/// At most this many guides are preselected: each one slows the refresh down.
const MAX_PRESELECTED = 4;

/** Upper-case ISO code; playlists write "UK" where ISO says "GB". */
export function normalizeCountryCode(code: string): string {
  const upper = code.trim().toUpperCase();
  return upper === "UK" ? "GB" : upper;
}

/**
 * The first free guide per country, in the order of `codes`, at most `max`.
 * One per country: a second guide for the same one only duplicates data.
 */
export function freeEpgSourcesFor(codes: Iterable<string>, max = MAX_PRESELECTED): FreeEpgSource[] {
  const picked: FreeEpgSource[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    if (picked.length >= max) break;
    const code = normalizeCountryCode(raw);
    if (seen.has(code)) continue;
    seen.add(code);
    const source = FREE_EPG_SOURCES.find((s) => s.country === code);
    if (source) picked.push(source);
  }
  return picked;
}

/**
 * The most common countries that together cover most of the prefixed
 * channels (get_countries counts), most common first; "UK" counts as "GB".
 */
export function topCountries(counts: CountryCount[], share = TOP_COUNTRIES_SHARE): string[] {
  const merged = new Map<string, number>();
  for (const { code, count } of counts) {
    if (!code || !(count > 0)) continue;
    const key = normalizeCountryCode(code);
    merged.set(key, (merged.get(key) ?? 0) + count);
  }
  const sorted = [...merged].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  const top: string[] = [];
  let covered = 0;
  for (const [code, count] of sorted) {
    if (total > 0 && covered / total >= share) break;
    top.push(code);
    covered += count;
  }
  return top;
}
