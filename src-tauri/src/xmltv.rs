//! External XMLTV EPG support.
//!
//! Downloads one or more XMLTV guide files (plain or gzipped), parses the
//! `<programme>` entries and stores them in the `xmltv_programmes` cache table,
//! keyed by the XMLTV `channel` id. Channels are matched to this data by their
//! `epg_channel_id` (tvg-id) when their provider offers no EPG of its own.

use std::io::Read;

use anyhow::{Context, Result};
use chrono::{FixedOffset, TimeZone, Utc};
use flate2::read::GzDecoder;
use quick_xml::Reader;
use quick_xml::events::Event;

use std::collections::{HashMap, HashSet};

use crate::{
    log::{info, log, warn},
    settings, sql,
    types::{CountryCount, XmltvChannelHit, XmltvSourceStatus},
    utils,
};

/// Guard against a malformed/huge feed exhausting memory.
const MAX_PROGRAMMES: usize = 2_000_000;
/// Largest guide download accepted, compressed or not.
const MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
/// Largest decompressed guide accepted (a gzip bomb stops here).
const MAX_XML_BYTES: u64 = 1024 * 1024 * 1024;
/// Drop programmes that ended more than this long ago.
const STALE_SECS: i64 = 24 * 60 * 60;

/// Fetches every configured XMLTV source and rebuilds the programme cache.
/// Best-effort: a failing source is logged and skipped; other sources still load.
pub async fn refresh() -> Result<()> {
    let urls = settings::get_xmltv_sources()?;
    if urls.is_empty() {
        sql::replace_xmltv_programmes(&[])?;
        settings::set_xmltv_status(&HashMap::new())?;
        return Ok(());
    }
    let mut status = settings::get_xmltv_status().unwrap_or_default();
    status.retain(|url, _| urls.contains(url));
    let now = Utc::now().timestamp();
    let cutoff = now - STALE_SECS;
    let client = utils::download_client_builder().build()?;
    let mut programmes: Vec<(String, i64, i64, String, Option<String>)> = Vec::new();
    // Normalized-name -> channel id, for the name-based matching fallback used
    // when a channel's tvg-id does not equal the XMLTV channel id (common with
    // Xtream providers whose epg_channel_id values are opaque hashes).
    let mut channels: Vec<(String, String)> = Vec::new();

    let mut failures = 0usize;
    for url in &urls {
        let entry = status.entry(url.clone()).or_default();
        entry.url = url.clone();
        match fetch_and_parse(&client, url, cutoff).await {
            Ok((new_programmes, new_channels)) => {
                info(format!("XMLTV: loaded {} programmes", new_programmes.len()));
                let channel_ids: HashSet<&str> =
                    new_programmes.iter().map(|p| p.0.as_str()).collect();
                entry.updated = Some(now);
                entry.programmes = Some(new_programmes.len());
                entry.channels = Some(channel_ids.len());
                entry.error = None;
                programmes.extend(new_programmes);
                channels.extend(new_channels);
            }
            Err(e) => {
                failures += 1;
                entry.error = Some(crate::redact::redact(&format!("{e:#}")));
                log(format!("{:?}", e.context("XMLTV source failed")));
            }
        }
        if programmes.len() >= MAX_PROGRAMMES {
            warn(format!(
                "XMLTV: reached the {MAX_PROGRAMMES} programme cap, skipping remaining sources"
            ));
            break;
        }
    }

    if let Err(e) = settings::set_xmltv_status(&status) {
        log(format!(
            "{:?}",
            e.context("failed to store the XMLTV status")
        ));
    }
    if failures == urls.len() {
        // Nothing loaded (offline, provider down): keep the guide we have.
        anyhow::bail!("All XMLTV sources failed, keeping the cached guide");
    }
    let partial = failures > 0;
    let (programme_count, channel_count) = (programmes.len(), channels.len());
    tokio::task::spawn_blocking(move || -> Result<()> {
        if partial {
            // Keep what the failed sources provided last time; only the
            // channels that were just loaded are replaced.
            sql::merge_xmltv_programmes(&programmes, cutoff)?;
            sql::merge_xmltv_channels(&channels)?;
        } else {
            sql::replace_xmltv_programmes(&programmes)?;
            sql::replace_xmltv_channels(&channels)?;
        }
        sql::checkpoint_wal();
        Ok(())
    })
    .await??;
    settings::set_xmltv_last_updated(now)?;
    info(format!(
        "XMLTV: stored {} programmes and {} channel name mappings",
        programme_count, channel_count
    ));
    Ok(())
}

/// Refreshes the XMLTV cache when sources are configured and the last refresh
/// is older than `max_age_secs` (or never happened). Returns whether it ran.
pub async fn refresh_if_due(max_age_secs: i64) -> Result<bool> {
    if settings::get_xmltv_sources()?.is_empty() {
        return Ok(false);
    }
    let now = Utc::now().timestamp();
    if settings::get_xmltv_last_updated()?.is_some_and(|t| now - t < max_age_secs) {
        return Ok(false);
    }
    refresh().await?;
    Ok(true)
}

type Programme = (String, i64, i64, String, Option<String>);

async fn fetch_and_parse(
    client: &reqwest::Client,
    url: &str,
    cutoff: i64,
) -> Result<(Vec<Programme>, Vec<(String, String)>)> {
    let mut resp = client.get(url).send().await?.error_for_status()?;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if bytes.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            anyhow::bail!(
                "XMLTV guide is larger than {} MB",
                MAX_DOWNLOAD_BYTES / 1024 / 1024
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    // gzip if the magic bytes match or the URL clearly points at a .gz file.
    let is_gzip = bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
        || url.trim_end_matches(['?', '#']).ends_with(".gz");
    // Decompressing and parsing a guide takes seconds: blocking thread.
    tokio::task::spawn_blocking(move || {
        let xml = if is_gzip {
            let mut decoded = Vec::new();
            GzDecoder::new(&bytes[..])
                .take(MAX_XML_BYTES + 1)
                .read_to_end(&mut decoded)
                .context("Failed to gunzip XMLTV")?;
            if decoded.len() as u64 > MAX_XML_BYTES {
                anyhow::bail!("Decompressed XMLTV guide is too large");
            }
            String::from_utf8_lossy(&decoded).into_owned()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let mut programmes = Vec::new();
        let mut channels = Vec::new();
        parse_xmltv(&xml, cutoff, &mut programmes, &mut channels)?;
        Ok((programmes, channels))
    })
    .await?
}

/// Parses XMLTV content, appending programmes that end after `cutoff` to `out`.
/// Returns how many programmes were appended.
fn parse_xmltv(
    xml: &str,
    cutoff: i64,
    out: &mut Vec<(String, i64, i64, String, Option<String>)>,
    channels: &mut Vec<(String, String)>,
) -> Result<usize> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut added = 0usize;

    // Current <programme> being read.
    let mut cur_channel: Option<String> = None;
    let mut cur_start: Option<i64> = None;
    let mut cur_stop: Option<i64> = None;
    let mut cur_title: Option<String> = None;
    let mut cur_desc: Option<String> = None;
    let mut in_title = false;
    let mut in_desc = false;
    // Current <channel> being read (for the name index).
    let mut chan_id: Option<String> = None;
    let mut in_display_name = false;
    let mut chan_norms: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == b"channel" => {
                chan_id = None;
                chan_norms.clear();
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"id" {
                        let id = attr.unescape_value().unwrap_or_default().into_owned();
                        // Index the id itself (minus any country suffix), too.
                        let norm = normalize_name(&id);
                        if !norm.is_empty() {
                            chan_norms.push(norm);
                        }
                        chan_id = Some(id);
                    }
                }
            }
            Ok(Event::Start(e)) if e.name().as_ref() == b"display-name" => in_display_name = true,
            Ok(Event::Start(e)) if e.name().as_ref() == b"programme" => {
                cur_channel = None;
                cur_start = None;
                cur_stop = None;
                cur_title = None;
                cur_desc = None;
                for attr in e.attributes().flatten() {
                    let val = attr.unescape_value().unwrap_or_default().into_owned();
                    match attr.key.as_ref() {
                        b"channel" => cur_channel = Some(val),
                        b"start" => cur_start = parse_xmltv_time(&val),
                        b"stop" => cur_stop = parse_xmltv_time(&val),
                        _ => {}
                    }
                }
            }
            Ok(Event::Start(e)) if e.name().as_ref() == b"title" => in_title = true,
            Ok(Event::Start(e)) if e.name().as_ref() == b"desc" => in_desc = true,
            Ok(Event::Text(e)) => {
                if in_display_name {
                    let norm = normalize_name(&e.unescape().unwrap_or_default());
                    if !norm.is_empty() {
                        chan_norms.push(norm);
                    }
                } else if in_title && cur_title.is_none() {
                    cur_title = Some(e.unescape().unwrap_or_default().into_owned());
                } else if in_desc && cur_desc.is_none() {
                    cur_desc = Some(e.unescape().unwrap_or_default().into_owned());
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"display-name" => in_display_name = false,
            Ok(Event::End(e)) if e.name().as_ref() == b"title" => in_title = false,
            Ok(Event::End(e)) if e.name().as_ref() == b"desc" => in_desc = false,
            Ok(Event::End(e)) if e.name().as_ref() == b"channel" => {
                if let Some(id) = chan_id.take() {
                    chan_norms.sort();
                    chan_norms.dedup();
                    for norm in chan_norms.drain(..) {
                        channels.push((norm, id.clone()));
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"programme" => {
                if let (Some(channel), Some(start), Some(stop)) =
                    (cur_channel.take(), cur_start, cur_stop)
                    && stop > cutoff
                    && !channel.is_empty()
                {
                    out.push((
                        channel,
                        start,
                        stop,
                        cur_title.take().unwrap_or_default(),
                        cur_desc.take().filter(|d| !d.is_empty()),
                    ));
                    added += 1;
                    if out.len() >= MAX_PROGRAMMES {
                        break;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("XMLTV parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(added)
}

/// Quality / country / feed-noise tokens dropped when normalizing a channel
/// name so that, e.g., "SY: beIN Sports 1 SD 576p1", "SD: beIN Sports 1",
/// "TR - beIN SPORTS 1" and the XMLTV id "beINSPORTS1.tr" all collapse to the
/// same key "beinsports1". Includes ISO-3166 alpha-2 country codes (common as
/// leading prefixes in IPTV playlists) and quality/backup markers.
const NAME_STOPWORDS: &[&str] = &[
    // quality / format
    "sd",
    "hd",
    "fhd",
    "uhd",
    "shd",
    "hq",
    "lq",
    "4k",
    "8k",
    "2k",
    "vip",
    "raw",
    "backup",
    "bk",
    "h264",
    "h265",
    "hevc",
    "avc",
    "fullhd",
    "ultrahd",
    "hdtv",
    "fps",
    "50fps",
    "60fps",
    "multi",
    "full",
    "mobile",
    "tvchannel",
    "channel",
    "tv",
    // ISO 3166-1 alpha-2 country codes
    "af",
    "al",
    "dz",
    "ad",
    "ao",
    "ar",
    "am",
    "au",
    "at",
    "az",
    "bh",
    "bd",
    "by",
    "be",
    "bj",
    "bo",
    "ba",
    "br",
    "bg",
    "kh",
    "cm",
    "ca",
    "cl",
    "cn",
    "co",
    "cr",
    "hr",
    "cu",
    "cy",
    "cz",
    "dk",
    "do",
    "ec",
    "eg",
    "sv",
    "ee",
    "et",
    "fi",
    "fr",
    "ge",
    "de",
    "gh",
    "gr",
    "gt",
    "hn",
    "hk",
    "hu",
    "is",
    "in",
    "id",
    "ir",
    "iq",
    "ie",
    "il",
    "it",
    "jp",
    "jo",
    "kz",
    "ke",
    "kw",
    "kg",
    "lv",
    "lb",
    "ly",
    "lt",
    "lu",
    "mk",
    "my",
    "mt",
    "mx",
    "md",
    "mc",
    "me",
    "ma",
    "nl",
    "nz",
    "ng",
    "no",
    "om",
    "pk",
    "ps",
    "pa",
    "py",
    "pe",
    "ph",
    "pl",
    "pt",
    "qa",
    "ro",
    "ru",
    "sa",
    "rs",
    "sg",
    "sk",
    "si",
    "so",
    "za",
    "kr",
    "es",
    "lk",
    "sd",
    "se",
    "ch",
    "sy",
    "tw",
    "tj",
    "th",
    "tn",
    "tr",
    "tm",
    "ua",
    "ae",
    "uk",
    "gb",
    "us",
    "uy",
    "uz",
    "ve",
    "vn",
    "ye",
];

static RESOLUTION_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^\d{2,4}p\d*$").unwrap());

/// Folds the accented letters of European channel names to ASCII, so
/// "Habertürk", "Sözcü" and "Zürich" match guides that spell them plainly.
fn fold_char(c: char) -> Option<&'static str> {
    Some(match c {
        'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' | 'ą' => "a",
        'ç' | 'č' | 'ć' => "c",
        'é' | 'è' | 'ê' | 'ë' | 'ę' | 'ě' => "e",
        'ğ' => "g",
        'ı' | 'í' | 'ì' | 'î' | 'ï' => "i",
        'ł' => "l",
        'ñ' | 'ń' => "n",
        'ö' | 'ò' | 'ó' | 'ô' | 'õ' | 'ø' => "o",
        'ř' => "r",
        'ş' | 'š' | 'ś' => "s",
        'ß' => "ss",
        'ü' | 'ù' | 'ú' | 'û' | 'ů' => "u",
        'ý' => "y",
        'ž' | 'ź' | 'ż' => "z",
        // What is left of the dot of "İ" once lowercased ("i" + U+0307).
        '\u{307}' => "",
        _ => return None,
    })
}

/// Normalizes a channel name/id to a comparison key: lowercased, accents
/// folded, split on any non-alphanumeric char, quality/country/resolution
/// tokens dropped, remaining tokens concatenated. "tv" is a stopword, but
/// "TV 5" keeps it ("tv5") so it does not collapse to a bare number. Used for
/// the name-based EPG matching fallback.
pub fn normalize_name(s: &str) -> String {
    let mut folded = String::with_capacity(s.len());
    for c in s.to_lowercase().chars() {
        match fold_char(c) {
            Some(ascii) => folded.push_str(ascii),
            None => folded.push(c),
        }
    }
    let tokens: Vec<&str> = folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let mut result = String::new();
    for (i, token) in tokens.iter().enumerate() {
        let keep_tv = *token == "tv"
            && tokens
                .get(i + 1)
                .is_some_and(|next| next.chars().all(|c| c.is_ascii_digit()));
        if !keep_tv && (NAME_STOPWORDS.contains(token) || RESOLUTION_RE.is_match(token)) {
            continue;
        }
        result.push_str(token);
    }
    result
}

static COUNTRY_PREFIX_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^\s*\[?([A-Za-z]{2})\]?\s*[:|\-]").unwrap());

/// The country code a playlist name is prefixed with ("TR: Kanal D",
/// "DE| ARD", "[UK] - BBC One"), lowercased as written. "SD:" and "HD:" are
/// quality markers, not Sudan.
pub fn country_prefix(name: &str) -> Option<String> {
    let code = COUNTRY_PREFIX_RE
        .captures(name)?
        .get(1)?
        .as_str()
        .to_ascii_lowercase();
    if code == "sd" || code == "hd" {
        return None;
    }
    Some(code)
}

/// [`country_prefix`] with "uk" folded into "gb", to compare with ids.
fn country_of_name(name: &str) -> Option<String> {
    let code = country_prefix(name)?;
    Some(if code == "uk" { "gb".to_string() } else { code })
}

/// The country prefixes among `names`, most common first.
pub fn count_countries(names: &[String]) -> Vec<CountryCount> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for name in names {
        if let Some(code) = country_prefix(name) {
            *counts.entry(code.to_ascii_uppercase()).or_default() += 1;
        }
    }
    let mut out: Vec<CountryCount> = counts
        .into_iter()
        .map(|(code, count)| CountryCount { code, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.code.cmp(&b.code)));
    out
}

/// Status of every configured XMLTV source, in the configured order.
pub fn get_status() -> anyhow::Result<Vec<XmltvSourceStatus>> {
    let stored = settings::get_xmltv_status().unwrap_or_default();
    Ok(settings::get_xmltv_sources()?
        .into_iter()
        .map(|url| {
            stored.get(&url).cloned().unwrap_or(XmltvSourceStatus {
                url,
                ..Default::default()
            })
        })
        .collect())
}

/// XMLTV channels for the "assign guide" search: ids or names containing the
/// query, those with upcoming programmes first.
pub fn search_channels(query: &str) -> anyhow::Result<Vec<XmltvChannelHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let now = Utc::now().timestamp();
    let norm = normalize_name(query);
    let ids = sql::find_xmltv_channel_ids(query, &norm, 60)?;
    let counts = sql::get_xmltv_programme_counts(now)?;
    let mut hits = Vec::with_capacity(ids.len());
    for id in ids {
        let programmes = counts.get(&id).copied().unwrap_or(0);
        let now_title = if programmes > 0 {
            sql::get_xmltv_now_title(&id, now)?
        } else {
            None
        };
        hits.push(XmltvChannelHit {
            id,
            programmes,
            now_title,
        });
    }
    // Stable: keeps the shorter-id-first order among equals.
    hits.sort_by_key(|h| h.programmes == 0);
    Ok(hits)
}

/// The country suffix of an XMLTV channel id ("KanalD.tr", "BBCOne.uk").
fn country_of_id(id: &str) -> Option<String> {
    let (_, suffix) = id.rsplit_once('.')?;
    if suffix.len() != 2 || !suffix.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let code = suffix.to_ascii_lowercase();
    Some(if code == "uk" { "gb".to_string() } else { code })
}

/// Picks the XMLTV channel for a playlist channel matched by name, from
/// `(id, upcoming programme count)` candidates: ids without upcoming
/// programmes are dropped, an id from the name's country prefix wins (so
/// "TR: ATV" gets ATV.tr, not atv.de), then the id with the most programmes.
pub fn pick_channel(name: &str, candidates: Vec<(String, i64)>) -> Option<String> {
    let country = country_of_name(name);
    candidates
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .max_by(|(a_id, a_count), (b_id, b_count)| {
            let a_match = country.is_some() && country_of_id(a_id) == country;
            let b_match = country.is_some() && country_of_id(b_id) == country;
            a_match
                .cmp(&b_match)
                .then(a_count.cmp(b_count))
                // Deterministic among equals.
                .then(b_id.cmp(a_id))
        })
        .map(|(id, _)| id)
}

/// Parses an XMLTV timestamp into a unix timestamp.
/// Formats: `YYYYMMDDHHMMSS +ZZZZ`, `YYYYMMDDHHMMSS` (assumed UTC), and the
/// shorter `YYYYMMDDHHMM` variants.
fn parse_xmltv_time(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (datetime, offset) = match raw.split_once(' ') {
        Some((dt, off)) => (dt, Some(off)),
        None => (raw, None),
    };
    // Normalize to 14 digits (pad seconds if only minutes were given).
    let digits: String = datetime.chars().filter(|c| c.is_ascii_digit()).collect();
    let padded = match digits.len() {
        12 => format!("{digits}00"),
        14 => digits,
        _ => return None,
    };
    let naive = chrono::NaiveDateTime::parse_from_str(&padded, "%Y%m%d%H%M%S").ok()?;
    match offset.and_then(parse_offset) {
        Some(off) => off
            .from_local_datetime(&naive)
            .single()
            .map(|dt| dt.timestamp()),
        None => Some(Utc.from_utc_datetime(&naive).timestamp()),
    }
}

/// Parses a `+ZZZZ` / `-ZZZZ` XMLTV timezone offset.
fn parse_offset(off: &str) -> Option<FixedOffset> {
    let off = off.trim();
    let sign = match off.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let digits: String = off.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return None;
    }
    let hours: i32 = digits[0..2].parse().ok()?;
    let mins: i32 = digits[2..4].parse().ok()?;
    FixedOffset::east_opt(sign * (hours * 3600 + mins * 60))
}

/// EPG entry helper used by the get_epg fallback: current + upcoming programmes
/// for a channel's XMLTV id, mapped to the shared EPG shape.
pub fn programmes_for_channel(epg_channel_id: &str, now: i64) -> Result<Vec<XmltvProgramme>> {
    let rows = sql::get_xmltv_programmes(epg_channel_id, now)?;
    let mut out = Vec::with_capacity(rows.len());
    for (start, end, title, desc) in rows {
        out.push(XmltvProgramme {
            start,
            end,
            title,
            description: desc.unwrap_or_default(),
        });
    }
    Ok(out)
}

pub struct XmltvProgramme {
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub description: String,
}

impl XmltvProgramme {
    /// Also exposed for tests / callers that just want the raw timestamp.
    pub fn now_playing(&self, now: i64) -> bool {
        self.start <= now && now < self.end
    }
}

#[cfg(test)]
mod test_xmltv {
    use super::*;

    #[test]
    fn test_parse_time_with_offset() {
        // 2024-01-15 14:30:00 +0100 == 13:30:00 UTC
        let ts = parse_xmltv_time("20240115143000 +0100").unwrap();
        assert_eq!(
            ts,
            Utc.with_ymd_and_hms(2024, 1, 15, 13, 30, 0)
                .unwrap()
                .timestamp()
        );
    }

    #[test]
    fn test_parse_time_utc_and_no_offset() {
        let with = parse_xmltv_time("20240115143000 +0000").unwrap();
        let without = parse_xmltv_time("20240115143000").unwrap();
        assert_eq!(with, without);
        assert_eq!(
            with,
            Utc.with_ymd_and_hms(2024, 1, 15, 14, 30, 0)
                .unwrap()
                .timestamp()
        );
    }

    #[test]
    fn test_parse_minutes_only() {
        // 12-digit form (no seconds) should pad to :00
        let ts = parse_xmltv_time("202401151430 +0000").unwrap();
        assert_eq!(
            ts,
            Utc.with_ymd_and_hms(2024, 1, 15, 14, 30, 0)
                .unwrap()
                .timestamp()
        );
    }

    #[test]
    fn test_parse_xmltv_extracts_programmes_and_channels() {
        let xml = r#"<tv>
          <channel id="beINSPORTS1.tr"><display-name>TR - beIN SPORTS 1</display-name></channel>
          <programme start="20240115140000 +0000" stop="20240115150000 +0000" channel="beINSPORTS1.tr">
            <title>News</title><desc>Evening news</desc>
          </programme>
          <programme start="20200101000000 +0000" stop="20200101010000 +0000" channel="beINSPORTS1.tr">
            <title>Ancient</title>
          </programme>
        </tv>"#;
        let mut out = Vec::new();
        let mut channels = Vec::new();
        // cutoff in 2023 drops the 2020 programme.
        let cutoff = Utc
            .with_ymd_and_hms(2023, 1, 1, 0, 0, 0)
            .unwrap()
            .timestamp();
        let added = parse_xmltv(xml, cutoff, &mut out, &mut channels).unwrap();
        assert_eq!(added, 1);
        assert_eq!(out[0].0, "beINSPORTS1.tr");
        assert_eq!(out[0].3, "News");
        assert_eq!(out[0].4.as_deref(), Some("Evening news"));
        // Both the id and the display-name normalize to the same key -> one entry.
        assert!(channels.contains(&("beinsports1".to_string(), "beINSPORTS1.tr".to_string())));
    }

    #[test]
    fn test_country_prefix_and_counts() {
        assert_eq!(country_prefix("TR: Kanal D").as_deref(), Some("tr"));
        assert_eq!(country_prefix("[UK] - BBC One").as_deref(), Some("uk"));
        assert_eq!(country_prefix("DE| ARD").as_deref(), Some("de"));
        assert_eq!(country_prefix("SD: beIN Sports 1"), None);
        assert_eq!(country_prefix("HD: beIN Sports 1"), None);
        assert_eq!(country_prefix("Kanal D"), None);
        let names: Vec<String> = ["TR: A", "TR: B", "DE: C", "tr | D", "E"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let counts = count_countries(&names);
        assert_eq!(counts.len(), 2);
        assert_eq!((counts[0].code.as_str(), counts[0].count), ("TR", 3));
        assert_eq!((counts[1].code.as_str(), counts[1].count), ("DE", 1));
    }

    #[test]
    fn test_pick_channel_prefers_country_then_programmes() {
        let c = |v: &[(&str, i64)]| -> Vec<(String, i64)> {
            v.iter().map(|(id, n)| (id.to_string(), *n)).collect()
        };
        let atv = c(&[("atv.de", 325), ("ATV.tr", 86), ("ATV.HD.tr", 22)]);
        assert_eq!(
            pick_channel("TR: ATV", atv.clone()).as_deref(),
            Some("ATV.tr")
        );
        assert_eq!(
            pick_channel("DE| ATV", atv.clone()).as_deref(),
            Some("atv.de")
        );
        // Without a country prefix the fullest guide wins.
        assert_eq!(pick_channel("ATV", atv).as_deref(), Some("atv.de"));
        // An id without upcoming programmes is never picked.
        let stale = c(&[("KanalD.tr", 0), ("KANAL.D.tr", 21)]);
        assert_eq!(
            pick_channel("TR: Kanal D", stale).as_deref(),
            Some("KANAL.D.tr")
        );
        assert_eq!(pick_channel("TR: Kanal D", c(&[("KanalD.tr", 0)])), None);
        // "UK" in a playlist means the "gb"/"uk" ids alike.
        let bbc = c(&[("BBCOne.us", 50), ("BBCOne.uk", 40)]);
        assert_eq!(
            pick_channel("UK: BBC One", bbc).as_deref(),
            Some("BBCOne.uk")
        );
    }

    #[test]
    fn test_normalize_name_matches_across_prefixes() {
        assert_eq!(normalize_name("SD: beIN Sports 1"), "beinsports1");
        assert_eq!(normalize_name("HD: beIN Sports 1"), "beinsports1");
        assert_eq!(normalize_name("TR - beIN SPORTS 1"), "beinsports1");
        assert_eq!(normalize_name("beINSPORTS1.tr"), "beinsports1");
        // Messy provider names: country prefix + quality + resolution token.
        assert_eq!(normalize_name("SY: beIN Sports 1 SD 576p1"), "beinsports1");
        assert_eq!(normalize_name("DE| beIN Sports 1 FHD 1080p"), "beinsports1");
        assert_eq!(normalize_name("Full HD: beIN Sports 1"), "beinsports1");
        // Accents fold, both in playlist names and guide display names.
        assert_eq!(
            normalize_name("TR: TH Türkhaber"),
            normalize_name("TH.Turkhaber.tr")
        );
        assert_eq!(normalize_name("TR: Sözcü TV"), "sozcu");
        assert_eq!(normalize_name("İZMİR TV"), "izmir");
        // "TV 5" is not just "5", and matches the id "TV5.tr".
        assert_eq!(normalize_name("TR: TV 5"), "tv5");
        assert_eq!(normalize_name("TV5.tr"), "tv5");
        assert_eq!(normalize_name("TR: TV8"), "tv8");
    }
}
