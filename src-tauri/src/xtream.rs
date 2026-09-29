use crate::log;
use crate::media_type;
use crate::source_type;
use crate::sql;
use crate::sql::insert_season;
use crate::types::Channel;
use crate::types::ChannelPreserve;
use crate::types::EPG;
use crate::types::Season;
use crate::types::Source;
use crate::types::XtreamLogin;
use crate::types::XtreamStatus;
use crate::utils::api_client_builder;
use crate::utils::download_client_builder;
use crate::utils::get_local_time;
use crate::utils::get_user_agent_from_source;
use anyhow::anyhow;
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use chrono::DateTime;
use chrono::Local;
use chrono::NaiveDateTime;
use futures::future::join_all;
use rusqlite::Transaction;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;
use tokio::join;
use url::Url;

const GET_LIVE_STREAMS: &str = "get_live_streams";
const GET_VODS: &str = "get_vod_streams";
const GET_SERIES: &str = "get_series";
const GET_SERIES_INFO: &str = "get_series_info";
const GET_SERIES_CATEGORIES: &str = "get_series_categories";
const GET_LIVE_STREAM_CATEGORIES: &str = "get_live_categories";
const GET_VOD_CATEGORIES: &str = "get_vod_categories";
const GET_EPG: &str = "get_simple_data_table";
const LIVE_STREAM_EXTENSION: &str = "ts";
const NO_SEASON_NUMBER: i64 = -9999;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamStream {
    #[serde(default)]
    stream_id: serde_json::Value,
    name: Option<String>,
    #[serde(default)]
    category_id: serde_json::Value,
    stream_icon: Option<String>,
    #[serde(default)]
    series_id: serde_json::Value,
    cover: Option<String>,
    container_extension: Option<String>,
    #[serde(default)]
    tv_archive: serde_json::Value,
    #[serde(default)]
    epg_channel_id: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamSeries {
    seasons: Vec<XtreamSeason>,
    episodes: HashMap<String, Vec<XtreamEpisode>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamSeason {
    #[serde(default)]
    season_number: serde_json::Value,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    cover: Option<String>,
    #[serde(default)]
    cover_tmdb: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEpisode {
    id: serde_json::Value,
    title: String,
    container_extension: String,
    #[serde(default)]
    episode_num: serde_json::Value,
    #[serde(default)]
    season: serde_json::Value,
    #[serde(default)]
    info: serde_json::Value,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEpisodeInfo {
    movie_image: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamCategory {
    #[serde(default)]
    category_id: serde_json::Value,
    category_name: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEPG {
    epg_listings: Vec<XtreamEPGItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEPGItem {
    id: serde_json::Value,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    start_timestamp: serde_json::Value,
    stop_timestamp: serde_json::Value,
    // Numbers on most panels, strings ("1") on others.
    #[serde(default)]
    now_playing: serde_json::Value,
    #[serde(default)]
    has_archive: serde_json::Value,
    #[serde(default)]
    start: String,
    #[serde(default)]
    end: String,
}

/// The Xtream login inside an M3U link of an Xtream server
/// (`http://host:port/get.php?username=u&password=p&type=m3u_plus`). Such a
/// source imports much better as Xtream: provider EPG, catch-up and series.
pub fn login_from_m3u_url(url: &str) -> Option<XtreamLogin> {
    let mut url = Url::parse(url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let last = url.path_segments()?.next_back()?.to_ascii_lowercase();
    if last != "get.php" {
        return None;
    }
    let query = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let username = query("username")?;
    let password = query("password")?;
    url.path_segments_mut().ok()?.pop().push("player_api.php");
    url.set_query(None);
    url.set_fragment(None);
    Some(XtreamLogin {
        url: url.to_string(),
        username,
        password,
    })
}

/// Re-imports an M3U link source of an Xtream server as an Xtream source.
/// Favorites, history, hidden and locked groups and scheduled recordings are
/// carried over by name, as on a refresh; the source only switches type once
/// the import worked.
pub async fn convert_from_m3u(source_id: i64) -> Result<()> {
    let source = sql::get_source_from_id(source_id)?;
    if source.source_type != source_type::M3U_LINK {
        anyhow::bail!("only M3U link sources can be converted");
    }
    let login = source
        .url
        .as_deref()
        .and_then(login_from_m3u_url)
        .context("the link contains no Xtream login")?;
    let converted = Source {
        source_type: source_type::XTREAM,
        url: Some(login.url),
        username: Some(login.username),
        password: Some(login.password),
        use_tvg_id: None,
        ..source
    };
    get_xtream(converted.clone(), true).await?;
    sql::convert_source_to_xtream(&converted)?;
    Ok(())
}

fn build_xtream_url(source: &mut Source) -> Result<Url> {
    let mut url = Url::parse(&source.url.clone().context("Missing URL")?)?;
    source.url_origin = Some(
        Url::from_str(&source.url.clone().unwrap())?
            .origin()
            .ascii_serialization(),
    );
    url.query_pairs_mut()
        .append_pair(
            "username",
            &source.username.clone().context("Missing username")?,
        )
        .append_pair(
            "password",
            &source.password.clone().context("Missing password")?,
        );
    Ok(url)
}

pub async fn get_xtream(mut source: Source, wipe: bool) -> Result<()> {
    let url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let (live, live_cats, vods, vods_cats, series, series_cats) = join!(
        get_xtream_http_data::<Vec<XtreamStream>>(url.clone(), GET_LIVE_STREAMS, &user_agent),
        get_xtream_http_data::<Vec<XtreamCategory>>(
            url.clone(),
            GET_LIVE_STREAM_CATEGORIES,
            &user_agent
        ),
        get_xtream_http_data::<Vec<XtreamStream>>(url.clone(), GET_VODS, &user_agent),
        get_xtream_http_data::<Vec<XtreamCategory>>(url.clone(), GET_VOD_CATEGORIES, &user_agent),
        get_xtream_http_data::<Vec<XtreamStream>>(url.clone(), GET_SERIES, &user_agent),
        get_xtream_http_data::<Vec<XtreamCategory>>(
            url.clone(),
            GET_SERIES_CATEGORIES,
            &user_agent
        ),
    );
    // The inserts run for seconds on large providers; keep them off the
    // async runtime's worker threads.
    tokio::task::spawn_blocking(move || {
        store_xtream(
            source,
            wipe,
            live,
            live_cats,
            vods,
            vods_cats,
            series,
            series_cats,
        )
    })
    .await?
}

type Fetched<T> = Result<Vec<T>>;

#[allow(clippy::too_many_arguments)]
fn store_xtream(
    mut source: Source,
    wipe: bool,
    live: Fetched<XtreamStream>,
    live_cats: Fetched<XtreamCategory>,
    vods: Fetched<XtreamStream>,
    vods_cats: Fetched<XtreamCategory>,
    series: Fetched<XtreamStream>,
    series_cats: Fetched<XtreamCategory>,
) -> Result<()> {
    let mut sql = sql::get_conn()?;
    let tx = sql.transaction()?;
    let mut channel_preserve: Vec<ChannelPreserve> = Vec::new();
    // Media types that already have channels: on a refresh, losing one of
    // these to a failed request would delete them together with their
    // favorites and history, so any such failure aborts the whole refresh.
    let mut existing_types: Vec<u8> = Vec::new();
    let mut recording_preserve: Vec<(i64, String)> = Vec::new();
    if wipe {
        recording_preserve = sql::get_recording_preserve(&tx, source.id.context("no source id")?)?;
        existing_types = sql::get_media_types_of_source(&tx, source.id.context("no source id")?)?;
        channel_preserve =
            sql::get_preserve(&tx, source.id.context("no source id")?).unwrap_or_default();
        sql::wipe(&tx, source.id.context("Source should have id")?)?;
    } else {
        source.id = Some(sql::create_or_find_source_by_name(&tx, &source)?);
    }
    let mut failed: Vec<u8> = Vec::new();
    live.and_then(|live| process_xtream(&tx, live, live_cats?, &source, media_type::LIVESTREAM))
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e.context("Failed to process live")));
            failed.push(media_type::LIVESTREAM);
        });
    vods.and_then(|vods: Vec<XtreamStream>| {
        process_xtream(&tx, vods, vods_cats?, &source, media_type::MOVIE)
    })
    .unwrap_or_else(|e| {
        log::log(format!("{:?}", e.context("Failed to process vods")));
        failed.push(media_type::MOVIE);
    });
    series
        .and_then(|series: Vec<XtreamStream>| {
            process_xtream(&tx, series, series_cats?, &source, media_type::SERIE)
        })
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e.context("Failed to process series")));
            failed.push(media_type::SERIE);
        });
    if let Some(reason) = xtream_failure(&failed, &existing_types) {
        match tx.rollback() {
            Ok(_) => {}
            Err(e) => log::log(format!("Failed to rollback tx: {:?}", e)),
        }
        return Err(anyhow::anyhow!(reason));
    }
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

/// Decides whether a refresh with the given failed media types must be rolled
/// back. A provider that simply offers no series is fine; a timeout on a
/// category the source already has would wipe it, so that aborts.
fn xtream_failure(failed: &[u8], existing: &[u8]) -> Option<&'static str> {
    if failed.len() >= 3 {
        return Some("All Xtream requests failed");
    }
    if failed.iter().any(|t| existing.contains(t)) {
        return Some("Some Xtream requests failed, keeping the previous channel list");
    }
    None
}

async fn get_xtream_http_data<T>(mut url: Url, action: &str, user_agent: &String) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    // Full channel/VOD/series lists can be very large on some providers,
    // so only a connect timeout is applied here (no total-request timeout).
    let client = download_client_builder().user_agent(user_agent).build()?;
    url.query_pairs_mut().append_pair("action", action);
    let data = client.get(url).send().await?.json::<T>().await?;
    Ok(data)
}

fn process_xtream(
    tx: &Transaction,
    streams: Vec<XtreamStream>,
    cats: Vec<XtreamCategory>,
    source: &Source,
    stream_type: u8,
) -> Result<()> {
    let cats: HashMap<String, String> = cats
        .into_iter()
        .filter_map(|f| {
            let category_id = get_serde_json_string(&f.category_id);
            category_id.map(|cid| (cid, f.category_name))
        })
        .collect();
    let mut groups: HashMap<String, i64> = HashMap::new();
    for live in streams {
        let category_name = get_cat_name(&cats, get_serde_json_string(&live.category_id));
        convert_xtream_live_to_channel(live, source, stream_type, category_name)
            .and_then(|mut channel| {
                sql::set_channel_group_id(
                    &mut groups,
                    &mut channel,
                    tx,
                    source.id.as_ref().unwrap(),
                )
                .unwrap_or_else(|e| log::log(format!("{:?}", e)));
                sql::insert_channel(tx, channel)?;
                Ok(())
            })
            .unwrap_or_else(|e| log::log(format!("{:?}", e)));
    }
    Ok(())
}

fn get_cat_name(cats: &HashMap<String, String>, category_id: Option<String>) -> Option<String> {
    category_id.as_ref()?;
    cats.get(&category_id.unwrap()).map(|t| t.to_string())
}

fn convert_xtream_live_to_channel(
    stream: XtreamStream,
    source: &Source,
    stream_type: u8,
    category_name: Option<String>,
) -> Result<Channel> {
    let stream_id = get_serde_json_u64(&stream.stream_id);
    Ok(Channel {
        id: None,
        group: category_name.map(|x| x.trim().to_string()),
        image: stream
            .stream_icon
            .or(stream.cover)
            .map(|x| x.trim().to_string()),
        media_type: stream_type,
        name: stream.name.context("No name")?.trim().to_string(),
        source_id: source.id,
        url: if stream_type == media_type::SERIE {
            get_serde_json_string(&stream.series_id)
        } else {
            Some(get_url(
                stream_id.context("missing stream id")?.to_string(),
                source,
                stream_type,
                stream.container_extension,
            )?)
        },
        stream_id,
        favorite: false,
        group_id: None,
        series_id: None,
        tv_archive: get_serde_json_u64(&stream.tv_archive).map(|x| x == 1),
        season_id: None,
        episode_num: None,
        hidden: Some(false),
        epg_channel_id: stream
            .epg_channel_id
            .filter(|x| !x.trim().is_empty())
            .map(|x| x.trim().to_string()),
    })
}

fn get_url(
    stream_id: String,
    source: &Source,
    stream_type: u8,
    extension: Option<String>,
) -> Result<String> {
    // Built segment by segment so a password containing `/`, `#` or `?` is
    // percent-encoded instead of producing a broken stream URL.
    let mut url = Url::parse(source.url_origin.as_deref().context("no origin")?)?;
    url.path_segments_mut()
        .map_err(|_| anyhow!("Can't mutate url"))?
        .pop_if_empty()
        .push(&get_media_type_string(stream_type)?)
        .push(source.username.as_deref().context("no username")?)
        .push(source.password.as_deref().context("no password")?)
        .push(&format!(
            "{}.{}",
            stream_id,
            extension.unwrap_or(LIVE_STREAM_EXTENSION.to_string())
        ));
    Ok(url.to_string())
}

fn get_media_type_string(stream_type: u8) -> Result<String> {
    match stream_type {
        media_type::LIVESTREAM => Ok("live".to_string()),
        media_type::MOVIE => Ok("movie".to_string()),
        media_type::SERIE => Ok("series".to_string()),
        _ => Err(anyhow!("Invalid stream_type")),
    }
}

pub async fn get_episodes(channel: Channel) -> Result<()> {
    let series_id = channel.url.context("no url")?.parse()?;
    if sql::series_has_episodes(series_id, channel.source_id.context("no source id")?)
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e));
            false
        })
    {
        return Ok(());
    }
    let mut source = sql::get_source_from_id(channel.source_id.context("no source id")?)?;
    let mut url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    url.query_pairs_mut()
        .append_pair("series_id", &series_id.to_string());
    let mut series =
        get_xtream_http_data::<XtreamSeries>(url, GET_SERIES_INFO, &user_agent).await?;
    let mut episodes: Vec<XtreamEpisode> = series.episodes.into_values().flatten().collect();
    series
        .seasons
        .sort_by_key(|f| get_serde_json_i64(&f.season_number));
    let seasons: HashMap<i64, XtreamSeason> = series
        .seasons
        .iter()
        .filter_map(|x| get_serde_json_i64(&x.season_number).map(|y| (y, x.clone())))
        .collect();
    episodes.sort_by(|a, b| {
        get_serde_json_u64(&a.season)
            .cmp(&get_serde_json_u64(&b.season))
            .then_with(|| {
                get_serde_json_u64(&a.episode_num).cmp(&get_serde_json_u64(&b.episode_num))
            })
    });
    insert_episodes(&source, seasons, episodes, series_id, channel.image)?;
    Ok(())
}

fn insert_episodes(
    source: &Source,
    seasons: HashMap<i64, XtreamSeason>,
    episodes: Vec<XtreamEpisode>,
    series_id: u64,
    default_season_image: Option<String>,
) -> Result<()> {
    let mut seasons_db: HashMap<i64, i64> = HashMap::new();
    sql::do_tx(|tx| {
        for episode in episodes {
            match insert_episode(
                episode.clone(),
                source,
                tx,
                &mut seasons_db,
                &seasons,
                series_id,
                default_season_image.clone(),
            )
            .with_context(|| format!("Failed to insert episode {:?}", episode))
            {
                Ok(_) => (),
                Err(e) => {
                    log::log(format!("{:?}", e));
                    continue;
                }
            }
        }
        Ok(())
    })
}

fn insert_episode(
    episode: XtreamEpisode,
    source: &Source,
    tx: &Transaction,
    seasons_db: &mut HashMap<i64, i64>,
    seasons: &HashMap<i64, XtreamSeason>,
    series_id: u64,
    default_season_image: Option<String>,
) -> Result<()> {
    let season_number = get_serde_json_i64(&episode.season).unwrap_or(NO_SEASON_NUMBER);
    let season_id = seasons_db.get(&season_number);
    let season_id: i64 = match season_id {
        Some(s) => *s,
        None => {
            let season = seasons
                .get(&season_number)
                .and_then(|f| {
                    xtream_season_to_season(f.clone(), source.id.unwrap(), series_id)
                        .with_context(|| "Failed to convert XtreamSeason to Season")
                        .inspect_err(|e| log::log(format!("{}", e)))
                        .ok()
                })
                .unwrap_or_else(|| {
                    create_makeshift_season(
                        season_number,
                        series_id,
                        source.id.unwrap(),
                        default_season_image,
                    )
                });
            let id = insert_season(tx, season)?;
            seasons_db.insert(season_number, id);
            id
        }
    };
    let episode = episode_to_channel(episode, source, series_id, season_id)?;
    sql::insert_channel(tx, episode)?;
    Ok(())
}

fn create_makeshift_season(
    number: i64,
    series_id: u64,
    source_id: i64,
    image: Option<String>,
) -> Season {
    Season {
        name: match number == NO_SEASON_NUMBER {
            true => "Uncategorized".to_string(),
            false => format!("Season {number}"),
        },
        series_id,
        season_number: number,
        source_id,
        image,
        ..Default::default()
    }
}

fn get_serde_json_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(|cid| cid.to_string())
        .or_else(|| value.as_u64().map(|cid| cid.to_string()))
        .map(|cid| cid.trim().to_string())
}

/// Xtream sends EPG texts base64-encoded. Invalid UTF-8 is decoded lossily and
/// text that is not base64 at all is shown as it is.
fn decode_epg_text(text: &str) -> String {
    match BASE64_STANDARD.decode(text.trim()) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => text.to_string(),
    }
}

fn get_serde_json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_str()
        .and_then(|val| val.trim().parse::<u64>().ok())
        .or_else(|| value.as_u64())
}

fn get_serde_json_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|val| val.trim().parse::<i64>().ok())
        .or_else(|| value.as_i64())
}

fn xtream_season_to_season(season: XtreamSeason, source_id: i64, series_id: u64) -> Result<Season> {
    let season_number = get_serde_json_i64(&season.season_number).context("no season number")?;
    Ok(Season {
        season_number,
        series_id,
        source_id,
        image: season.cover_tmdb.or(season.cover).or(season.overview),
        name: format!("Season {season_number}"),
        ..Default::default()
    })
}

fn episode_to_channel(
    episode: XtreamEpisode,
    source: &Source,
    series_id: u64,
    season_id: i64,
) -> Result<Channel> {
    Ok(Channel {
        id: None,
        group: None,
        image: serde_json::from_value::<XtreamEpisodeInfo>(episode.info)
            .map(|e| e.movie_image)
            .unwrap_or_default(),
        media_type: media_type::MOVIE,
        name: episode.title.trim().to_string(),
        source_id: source.id,
        url: Some(get_url(
            get_serde_json_string(&episode.id).context("no id")?,
            source,
            media_type::SERIE,
            Some(episode.container_extension),
        )?),
        series_id: Some(series_id),
        episode_num: get_serde_json_i64(&episode.episode_num),
        season_id: Some(season_id),
        stream_id: None,
        group_id: None,
        favorite: false,
        tv_archive: None,
        hidden: Some(false),
        epg_channel_id: None,
    })
}

pub async fn get_epg(channel: Channel) -> Result<Vec<EPG>> {
    let mut source = sql::get_source_from_id(channel.source_id.context("no source id")?)?;
    let mut url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let stream_id = channel.stream_id.context("No stream id")?.to_string();
    url.query_pairs_mut().append_pair("stream_id", &stream_id);
    let epg: XtreamEPG = get_xtream_http_data(url, GET_EPG, &user_agent).await?;
    let url = get_timeshift_url_base(&source)?;
    let current_time = Local::now();
    let mut otv_epgs = Vec::new();
    let mut skipped = 0;
    for item in epg.epg_listings {
        // One malformed listing used to discard the whole guide.
        match xtream_epg_to_epg(item, &url, &stream_id) {
            Ok(item) => {
                if is_valid_epg(&item, &current_time)? {
                    otv_epgs.push(item);
                }
            }
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        log::warn(format!("Xtream EPG: skipped {skipped} malformed listings"));
    }
    Ok(otv_epgs)
}

fn is_valid_epg(epg: &EPG, now: &DateTime<Local>) -> Result<bool> {
    let epg_start_local = crate::utils::get_local_time(epg.start_timestamp)?;
    if epg_start_local < *now && !epg.has_archive && !epg.now_playing {
        return Ok(false);
    }
    Ok(true)
}

fn xtream_epg_to_epg(epg: XtreamEPGItem, url: &Url, stream_id: &str) -> Result<EPG> {
    let start_timestamp =
        get_serde_json_i64(&epg.start_timestamp).context("no valid start timestamp")?;
    let end_timestamp =
        get_serde_json_i64(&epg.stop_timestamp).context("no valid end timestamp")?;
    Ok(EPG {
        epg_id: get_serde_json_string(&epg.id).context("no epg id")?,
        title: decode_epg_text(&epg.title),
        description: decode_epg_text(&epg.description),
        start_time: get_local_time(start_timestamp)?
            .format("%B %d, %H:%M")
            .to_string(),
        end_time: get_local_time(end_timestamp)?
            .format("%B %d, %H:%M")
            .to_string(),
        start_timestamp,
        end_timestamp,
        timeshift_url: if get_serde_json_u64(&epg.has_archive) == Some(1) {
            Some(get_timeshift_url(
                url.clone(),
                epg.start,
                epg.end,
                stream_id,
            )?)
        } else {
            None
        },
        has_archive: get_serde_json_u64(&epg.has_archive) == Some(1),
        now_playing: get_serde_json_u64(&epg.now_playing) == Some(1),
    })
}

fn get_timeshift_url_base(source: &Source) -> Result<Url> {
    let mut url = Url::parse(source.url_origin.as_ref().context("no origin")?)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Can't mutate url"))?
        .extend(&["streaming", "timeshift.php"]);
    url.query_pairs_mut()
        .append_pair("username", source.username.as_ref().context("no username")?)
        .append_pair("password", source.password.as_ref().context("no password")?);
    Ok(url)
}

fn get_timeshift_url(mut url: Url, start: String, end: String, stream_id: &str) -> Result<String> {
    let start = NaiveDateTime::parse_from_str(&start, "%Y-%m-%d %H:%M:%S")?;
    let duration = NaiveDateTime::parse_from_str(&end, "%Y-%m-%d %H:%M:%S")?
        .signed_duration_since(start)
        .num_minutes()
        .to_string();
    let start = start.format("%Y-%m-%d:%H-%M").to_string();
    url.query_pairs_mut()
        .append_pair("stream", stream_id)
        .append_pair("start", &start)
        .append_pair("duration", &duration);
    Ok(url.to_string())
}

/// Logs in once without importing anything, for the "test connection" button.
pub async fn check(mut source: Source) -> Result<()> {
    let url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let client = api_client_builder().user_agent(user_agent).build()?;
    let response = client.get(url).send().await?.error_for_status()?;
    let value: serde_json::Value = response
        .json()
        .await
        .context("The server did not answer like an Xtream Codes server")?;
    let user_info = value
        .get("user_info")
        .context("The server did not answer like an Xtream Codes server")?;
    let auth = user_info.get("auth").and_then(|a| {
        a.as_u64()
            .or_else(|| a.as_str().and_then(|s| s.parse().ok()))
    });
    if auth == Some(0) {
        bail!("The provider rejected the username or password");
    }
    Ok(())
}

async fn get_status(source: &mut Source) -> Result<(i64, XtreamStatus)> {
    let url = build_xtream_url(source)?;
    let user_agent = get_user_agent_from_source(source)?;
    let client = api_client_builder().user_agent(user_agent).build()?;
    let data = client.get(url).send().await?.json::<XtreamStatus>().await?;
    Ok((source.id.context("no id")?, data))
}

pub async fn get_all_expiries() -> Result<HashMap<i64, i64>> {
    let mut sources = sql::get_sources_by_type(source_type::XTREAM)?;
    let to_await = sources.iter_mut().map(get_status);
    let results: Vec<std::result::Result<(i64, XtreamStatus), anyhow::Error>> =
        join_all(to_await).await;
    let statuses: HashMap<i64, i64> = results
        .into_iter()
        .flatten()
        .filter_map(|(id, status)| {
            let exp_date = get_serde_json_i64(&status.user_info.exp_date)?;
            Some((id, exp_date))
        })
        .collect();
    Ok(statuses)
}

#[cfg(test)]
mod test_xtream_login {
    use super::login_from_m3u_url;

    #[test]
    fn test_login_from_get_php_link() {
        let login = login_from_m3u_url(
            "http://example.com:8080/get.php?username=u1&password=p%402&type=m3u_plus&output=ts",
        )
        .unwrap();
        assert_eq!(login.url, "http://example.com:8080/player_api.php");
        assert_eq!(login.username, "u1");
        assert_eq!(login.password, "p@2");
        // A path prefix before get.php is kept.
        let login = login_from_m3u_url("https://h.tv/iptv/GET.PHP?username=a&password=b").unwrap();
        assert_eq!(login.url, "https://h.tv/iptv/player_api.php");
    }

    #[test]
    fn test_other_links_are_not_xtream() {
        assert!(login_from_m3u_url("http://example.com/playlist.m3u").is_none());
        assert!(login_from_m3u_url("http://example.com/get.php?username=u").is_none());
        assert!(login_from_m3u_url("http://example.com/get.php?username=&password=p").is_none());
        assert!(login_from_m3u_url("file:///C:/get.php?username=u&password=p").is_none());
        assert!(login_from_m3u_url("not a url").is_none());
    }
}

#[cfg(test)]
mod test_xtream_failure {
    use super::xtream_failure;
    use crate::media_type::{LIVESTREAM, MOVIE, SERIE};

    #[test]
    fn test_missing_series_on_a_source_without_series_is_fine() {
        assert!(xtream_failure(&[SERIE], &[LIVESTREAM, MOVIE]).is_none());
    }

    #[test]
    fn test_failed_live_on_a_source_with_live_aborts() {
        assert!(xtream_failure(&[LIVESTREAM], &[LIVESTREAM, MOVIE]).is_some());
    }

    #[test]
    fn test_everything_failed_aborts_even_on_first_import() {
        assert!(xtream_failure(&[LIVESTREAM, MOVIE, SERIE], &[]).is_some());
    }

    #[test]
    fn test_first_import_tolerates_partial_failure() {
        assert!(xtream_failure(&[MOVIE], &[]).is_none());
    }
}
