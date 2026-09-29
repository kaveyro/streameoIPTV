use std::sync::LazyLock;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
};
use tokio::io::AsyncWriteExt;

use anyhow::{Context, Result, bail};
use regex::{Captures, Regex};
use rusqlite::Transaction;
use types::{Channel, Source};

use crate::types::ChannelPreserve;
use crate::{
    log, media_type,
    sql::{self, set_channel_group_id},
    types::{self, ChannelHttpHeaders},
    utils::{download_client_builder, get_user_agent_from_source},
};

static NAME_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-name="(?P<name>[^"]*)""#).unwrap());
static NAME_REGEX_ALT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#",(?P<name>[^\n\r\t]*)"#).unwrap());
static ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-id="(?P<id>[^"]*)""#).unwrap());
static LOGO_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-logo="(?P<logo>[^"]*)""#).unwrap());
static GROUP_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"group-title="(?P<group>[^"]*)""#).unwrap());

static HTTP_ORIGIN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-origin=(?P<origin>.+)"#).unwrap());
static HTTP_REFERRER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-referrer=(?P<referrer>.+)"#).unwrap());
static HTTP_USER_AGENT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-user-agent=(?P<user_agent>.+)"#).unwrap());

struct M3UProcessing {
    channel_line: Option<String>,
    channel_headers: Option<ChannelHttpHeaders>,
    channel_headers_set: bool,
    last_non_empty_line: Option<String>,
    groups: HashMap<String, i64>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    line_count: usize,
}

pub fn read_m3u8(source: Source, wipe: bool) -> Result<()> {
    let path = source.url.clone().context("no file path found")?;
    read_m3u8_file(&path, source, wipe)
}

fn read_m3u8_file(path: &str, mut source: Source, wipe: bool) -> Result<()> {
    let file = File::open(path).context("Failed to open m3u8 file")?;
    let reader = BufReader::new(file);
    let lines = reader.lines().enumerate();
    let mut sql = sql::get_conn()?;
    let mut channel_preserve: Vec<ChannelPreserve> = Vec::new();
    let mut recording_preserve: Vec<(i64, String)> = Vec::new();
    let tx = sql.transaction()?;
    if wipe {
        channel_preserve =
            sql::get_preserve(&tx, source.id.context("no source id")?).unwrap_or_default();
        recording_preserve = sql::get_recording_preserve(&tx, source.id.context("no source id")?)?;
        sql::wipe(&tx, source.id.context("no source id")?)?;
    } else {
        source.id = Some(sql::create_or_find_source_by_name(&tx, &source)?);
    }
    let mut processing = M3UProcessing {
        channel_headers: None,
        channel_headers_set: false,
        channel_line: None,
        groups: HashMap::new(),
        last_non_empty_line: None,
        source_id: source.id.context("no source id")?,
        use_tvg_id: source.use_tvg_id,
        line_count: 0,
    };
    for (c1, l1) in lines {
        processing.line_count = c1;
        let l1 = match l1.with_context(|| format!("Failed to process line {c1}")) {
            Ok(r) => r,
            Err(e) => {
                log::log(format!("{:?}", e));
                continue;
            }
        };
        let l1_upper = l1.to_uppercase();
        if l1_upper.starts_with("#EXTINF") {
            try_commit_channel(&mut processing, &tx);
            processing.channel_line = Some(l1);
            processing.channel_headers_set = false;
        } else if l1_upper.starts_with("#EXTVLCOPT") {
            if processing.channel_headers.is_none() {
                processing.channel_headers = Some(ChannelHttpHeaders {
                    ..Default::default()
                });
            }
            if set_http_headers(
                &l1,
                processing.channel_headers.as_mut().context("no headers")?,
            ) {
                processing.channel_headers_set = true;
            }
        } else if !l1.trim().is_empty() {
            processing.last_non_empty_line = Some(l1);
        }
    }
    try_commit_channel(&mut processing, &tx);
    if wipe {
        sql::restore_preserve(&tx, source.id.context("no source id")?, channel_preserve)?;
        sql::restore_recording_preserve(
            &tx,
            source.id.context("no source id")?,
            recording_preserve,
        )?;
    }
    sql::analyze(&tx)?;
    tx.commit()?;
    Ok(())
}

fn try_commit_channel(processing: &mut M3UProcessing, tx: &Transaction) {
    if let Some(channel) = processing.channel_line.take() {
        if !processing.channel_headers_set {
            processing.channel_headers = None;
        }
        commit_channel(
            channel,
            processing.last_non_empty_line.take(),
            &mut processing.groups,
            processing.channel_headers.take(),
            processing.source_id,
            processing.use_tvg_id,
            tx,
        )
        .with_context(|| {
            format!(
                "Failed to process channel ending at line {}",
                processing.line_count
            )
        })
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e));
        });
    }
}

fn commit_channel(
    channel_line: String,
    last_line: Option<String>,
    groups: &mut HashMap<String, i64>,
    headers: Option<ChannelHttpHeaders>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    tx: &Transaction,
) -> Result<()> {
    let mut channel = get_channel_from_lines(
        channel_line,
        last_line.context("missing last line")?,
        source_id,
        use_tvg_id,
    )?;
    set_channel_group_id(groups, &mut channel, tx, &source_id).unwrap_or_else(|e| {
        log::log(format!(
            "Failed to set group id for channel: {}, Error: {:?}",
            channel.name, e
        ))
    });
    sql::insert_channel(tx, channel)?;
    if let Some(mut headers) = headers {
        headers.channel_id = Some(tx.last_insert_rowid());
        sql::insert_channel_headers(tx, headers)?;
    }
    Ok(())
}

pub async fn get_m3u8_from_link(source: Source, wipe: bool) -> Result<()> {
    let user_agent = get_user_agent_from_source(&source)?;
    // Playlists can be very large, so only a connect timeout is applied here.
    let client = download_client_builder().user_agent(user_agent).build()?;
    let url = source.url.clone().context("Invalid source")?;
    let mut response = client.get(&url).send().await?;
    if !response.status().is_success() {
        log::log(format!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        ));
        bail!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        );
    }
    // One file per download: two link sources refreshing at the same time
    // (auto refresh + a manual one) used to overwrite each other's playlist.
    let path = get_tmp_path()?;
    let result = async {
        let mut file = tokio::fs::File::create(&path).await?;
        while let Some(chunk) = response.chunk().await? {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        let parse_path = path.clone();
        // Parsing and the insert transaction take seconds on big playlists;
        // keep them off the async runtime's worker threads.
        tokio::task::spawn_blocking(move || read_m3u8_file(&parse_path, source, wipe)).await?
    }
    .await;
    let _ = std::fs::remove_file(&path);
    result
}

fn get_tmp_path() -> Result<String> {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let mut path = directories::ProjectDirs::from("dev", "kaveyro", "streameoIPTV")
        .context("project dir not found")?
        .cache_dir()
        .to_owned();
    std::fs::create_dir_all(&path)?;
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.push(format!("get-{}-{n}.m3u", std::process::id()));
    Ok(path.to_string_lossy().to_string())
}

fn extract_non_empty_capture(caps: Captures) -> Option<String> {
    caps.get(1)
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.trim().is_empty())
}

fn set_http_headers(line: &str, headers: &mut ChannelHttpHeaders) -> bool {
    if let Some(origin) = HTTP_ORIGIN_REGEX
        .captures(line)
        .and_then(extract_non_empty_capture)
    {
        headers.http_origin = Some(origin);
        return true;
    } else if let Some(referrer) = HTTP_REFERRER_REGEX
        .captures(line)
        .and_then(extract_non_empty_capture)
    {
        headers.referrer = Some(referrer);
        return true;
    } else if let Some(user_agent) = HTTP_USER_AGENT_REGEX
        .captures(line)
        .and_then(extract_non_empty_capture)
    {
        headers.user_agent = Some(user_agent);
        return true;
    }
    false
}

fn get_channel_from_lines(
    first: String,
    mut second: String,
    source_id: i64,
    use_tvg_id: Option<bool>,
) -> Result<Channel> {
    second = second.trim().to_string();
    if second.is_empty() {
        bail!("second line is empty");
    }
    let name = NAME_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture)
        .or_else(|| {
            let id = || {
                ID_REGEX
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            let name_alt = || {
                NAME_REGEX_ALT
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            if let Some(true) = use_tvg_id {
                id().or(name_alt())
            } else {
                name_alt().or(id())
            }
        })
        .context("Couldn't find name from Name or ID")?;
    let group = GROUP_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    let image = LOGO_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    // Capture tvg-id independently of the name logic so external XMLTV EPG can
    // be matched to this channel even when the name is derived from something else.
    let epg_channel_id = ID_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture)
        .map(|x| x.trim().to_string());
    let channel = Channel {
        id: None,
        name: name.trim().to_string(),
        group: group.map(|x| x.trim().to_string()),
        image: image.map(|x| x.trim().to_string()),
        url: Some(second.clone()),
        media_type: get_media_type(second),
        source_id: Some(source_id),
        series_id: None,
        group_id: None,
        favorite: false,
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: Some(false),
        epg_channel_id,
    };
    Ok(channel)
}

/// Exports all favorited channels as a standard M3U playlist at `path`.
pub fn export_favorites(path: String) -> Result<()> {
    let channels = sql::get_favorites_for_export()?;
    let content = build_favorites_m3u(&channels)?;
    std::fs::write(path, content)?;
    Ok(())
}

/// Builds the M3U document for the given channels:
/// ```text
/// #EXTM3U
/// #EXTINF:-1 tvg-logo="<image>" group-title="<group>",<name>
/// <url>
/// ```
/// Channels without a url are skipped; an empty input is an error so the
/// frontend can toast it.
fn build_favorites_m3u(channels: &[Channel]) -> Result<String> {
    if channels.is_empty() {
        bail!("No favorites to export");
    }
    let mut content = String::from("#EXTM3U\n");
    for channel in channels {
        let url = match channel.url.as_deref().filter(|u| !u.trim().is_empty()) {
            Some(url) => url,
            None => continue,
        };
        content.push_str(&format!(
            "#EXTINF:-1 tvg-logo=\"{}\" group-title=\"{}\",{}\n{}\n",
            escape_m3u_attribute(channel.image.as_deref().unwrap_or("")),
            escape_m3u_attribute(channel.group.as_deref().unwrap_or("")),
            strip_newlines(&channel.name),
            url
        ));
    }
    Ok(content)
}

/// Strips double quotes (which would terminate the attribute) and flattens
/// newlines so a value cannot break the one-channel-per-two-lines format.
fn escape_m3u_attribute(value: &str) -> String {
    strip_newlines(&value.replace('"', ""))
}

fn strip_newlines(value: &str) -> String {
    value
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string()
}

fn get_media_type(url: String) -> u8 {
    if url.ends_with(".mp4") || url.ends_with(".mkv") {
        media_type::MOVIE
    } else {
        media_type::LIVESTREAM
    }
}

#[cfg(test)]
mod test_m3u {
    use super::{build_favorites_m3u, get_channel_from_lines, get_media_type, set_http_headers};
    use crate::{
        media_type,
        types::{Channel, ChannelHttpHeaders},
    };

    fn favorite(
        name: &str,
        url: Option<&str>,
        group: Option<&str>,
        image: Option<&str>,
    ) -> Channel {
        Channel {
            id: None,
            name: name.to_string(),
            url: url.map(str::to_string),
            group: group.map(str::to_string),
            image: image.map(str::to_string),
            media_type: media_type::LIVESTREAM,
            source_id: None,
            series_id: None,
            group_id: None,
            favorite: true,
            stream_id: None,
            tv_archive: None,
            season_id: None,
            episode_num: None,
            hidden: Some(false),
            epg_channel_id: None,
        }
    }

    #[test]
    fn test_build_favorites_m3u_formatting() {
        let channels = vec![
            favorite(
                "Channel One",
                Some("http://myurl.local/1"),
                Some("News"),
                Some("http://myurl.local/logo1.png"),
            ),
            favorite("Bare Channel", Some("http://myurl.local/2"), None, None),
        ];
        let content = build_favorites_m3u(&channels).unwrap();
        assert_eq!(
            content,
            "#EXTM3U\n\
             #EXTINF:-1 tvg-logo=\"http://myurl.local/logo1.png\" group-title=\"News\",Channel One\n\
             http://myurl.local/1\n\
             #EXTINF:-1 tvg-logo=\"\" group-title=\"\",Bare Channel\n\
             http://myurl.local/2\n"
        );
    }

    #[test]
    fn test_build_favorites_m3u_escapes_attributes() {
        let channels = vec![favorite(
            "Tricky\nName",
            Some("http://myurl.local/3"),
            Some("Group \"quoted\"\r\nwith newline"),
            Some("http://myurl.local/lo\"go.png"),
        )];
        let content = build_favorites_m3u(&channels).unwrap();
        assert_eq!(
            content,
            "#EXTM3U\n\
             #EXTINF:-1 tvg-logo=\"http://myurl.local/logo.png\" group-title=\"Group quoted with newline\",Tricky Name\n\
             http://myurl.local/3\n"
        );
    }

    #[test]
    fn test_build_favorites_m3u_skips_channels_without_url() {
        let channels = vec![
            favorite("No Url", None, None, None),
            favorite("Blank Url", Some("   "), None, None),
            favorite("Has Url", Some("http://myurl.local/4"), None, None),
        ];
        let content = build_favorites_m3u(&channels).unwrap();
        assert!(!content.contains("No Url"));
        assert!(!content.contains("Blank Url"));
        assert!(content.contains("Has Url"));
    }

    #[test]
    fn test_build_favorites_m3u_empty_errors() {
        let result = build_favorites_m3u(&[]);
        assert_eq!(result.unwrap_err().to_string(), "No favorites to export");
    }

    #[test]
    fn test_standard_extinf_with_all_attributes() {
        let channel = get_channel_from_lines(
            r#"#EXTINF:-1 tvg-id="chan.one" tvg-name="Channel One" tvg-logo="http://myurl.local/logos/one.png" group-title="News",Channel One"#.to_string(),
            "http://myurl.local/1234/5678/9".to_string(),
            42,
            None,
        )
        .unwrap();
        assert_eq!(channel.name, "Channel One");
        assert_eq!(channel.group.as_deref(), Some("News"));
        assert_eq!(
            channel.image.as_deref(),
            Some("http://myurl.local/logos/one.png")
        );
        assert_eq!(
            channel.url.as_deref(),
            Some("http://myurl.local/1234/5678/9")
        );
        assert_eq!(channel.source_id, Some(42));
        assert_eq!(channel.media_type, media_type::LIVESTREAM);
    }

    #[test]
    fn test_extinf_with_missing_attributes() {
        // No tvg-id, tvg-logo or group-title; name comes from the text after the comma
        let channel = get_channel_from_lines(
            "#EXTINF:-1,Bare Channel".to_string(),
            "http://myurl.local/stream".to_string(),
            0,
            None,
        )
        .unwrap();
        assert_eq!(channel.name, "Bare Channel");
        assert_eq!(channel.group, None);
        assert_eq!(channel.image, None);
        assert_eq!(channel.media_type, media_type::LIVESTREAM);
    }

    #[test]
    fn test_group_title_with_special_characters() {
        // Note: tvg-name is used for the channel name here because the
        // fallback "name after comma" heuristic keys off the first comma in
        // the line, which may sit inside a group-title containing commas.
        let channel = get_channel_from_lines(
            r#"#EXTINF:-1 tvg-name="Some Channel" group-title="|EU| Fußball & Sport, +18 (HD) [50%]",Some Channel"#
                .to_string(),
            "http://myurl.local/stream.ts".to_string(),
            0,
            None,
        )
        .unwrap();
        assert_eq!(
            channel.group.as_deref(),
            Some("|EU| Fußball & Sport, +18 (HD) [50%]")
        );
        assert_eq!(channel.name, "Some Channel");
    }

    #[test]
    fn test_media_type_detection() {
        assert_eq!(
            get_media_type("http://myurl.local/movie.mp4".to_string()),
            media_type::MOVIE
        );
        assert_eq!(
            get_media_type("http://myurl.local/movie.mkv".to_string()),
            media_type::MOVIE
        );
        assert_eq!(
            get_media_type("http://myurl.local/live/1234.ts".to_string()),
            media_type::LIVESTREAM
        );
        assert_eq!(
            get_media_type("http://myurl.local/live/1234".to_string()),
            media_type::LIVESTREAM
        );
        let movie = get_channel_from_lines(
            "#EXTINF:-1,A Movie".to_string(),
            "http://myurl.local/vod/a-movie.mp4".to_string(),
            0,
            None,
        )
        .unwrap();
        assert_eq!(movie.media_type, media_type::MOVIE);
    }

    #[test]
    fn test_malformed_lines_are_rejected_without_panic() {
        // Empty URL line
        assert!(
            get_channel_from_lines("#EXTINF:-1,Named".to_string(), "   ".to_string(), 0, None)
                .is_err()
        );
        // No name anywhere (no tvg-id, no tvg-name, nothing after a comma)
        assert!(
            get_channel_from_lines(
                "#EXTINF:-1".to_string(),
                "http://myurl.local/stream".to_string(),
                0,
                None
            )
            .is_err()
        );
        // Garbage first line without any recognizable attribute
        assert!(
            get_channel_from_lines(
                "complete nonsense without markers".to_string(),
                "http://myurl.local/stream".to_string(),
                0,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn test_set_http_headers() {
        let mut headers = ChannelHttpHeaders {
            ..Default::default()
        };
        assert!(set_http_headers(
            "#EXTVLCOPT:http-referrer=http://myurl.local/",
            &mut headers
        ));
        assert!(set_http_headers(
            "#EXTVLCOPT:http-user-agent=CoolAgent/1.0",
            &mut headers
        ));
        assert_eq!(headers.referrer.as_deref(), Some("http://myurl.local/"));
        assert_eq!(headers.user_agent.as_deref(), Some("CoolAgent/1.0"));
        assert!(!set_http_headers(
            "#EXTVLCOPT:unknown-option=x",
            &mut headers
        ));
    }

    #[test]
    fn test_get_channel_from_lines() {
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="Amazing Channel" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0,Some(true)).unwrap();
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).unwrap();
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id=" " tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="Name Of Channel" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Name Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Id Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(false)).unwrap().name == "Alt Name Of Channel");
    }
}
