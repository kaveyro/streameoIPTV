use std::vec;
use std::{collections::HashMap, sync::LazyLock};

use crate::credentials;
use crate::log::log;
use crate::sort_type;
use crate::types::{
    ChannelPreserve, CustomChannel, CustomChannelExtraData, EPGNotify, ExportedGroup, Group,
    IdName, ScheduledRecording, Season,
};
use crate::{
    media_type, source_type,
    types::{Channel, ChannelHttpHeaders, Filters, Source},
    view_type,
};
use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{OptionalExtension, Row, Transaction, params, params_from_iter};
use rusqlite_migration::{M, Migrations};

const PAGE_SIZE: u8 = 36;

/// Channel filter hiding everything in a group locked by the parental PIN.
const NOT_IN_LOCKED_GROUP: &str =
    "\nAND (group_id IS NULL OR group_id NOT IN (SELECT id FROM groups WHERE locked = 1))";
/// Group filter hiding groups locked by the parental PIN.
const GROUP_NOT_LOCKED: &str = "\nAND (locked IS NULL OR locked = 0)";

/// start, end, title, description
pub type XmltvProgramme = (i64, i64, String, Option<String>);
/// channel id, start, end, title, description
pub type XmltvProgrammeRow = (String, i64, i64, String, Option<String>);

/// Row offset of a 1-based page. Page 0 is treated as the first page instead
/// of underflowing.
fn page_offset(page: u32) -> u64 {
    u64::from(page.saturating_sub(1)) * u64::from(PAGE_SIZE)
}
pub const DB_NAME: &str = "db.sqlite";
static CONN: LazyLock<Pool<SqliteConnectionManager>> = LazyLock::new(create_connection_pool);

pub fn get_conn() -> Result<PooledConnection<SqliteConnectionManager>> {
    CONN.try_get().context("No sqlite conns available")
}

fn create_connection_pool() -> Pool<SqliteConnectionManager> {
    // WAL lets reads and small writes (favorite, last watched, settings) go
    // through while a refresh holds its long insert transaction; the busy
    // timeout covers the remaining writer-writer overlap.
    let manager = SqliteConnectionManager::file(get_and_create_sqlite_db_path())
        .with_init(|c| c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;"));
    r2d2::Pool::builder().max_size(20).build(manager).unwrap()
}

fn get_and_create_sqlite_db_path() -> String {
    let mut path = ProjectDirs::from("dev", "kaveyro", "streameoIPTV")
        .unwrap()
        .data_dir()
        .to_owned();
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    path.push(DB_NAME);
    path.to_string_lossy().to_string()
}

fn create_structure() -> Result<()> {
    let sql = get_conn()?;
    sql.execute_batch(
        r#"
CREATE TABLE "sources" (
  "id"          INTEGER PRIMARY KEY,
  "name"        varchar(100),
  "source_type" integer,
  "url"         varchar(500),
  "username"    varchar(100),
  "password"    varchar(100),
  "enabled"     integer DEFAULT 1
);

CREATE TABLE "channels" (
  "id" INTEGER PRIMARY KEY,
  "name" varchar(100),
  "image" varchar(500),
  "url" varchar(500),
  "media_type" integer,
  "source_id" integer,
  "favorite" integer,
  "series_id" integer,
  "group_id" integer,
  FOREIGN KEY (source_id) REFERENCES sources(id)
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE "settings" (
  "key" VARCHAR(50) PRIMARY KEY,
  "value" VARCHAR(100)
);

CREATE TABLE "groups" (
  "id" INTEGER PRIMARY KEY,
  "name" varchar(100),
  "image" varchar(500),
  "source_id" integer,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX index_channel_name ON channels(name);
CREATE UNIQUE INDEX channels_unique ON channels(name, url);

CREATE UNIQUE INDEX index_source_name ON sources(name);
CREATE INDEX index_source_enabled ON sources(enabled);

CREATE UNIQUE INDEX index_group_unique ON groups(name, source_id);
CREATE INDEX index_group_name ON groups(name);

CREATE INDEX index_channel_source_id ON channels(source_id);
CREATE INDEX index_channel_favorite ON channels(favorite);
CREATE INDEX index_channel_series_id ON channels(series_id);
CREATE INDEX index_channel_group_id ON channels(group_id);
CREATE INDEX index_channel_media_type ON channels(media_type);

CREATE INDEX index_group_source_id ON groups(source_id);
"#,
    )?;
    Ok(())
}

fn structure_exists() -> Result<bool> {
    let sql = get_conn()?;
    let table_exists: bool = sql
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels' LIMIT 1",
            [],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some();
    Ok(table_exists)
}

pub fn create_or_initialize_db() -> Result<()> {
    if !structure_exists()? {
        create_structure()?;
    }
    apply_migrations()?;
    Ok(())
}

fn apply_migrations() -> Result<()> {
    let mut sql = get_conn()?;
    let migrations = Migrations::new(vec![
        M::up(
            r#"
                DROP INDEX IF EXISTS channels_unique;
                CREATE UNIQUE INDEX channels_unique ON channels(name, url, source_id);
                CREATE TABLE IF NOT EXISTS "channel_http_headers" (
                    "id" INTEGER PRIMARY KEY,
                    "channel_id" integer,
                    "referrer" varchar(500),
                    "user_agent" varchar(500),
                    "http_origin" varchar(500),
                    "ignore_ssl" integer DEFAULT 0,
                    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS index_channel_http_headers_channel_id ON channel_http_headers(channel_id);
                ALTER TABLE sources ADD COLUMN use_tvg_id integer;
                UPDATE sources SET use_tvg_id = 1 WHERE source_type in (0,1);
            "#,
        ),
        M::up(
            r#"
                ALTER TABLE channels ADD COLUMN stream_id integer;
                CREATE INDEX IF NOT EXISTS index_channels_stream_id on channels(stream_id);
                CREATE TABLE IF NOT EXISTS "epg" (
                  "id" INTEGER PRIMARY KEY,
                  "epg_id" varchar(25),
                  "channel_name" varchar(100),
                  "title" varchar(100),
                  "start_timestamp" INTEGER
                );
                CREATE UNIQUE INDEX IF NOT EXISTS index_epg_epg_id on epg(epg_id);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN last_watched integer;
              CREATE INDEX index_channels_last_watched on channels(last_watched);

              DROP INDEX IF EXISTS channels_unique;
              DELETE FROM channels
              WHERE ROWID NOT IN (
                  SELECT MIN(ROWID)
                  FROM channels
                  GROUP BY name, source_id
              );
              CREATE UNIQUE INDEX channels_unique ON channels(name, source_id);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN tv_archive integer;
              CREATE INDEX index_channels_tv_archive on channels(tv_archive);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE groups
              ADD COLUMN media_type INTEGER;
              CREATE INDEX index_groups_media_type ON groups(media_type);

              ALTER TABLE channels
              ADD COLUMN season_id INTEGER;
              CREATE INDEX index_channels_season_id ON channels(season_id);

              ALTER TABLE channels
              ADD COLUMN episode_num INTEGER;
              CREATE INDEX index_channels_episode_num on channels(episode_num);

              CREATE TABLE IF NOT EXISTS "seasons" (
                "id" INTEGER PRIMARY KEY,
                "name" VARCHAR(50),
                "season_number" INTEGER,
                "series_id" INTEGER,
                "source_id" INTEGER,
                "image" varchar(200),
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
              );
              CREATE INDEX index_seasons_name ON seasons(name);
              CREATE UNIQUE INDEX unique_seasons ON seasons(season_number, series_id, source_id);
            "#,
        ),
        M::up(
            r#"
              DROP INDEX IF EXISTS channels_unique;
              CREATE UNIQUE INDEX channels_unique ON channels(name, source_id, url, series_id, season_id);
        "#,
        ),
        M::up(
            r#"
              ALTER TABLE sources ADD COLUMN user_agent varchar(500);
              ALTER TABLE sources ADD COLUMN max_streams integer;
              ALTER TABLE sources ADD COLUMN stream_user_agent varchar(500);
              ALTER TABLE channels ADD COLUMN hidden integer DEFAULT 0;
              ALTER TABLE groups ADD COLUMN hidden integer DEFAULT 0;
              CREATE INDEX index_channels_hidden ON channels(hidden);
              CREATE INDEX index_groups_hidden ON groups(hidden);
              ANALYZE;
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE sources ADD COLUMN last_updated integer;
              ANALYZE;
            "#,
        ),
        M::up(
            r#"
              CREATE TABLE IF NOT EXISTS "scheduled_recordings" (
                "id" INTEGER PRIMARY KEY,
                "channel_id" INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                "title" TEXT,
                "start_timestamp" INTEGER NOT NULL,
                "end_timestamp" INTEGER NOT NULL,
                "status" INTEGER DEFAULT 0
              );
              CREATE INDEX IF NOT EXISTS index_scheduled_recordings_status ON scheduled_recordings(status, start_timestamp);
              CREATE UNIQUE INDEX IF NOT EXISTS index_scheduled_recordings_unique ON scheduled_recordings(channel_id, start_timestamp);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN epg_channel_id varchar(200);
              CREATE INDEX IF NOT EXISTS index_channels_epg_channel_id ON channels(epg_channel_id);
              CREATE TABLE IF NOT EXISTS "xmltv_programmes" (
                "channel_id" TEXT NOT NULL,
                "start_timestamp" INTEGER NOT NULL,
                "end_timestamp" INTEGER NOT NULL,
                "title" TEXT,
                "description" TEXT
              );
              CREATE INDEX IF NOT EXISTS index_xmltv_programmes ON xmltv_programmes(channel_id, start_timestamp);
            "#,
        ),
        M::up(
            r#"
              CREATE TABLE IF NOT EXISTS "xmltv_channels" (
                "norm_name" TEXT NOT NULL,
                "channel_id" TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS index_xmltv_channels_norm ON xmltv_channels(norm_name);
            "#,
        ),
        M::up(
            r#"
              DELETE FROM channel_http_headers WHERE channel_id NOT IN (SELECT id FROM channels);
              DELETE FROM scheduled_recordings WHERE channel_id NOT IN (SELECT id FROM channels);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE groups ADD COLUMN locked INTEGER DEFAULT 0;
              CREATE INDEX IF NOT EXISTS index_groups_locked ON groups(locked);
            "#,
        ),
        M::up(
            r#"
              CREATE TABLE IF NOT EXISTS "epg_mappings" (
                "source_id" INTEGER NOT NULL,
                "channel_name" TEXT NOT NULL,
                "xmltv_id" TEXT NOT NULL,
                PRIMARY KEY (source_id, channel_name)
              );
            "#,
        ),
    ]);
    migrations.to_latest(&mut sql)?;
    Ok(())
}

pub fn backup_database(path: String) -> Result<()> {
    // VACUUM INTO refuses to overwrite an existing file,
    // the save dialog already asked the user about overwriting.
    if std::path::Path::new(&path).exists() {
        std::fs::remove_file(&path).context("Failed to overwrite existing backup file")?;
    }
    let sql = get_conn()?;
    sql.execute("VACUUM INTO ?1", params![path])?;
    export_keychain_passwords_to_backup(&path)?;
    Ok(())
}

/// Backups must stay fully portable, so the keychain placeholder is replaced
/// with the real password (plaintext, as in pre-keychain backups) inside the
/// user-chosen backup file. A missing keychain entry becomes an empty
/// password and is logged.
fn export_keychain_passwords_to_backup(path: &str) -> Result<()> {
    let backup = rusqlite::Connection::open(path)
        .context("Failed to open backup file for password export")?;
    let ids: Vec<i64> = backup
        .prepare("SELECT id FROM sources WHERE password = ?")?
        .query_map(params![credentials::KEYCHAIN_PLACEHOLDER], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();
    for id in ids {
        let password = credentials::get_source_password(id).unwrap_or_else(|| {
            log(format!(
                "No keychain entry for source {id} during backup, exporting empty password"
            ));
            String::new()
        });
        backup.execute(
            "UPDATE sources SET password = ? WHERE id = ?",
            params![password, id],
        )?;
    }
    Ok(())
}

const BACKUP_TABLES: [&str; 8] = [
    "sources",
    "groups",
    "channels",
    "channel_http_headers",
    "seasons",
    "settings",
    "epg",
    "scheduled_recordings",
];

fn validate_backup(path: &str) -> Result<()> {
    let backup =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Failed to open backup file")?;
    for table in BACKUP_TABLES {
        let exists: bool = backup
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get::<_, u8>(0),
            )
            .optional()
            .context("File is not a valid SQLite database")?
            .is_some();
        if !exists {
            return Err(anyhow!(
                "File is not a valid streameoIPTV backup, table '{table}' is missing"
            ));
        }
    }
    let backup_version: i64 = backup.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let live_version: i64 = get_conn()?.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if backup_version != live_version {
        return Err(anyhow!(
            "Backup was created by a different app version (schema v{backup_version}, expected v{live_version}). Please create a fresh backup with this version."
        ));
    }
    Ok(())
}

pub fn restore_database(path: String) -> Result<()> {
    validate_backup(&path)?;
    let mut sql = get_conn()?;
    // ATTACH cannot run inside a transaction, so attach first,
    // then wipe + copy atomically in a single transaction.
    sql.execute("ATTACH DATABASE ?1 AS backup", params![path])?;
    let result = restore_from_attached(&mut sql);
    _ = sql
        .execute("DETACH DATABASE backup", params![])
        .map_err(|e| log(format!("{:?}", e)));
    if result.is_ok() {
        // Backups carry plaintext passwords; move them into this machine's
        // keychain (best-effort, failures leave the rows untouched).
        credentials::migrate_passwords_to_keychain();
    }
    result
}

fn restore_from_attached(sql: &mut PooledConnection<SqliteConnectionManager>) -> Result<()> {
    let tx = sql.transaction()?;
    // Delete children first, insert parents first (FK order).
    for table in BACKUP_TABLES.iter().rev() {
        tx.execute(&format!("DELETE FROM {table}"), params![])?;
    }
    for table in BACKUP_TABLES {
        tx.execute(
            &format!("INSERT INTO {table} SELECT * FROM backup.{table}"),
            params![],
        )?;
    }
    tx.execute("ANALYZE;", params![])?;
    tx.commit()?;
    Ok(())
}

pub fn drop_db() -> Result<()> {
    let sql = get_conn()?;
    sql.execute_batch(
        "DROP TABLE channels; DROP TABLE groups; DROP TABLE sources; DROP TABLE settings;",
    )?;
    Ok(())
}

pub fn create_or_find_source_by_name(tx: &Transaction, source: &Source) -> Result<i64> {
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM sources WHERE name = ?1",
            params![source.name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        return Ok(id);
    }
    tx.execute(
    "INSERT INTO sources (name, source_type, url, username, password, use_tvg_id, user_agent, max_streams, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params![source.name, { source.source_type }, source.url, source.username, source.password, source.use_tvg_id, source.user_agent, source.max_streams, chrono::Utc::now().timestamp()],
    )?;
    let id = tx.last_insert_rowid();
    // Best-effort: move the password into the OS keychain now that the row id
    // is known. On keychain failure the plaintext insert above stays as-is.
    let db_password = credentials::password_for_db(Some(id), source.password.clone());
    if db_password != source.password {
        tx.execute(
            "UPDATE sources SET password = ? WHERE id = ?",
            params![db_password, id],
        )?;
    }
    Ok(id)
}

pub fn insert_season(tx: &Transaction, season: Season) -> Result<i64> {
    tx.execute(
        r#"
        INSERT INTO seasons (name, image, series_id, season_number, source_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (series_id, season_number, source_id)
        DO UPDATE SET
          image = excluded.image,
          name = excluded.name
        "#,
        params![
            season.name,
            season.image,
            season.series_id,
            season.season_number,
            season.source_id,
        ],
    )?;
    Ok(tx.query_row(
        r#"
        SELECT id
        FROM seasons
        WHERE series_id = ?
        AND season_number = ?
        AND source_id = ?
      "#,
        params![season.series_id, season.season_number, season.source_id],
        |r| r.get(0),
    )?)
}

pub fn insert_channel(tx: &Transaction, channel: Channel) -> Result<()> {
    tx.execute(
        r#"
INSERT INTO channels (name, group_id, image, url, source_id, media_type, series_id, favorite, stream_id, tv_archive, season_id, episode_num, epg_channel_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (name, source_id, url, series_id, season_id)
DO UPDATE SET
    url = excluded.url,
    media_type = excluded.media_type,
    stream_id = excluded.stream_id,
    image = excluded.image,
    series_id = excluded.series_id,
    tv_archive = excluded.tv_archive,
    season_id = excluded.season_id,
    epg_channel_id = excluded.epg_channel_id;
"#,
        params![
            channel.name,
            channel.group_id,
            channel.image,
            channel.url,
            channel.source_id,
            { channel.media_type },
            channel.series_id,
            channel.favorite,
            channel.stream_id,
            channel.tv_archive,
            channel.season_id,
            channel.episode_num,
            channel.epg_channel_id
        ],
    )?;
    Ok(())
}

pub fn insert_channel_headers(tx: &Transaction, headers: ChannelHttpHeaders) -> Result<()> {
    tx.execute(
        r#"
INSERT OR IGNORE INTO channel_http_headers (channel_id, referrer, user_agent, http_origin, ignore_ssl)
VALUES (?, ?, ?, ?, ?);
"#,
        params![
            headers.channel_id,
            headers.referrer,
            headers.user_agent,
            headers.http_origin,
            headers.ignore_ssl
        ],
    )?;
    Ok(())
}

fn get_or_insert_group(
    tx: &Transaction,
    group: &str,
    image: &Option<String>,
    source_id: &i64,
    media_type: u8,
) -> Result<i64> {
    let rows_changed = tx.execute(
        r#"
        INSERT OR IGNORE INTO groups (name, image, source_id, media_type)
        VALUES (?, ?, ?, ?);
        "#,
        params![group, &image, source_id, media_type],
    )?;
    if rows_changed == 0 {
        return Ok(tx.query_row(
            "SELECT id FROM groups WHERE name = ? and source_id = ?",
            params![group, source_id],
            |row| row.get::<_, i64>("id"),
        )?);
    }
    Ok(tx.last_insert_rowid())
}

pub fn set_channel_group_id(
    groups: &mut HashMap<String, i64>,
    channel: &mut Channel,
    tx: &Transaction,
    source_id: &i64,
) -> Result<()> {
    if channel.group.is_none() {
        return Ok(());
    }
    if !groups.contains_key(channel.group.as_ref().unwrap()) {
        let id = get_or_insert_group(
            tx,
            channel.group.as_ref().unwrap(),
            &channel.image,
            source_id,
            channel.media_type,
        )?;
        groups.insert(channel.group.clone().unwrap(), id);
        channel.group_id = Some(id);
    } else {
        channel.group_id = groups
            .get(channel.group.as_ref().unwrap())
            .map(|x| x.to_owned());
    }
    Ok(())
}

pub fn get_channel_headers_by_id(id: i64) -> Result<Option<ChannelHttpHeaders>> {
    let sql = get_conn()?;
    let headers = sql
        .query_row(
            "SELECT * FROM channel_http_headers WHERE channel_id = ?",
            params![id],
            row_to_channel_headers,
        )
        .optional()?;
    Ok(headers)
}

fn row_to_channel_headers(row: &Row) -> Result<ChannelHttpHeaders, rusqlite::Error> {
    Ok(ChannelHttpHeaders {
        id: row.get("id")?,
        channel_id: row.get("channel_id")?,
        http_origin: row.get("http_origin")?,
        referrer: row.get("referrer")?,
        user_agent: row.get("user_agent")?,
        ignore_ssl: row.get("ignore_ssl")?,
    })
}

pub fn get_settings() -> Result<HashMap<String, String>> {
    let sql = get_conn()?;
    let map = sql
        .prepare("SELECT key, value FROM Settings")?
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(map)
}

pub fn update_settings(map: HashMap<String, Option<String>>) -> Result<()> {
    let mut sql: PooledConnection<SqliteConnectionManager> = get_conn()?;
    let tx = sql.transaction()?;
    for (key, value) in map {
        tx.execute(
            r#"
            INSERT INTO Settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = ?2
            "#,
            params![key, value],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn search(filters: Filters) -> Result<Vec<Channel>> {
    if filters.view_type == view_type::CATEGORIES
        && filters.group_id.is_none()
        && filters.series_id.is_none()
    {
        return search_group(filters);
    }
    if filters.view_type == view_type::HIDDEN {
        return search_hidden(filters);
    }
    if filters.series_id.is_some() && filters.season.is_none() {
        return search_series(filters);
    }
    let sql = get_conn()?;
    let offset = page_offset(filters.page);
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters.media_types.clone().unwrap(),
    };
    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => query
            .split(" ")
            .map(|f| format!("%{f}%").to_string())
            .collect(),
        false => vec![format!("%{query}%")],
    };
    let mut sql_query = format!(
        r#"
        SELECT * FROM CHANNELS
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 0"#,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len()),
    );
    if !filters.show_locked {
        sql_query += NOT_IN_LOCKED_GROUP;
    }
    let country_patterns = country_like_patterns(filters.country.as_deref());
    sql_query += &country_sql(country_patterns.len());
    let mut baked_params = 2;
    if filters.view_type == view_type::FAVORITES && filters.series_id.is_none() {
        sql_query += "\nAND favorite = 1";
    }

    if filters.series_id.is_some() {
        sql_query += "\nAND series_id = ?";
        baked_params += 1;
    } else if filters.group_id.is_some() {
        sql_query += "\nAND group_id = ?";
        baked_params += 1;
    }
    if filters.season.is_some() {
        sql_query += "\nAND season_id = ?";
        baked_params += 1;
    }
    let order = match filters.sort {
        sort_type::ALPHABETICAL_DESC => "DESC",
        _ => "ASC",
    };
    if filters.view_type == view_type::HISTORY {
        sql_query += "\nAND last_watched IS NOT NULL";
        sql_query += "\nORDER BY last_watched DESC";
    } else if filters.season.is_some() {
        sql_query += &format!("\nORDER BY episode_num {0}, name {0}", order)
    } else if filters.sort != sort_type::PROVIDER {
        sql_query += &format!("\nORDER BY name {}", order);
    }
    sql_query += "\nLIMIT ?, ?";
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(
        baked_params
            + media_types.len()
            + filters.source_ids.len()
            + keywords.len()
            + country_patterns.len(),
    );
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(&country_patterns));
    if let Some(ref series_id) = filters.series_id {
        params.push(series_id);
    } else if let Some(ref group) = filters.group_id {
        params.push(group);
    }
    if let Some(ref season) = filters.season {
        params.push(season);
    }
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(channels)
}

fn search_series(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let offset = page_offset(filters.page);
    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => query
            .split(" ")
            .map(|f| format!("%{f}%").to_string())
            .collect(),
        false => vec![format!("%{query}%")],
    };
    let mut sql_query = format!(
        r#"
      SELECT *
      FROM seasons
      WHERE ({})
      AND source_id = ?
      AND series_id = ?
      "#,
        get_keywords_sql(keywords.len()),
    );
    let order = match filters.sort {
        sort_type::ALPHABETICAL_DESC => "DESC",
        _ => "ASC",
    };
    sql_query += &format!("\nORDER BY season_number {}", order);
    sql_query += "\nLIMIT ?, ?";
    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(2 + filters.source_ids.len() + keywords.len());
    params.extend(to_to_sql(&keywords));
    params.push(filters.source_ids.first().context("no source ids")?);
    params.push(filters.series_id.as_ref().context("no series id")?);
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), season_row_to_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(channels)
}

fn season_row_to_channel(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    Ok(Channel {
        id: row.get("id")?,
        image: row.get("image")?,
        favorite: false,
        group: None,
        group_id: None,
        media_type: media_type::SEASON,
        name: row.get("name")?,
        series_id: row.get("series_id")?,
        season_id: None,
        source_id: None,
        stream_id: None,
        tv_archive: None,
        url: None,
        episode_num: None,
        hidden: Some(false),
        epg_channel_id: None,
    })
}

use crate::bulk_action_type;

fn get_action_params(action: u8) -> Result<(&'static str, u8)> {
    match action {
        bulk_action_type::HIDE => Ok((bulk_action_type::FIELD_HIDDEN, 1)),
        bulk_action_type::UNHIDE => Ok((bulk_action_type::FIELD_HIDDEN, 0)),
        bulk_action_type::FAVORITE => Ok((bulk_action_type::FIELD_FAVORITE, 1)),
        bulk_action_type::UNFAVORITE => Ok((bulk_action_type::FIELD_FAVORITE, 0)),
        _ => Err(anyhow!("Invalid action")),
    }
}

pub fn bulk_update(filters: Filters, action: u8) -> Result<()> {
    if filters.series_id.is_some() && filters.season.is_none() {
        return Ok(());
    }

    let (field, value) = get_action_params(action)?;

    let query = filters.query.as_deref().unwrap_or("");
    let keywords: Vec<String> = match filters.use_keywords {
        true => query
            .split(" ")
            .map(|f| format!("%{f}%").to_string())
            .collect(),
        false => vec![format!("%{query}%")],
    };

    if filters.view_type == view_type::CATEGORIES
        && filters.group_id.is_none()
        && filters.series_id.is_none()
    {
        return apply_bulk_categories(&filters, field, value, &keywords);
    }

    if filters.view_type == view_type::HIDDEN {
        return apply_bulk_hidden(&filters, field, value, &keywords);
    }

    apply_bulk_channels(&filters, field, value, &keywords)
}

fn apply_bulk_categories(
    filters: &Filters,
    field: &str,
    value: u8,
    keywords: &[String],
) -> Result<()> {
    if field == bulk_action_type::FIELD_FAVORITE {
        return Ok(());
    }

    let sql = get_conn()?;
    let media_types = filters
        .media_types
        .as_ref()
        .context("media types not found")?;

    let mut sql_query = format!(
        r#"
        UPDATE groups
        SET {} = {}
        WHERE ({})
        AND source_id in ({})
        AND (media_type IS NULL OR media_type in ({}))
        "#,
        field,
        value,
        get_keywords_sql(keywords.len()),
        generate_placeholders(filters.source_ids.len()),
        generate_placeholders(media_types.len())
    );

    sql_query += "\nAND hidden = 0";

    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(keywords.len() + filters.source_ids.len() + media_types.len());
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(media_types));

    sql.execute(&sql_query, params_from_iter(params))?;
    Ok(())
}

fn apply_bulk_hidden(filters: &Filters, field: &str, value: u8, keywords: &[String]) -> Result<()> {
    let sql = get_conn()?;
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters
            .media_types
            .clone()
            .context("media types not found")?,
    };

    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();

    let sql_query_channels = format!(
        r#"
        UPDATE channels
        SET {} = {}
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 1
        "#,
        field,
        value,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len())
    );
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));

    sql.execute(&sql_query_channels, params_from_iter(params))?;

    if field != bulk_action_type::FIELD_FAVORITE {
        let mut params_groups: Vec<&dyn rusqlite::ToSql> = Vec::new();
        let sql_query_groups = format!(
            r#"
            UPDATE groups
            SET {} = {}
            WHERE ({})
            AND source_id IN ({})
            AND (media_type IS NULL OR media_type IN ({}))
            AND hidden = 1
            "#,
            field,
            value,
            get_keywords_sql(keywords.len()),
            generate_placeholders(filters.source_ids.len()),
            generate_placeholders(media_types.len())
        );
        params_groups.extend(to_to_sql(keywords));
        params_groups.extend(to_to_sql(&filters.source_ids));
        params_groups.extend(to_to_sql(&media_types));
        sql.execute(&sql_query_groups, params_from_iter(params_groups))?;
    }
    Ok(())
}

fn apply_bulk_channels(
    filters: &Filters,
    field: &str,
    value: u8,
    keywords: &[String],
) -> Result<()> {
    let sql = get_conn()?;
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters
            .media_types
            .clone()
            .context("media types not found")?,
    };

    let mut sql_query = format!(
        r#"
        UPDATE channels
        SET {} = {}
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 0"#,
        field,
        value,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len()),
    );
    if !filters.show_locked {
        // Bulk actions only touch what the user can see.
        sql_query += NOT_IN_LOCKED_GROUP;
    }

    if filters.view_type == view_type::FAVORITES && filters.series_id.is_none() {
        sql_query += "\nAND favorite = 1";
    }

    if filters.series_id.is_some() {
        sql_query += "\nAND series_id = ?";
    } else if filters.group_id.is_some() {
        sql_query += "\nAND group_id = ?";
    }
    if filters.season.is_some() {
        sql_query += "\nAND season_id = ?";
    }

    if filters.view_type == view_type::HISTORY {
        sql_query += "\nAND last_watched IS NOT NULL";
    }

    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(media_types.len() + filters.source_ids.len() + keywords.len() + 3);
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));
    if let Some(ref series_id) = filters.series_id {
        params.push(series_id);
    } else if let Some(ref group) = filters.group_id {
        params.push(group);
    }
    if let Some(ref season) = filters.season {
        params.push(season);
    }

    sql.execute(&sql_query, params_from_iter(params))?;
    Ok(())
}

fn search_hidden(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let offset = page_offset(filters.page);

    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters.media_types.clone().unwrap(),
    };

    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => query
            .split(" ")
            .map(|f| format!("%{f}%").to_string())
            .collect(),
        false => vec![format!("%{query}%")],
    };

    let keywords_sql = get_keywords_sql(keywords.len());
    let media_placeholders = generate_placeholders(media_types.len());
    let source_placeholders = generate_placeholders(filters.source_ids.len());

    let sql_query = format!(
        r#"
        SELECT id, image, name, series_id, source_id, stream_id, tv_archive, url, episode_num, hidden, media_type, NULL as group_id, NULL as season_id, favorite
        FROM channels
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND hidden = 1
        UNION ALL
        SELECT id, image, name, NULL as series_id, source_id, NULL as stream_id, NULL as tv_archive, NULL as url, NULL as episode_num, hidden, 3 as media_type, NULL as group_id, NULL as season_id, 0 as favorite
        FROM groups
        WHERE ({})
        AND source_id IN ({})
        AND (media_type IS NULL OR media_type IN ({}))
        AND hidden = 1
        ORDER BY name ASC
        LIMIT ?, ?
        "#,
        keywords_sql,
        media_placeholders,
        source_placeholders,
        keywords_sql,
        source_placeholders,
        media_placeholders
    );

    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();

    // Channels params
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));

    // Groups params
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(&media_types));

    params.push(&offset);
    params.push(&PAGE_SIZE);

    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_channel)?
        .filter_map(Result::ok)
        .collect();

    Ok(channels)
}

fn to_to_sql<T: rusqlite::ToSql>(values: &[T]) -> Vec<&dyn rusqlite::ToSql> {
    values.iter().map(|x| x as &dyn rusqlite::ToSql).collect()
}

fn get_keywords_sql(size: usize) -> String {
    std::iter::repeat_n("name LIKE ?", size)
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn generate_placeholders(size: usize) -> String {
    std::iter::repeat_n("?", size).collect::<Vec<_>>().join(",")
}

pub fn series_has_episodes(series_id: u64, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    let series_exists = sql
        .query_row(
            r#"
      SELECT 1
      FROM channels
      WHERE series_id = ? AND source_id = ?
      LIMIT 1
    "#,
            params![series_id, source_id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some();
    Ok(series_exists)
}

fn to_sql_like(query: Option<String>) -> String {
    query.map(|x| format!("%{x}%")).unwrap_or("%".to_string())
}

pub fn search_group(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let offset = page_offset(filters.page);
    let query = filters.query.unwrap_or("".to_string());
    let media_types = filters.media_types.context("no media types")?;
    let keywords: Vec<String> = match filters.use_keywords {
        true => query
            .split(" ")
            .map(|f| format!("%{f}%").to_string())
            .collect(),
        false => vec![format!("%{query}%")],
    };
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + filters.source_ids.len());
    let mut sql_query = format!(
        r#"
        SELECT *
        FROM groups
        WHERE ({})
        AND source_id in ({})
        AND (media_type IS NULL OR media_type in ({}))
    "#,
        get_keywords_sql(keywords.len()),
        generate_placeholders(filters.source_ids.len()),
        generate_placeholders(media_types.len())
    );
    sql_query += "\nAND hidden = 0";
    if !filters.show_locked {
        sql_query += GROUP_NOT_LOCKED;
    }
    let country_patterns = country_like_patterns(filters.country.as_deref());
    sql_query += &country_sql(country_patterns.len());
    if filters.sort != sort_type::PROVIDER {
        let order = match filters.sort {
            sort_type::ALPHABETICAL_ASC => "ASC",
            sort_type::ALPHABETICAL_DESC => "DESC",
            _ => "ASC",
        };
        sql_query += &format!("\nORDER BY name {}", order);
    }
    sql_query += "\nLIMIT ?, ?";
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&country_patterns));
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_group)?
        .filter_map(Result::ok)
        .collect();
    Ok(channels)
}

fn row_to_group(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    let channel = Channel {
        id: row.get("id")?,
        name: row.get("name")?,
        group: None,
        image: row.get("image")?,
        media_type: media_type::GROUP,
        url: None,
        series_id: None,
        group_id: None,
        favorite: false,
        source_id: row.get("source_id")?,
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: row.get("hidden")?,
        epg_channel_id: None,
    };
    Ok(channel)
}

fn row_to_channel(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    let channel = Channel {
        id: row.get("id")?,
        name: row.get("name")?,
        group_id: row.get("group_id")?,
        image: row.get("image")?,
        media_type: row.get("media_type")?,
        source_id: row.get("source_id")?,
        url: row.get("url")?,
        favorite: row.get("favorite")?,
        episode_num: row.get("episode_num")?,
        series_id: None,
        group: None,
        stream_id: row.get("stream_id")?,
        tv_archive: row.get("tv_archive")?,
        season_id: row.get("season_id")?,
        hidden: row.get("hidden")?,
        epg_channel_id: row.get("epg_channel_id")?,
    };
    Ok(channel)
}

pub fn delete_channels_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    // Foreign keys are not enforced in this database, so ON DELETE CASCADE
    // never fires. Without this, the headers of deleted channels would stay
    // behind and attach themselves to the next channel that reuses the id.
    tx.execute(
        "DELETE FROM channel_http_headers WHERE channel_id IN (SELECT id FROM channels WHERE source_id = ?)",
        params![source_id],
    )?;
    tx.execute(
        r#"
        DELETE FROM channels
        WHERE source_id = ?
    "#,
        params![source_id.to_string()],
    )?;
    Ok(())
}

pub fn delete_seasons_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        DELETE FROM seasons
        WHERE source_id = ?
    "#,
        params![source_id],
    )?;
    Ok(())
}

pub fn delete_groups_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        DELETE FROM groups
        WHERE source_id = ?
    "#,
        params!(source_id),
    )?;
    Ok(())
}

pub fn delete_source(id: i64) -> Result<()> {
    // One transaction, so a crash midway cannot leave a half-deleted source.
    do_tx(|tx| {
        tx.execute(
            "DELETE FROM scheduled_recordings WHERE channel_id IN (SELECT id FROM channels WHERE source_id = ?)",
            params![id],
        )?;
        delete_channels_by_source(tx, id)?;
        delete_groups_by_source(tx, id)?;
        delete_seasons_by_source(tx, id)?;
        tx.execute("DELETE FROM epg_mappings WHERE source_id = ?", params![id])?;
        let count = tx.execute("DELETE FROM sources WHERE id = ?", params![id])?;
        if count != 1 {
            return Err(anyhow!("No sources were deleted"));
        }
        Ok(())
    })?;
    credentials::delete_source_password(id);
    get_conn()?.execute("ANALYZE;", params![])?;
    checkpoint_wal();
    Ok(())
}

pub fn get_channel_count_by_source(id: i64) -> Result<u64> {
    let sql = get_conn()?;
    let count = sql.query_row(
        "SELECT COUNT(*) FROM channels WHERE source_id = ?",
        params![id],
        |row| row.get::<_, u64>(0),
    )?;
    Ok(count)
}

pub fn source_name_exists(name: &str) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
    SELECT 1
    FROM sources
    WHERE name = ?1
    "#,
            [name],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn favorite_channel(channel_id: i64, favorite: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET favorite = ?1
        WHERE id = ?2
    "#,
        params![favorite, channel_id],
    )?;
    Ok(())
}

/// All favorited channels with their group name resolved, for the M3U export.
/// Mirrors the Favorites view filters (favorite = 1, not hidden, has a url).
pub fn get_favorites_for_export() -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let channels: Vec<Channel> = sql
        .prepare(
            r#"
        SELECT channels.*, groups.name AS group_name
        FROM channels
        LEFT JOIN groups ON groups.id = channels.group_id
        WHERE channels.favorite = 1
        AND channels.url IS NOT NULL
        AND channels.hidden = 0
        ORDER BY channels.name
    "#,
        )?
        .query_map([], |row| {
            let mut channel = row_to_channel(row)?;
            channel.group = row.get("group_name")?;
            Ok(channel)
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(channels)
}

pub fn hide_channel(channel_id: i64, hidden: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET hidden = ?1
        WHERE id = ?2
    "#,
        params![hidden, channel_id],
    )?;
    Ok(())
}

pub fn hide_group(group_id: i64, hidden: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE groups
        SET hidden = ?1
        WHERE id = ?2
    "#,
        params![hidden, group_id],
    )?;
    Ok(())
}

pub fn remove_last_watched(channel_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET last_watched = NULL
        WHERE id = ?1
    "#,
        params![channel_id],
    )?;
    Ok(())
}

pub fn get_sources() -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources")?
        .query_map([], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

pub fn get_sources_by_type(source_type: u8) -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources WHERE source_type = ?")?
        .query_map([source_type], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

pub fn get_enabled_sources() -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources WHERE enabled = 1")?
        .query_map([], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

fn row_to_source(row: &Row) -> std::result::Result<Source, rusqlite::Error> {
    let mut source = Source {
        id: row.get("id")?,
        name: row.get("name")?,
        username: row.get("username")?,
        password: row.get("password")?,
        url: row.get("url")?,
        source_type: row.get("source_type")?,
        url_origin: None,
        enabled: row.get("enabled")?,
        use_tvg_id: row.get("use_tvg_id")?,
        user_agent: row.get("user_agent")?,
        max_streams: row.get("max_streams")?,
        stream_user_agent: row.get("stream_user_agent")?,
        last_updated: row.get("last_updated")?,
    };
    // Single point where keychain-backed passwords are resolved back to
    // plaintext, so every consumer (frontend, xtream URL building, ...)
    // keeps seeing the same shape as before.
    credentials::resolve_source_password(&mut source);
    Ok(source)
}

/// Raw (id, password) pairs for sources whose password is still stored as
/// plaintext in the database. Used by the keychain migration; intentionally
/// bypasses row_to_source so no keychain resolution happens.
pub fn get_plaintext_source_passwords() -> Result<Vec<(i64, String)>> {
    let sql = get_conn()?;
    let rows = sql
        .prepare(
            r#"
        SELECT id, password
        FROM sources
        WHERE password IS NOT NULL AND password != '' AND password != ?
    "#,
        )?
        .query_map(params![credentials::KEYCHAIN_PLACEHOLDER], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Overwrite the raw password column of a source (used by the keychain
/// migration to swap plaintext for the placeholder).
pub fn set_source_db_password(source_id: i64, value: &str) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "UPDATE sources SET password = ? WHERE id = ?",
        params![value, source_id],
    )?;
    Ok(())
}

pub fn get_source_from_id(source_id: i64) -> Result<Source> {
    let sql = get_conn()?;
    Ok(sql.query_row(
        r#"
    SELECT * FROM sources where id = ?"#,
        [source_id],
        row_to_source,
    )?)
}

pub fn set_source_enabled(value: bool, source_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE sources
        SET enabled = ?
        WHERE id = ?
    "#,
        params![value, source_id],
    )?;
    Ok(())
}

pub fn add_custom_channel(tx: &Transaction, channel: CustomChannel) -> Result<()> {
    insert_channel(tx, channel.data)?;
    if let Some(mut headers) = channel.headers {
        if channel_headers_empty(&headers) {
            return Ok(());
        }
        headers.channel_id = Some(tx.last_insert_rowid());
        insert_channel_headers(tx, headers)?;
    }
    Ok(())
}

fn channel_headers_empty(headers: &ChannelHttpHeaders) -> bool {
    headers.ignore_ssl.is_none()
        && headers.http_origin.is_none()
        && headers.referrer.is_none()
        && headers.user_agent.is_none()
}

pub fn get_custom_source(name: String) -> Source {
    Source {
        id: None,
        name: name.to_string(),
        enabled: true,
        username: None,
        password: None,
        source_type: source_type::CUSTOM,
        url: None,
        url_origin: None,
        use_tvg_id: None,
        user_agent: None,
        max_streams: None,
        stream_user_agent: None,
        last_updated: None,
    }
}

pub fn edit_custom_channel(channel: CustomChannel) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    match edit_custom_channel_tx(channel, &tx) {
        Ok(_) => {
            tx.commit()?;
            Ok(())
        }
        Err(e) => {
            tx.rollback().unwrap_or_else(|e| log(format!("{:?}", e)));
            Err(e)
        }
    }
}

fn edit_custom_channel_tx(channel: CustomChannel, tx: &Transaction) -> Result<()> {
    tx.execute(
        r#"
        UPDATE channels
        SET name = ?, image = ?, url = ?, media_type = ?, group_id = ?
        WHERE id = ?
    "#,
        params![
            channel.data.name,
            channel.data.image,
            channel.data.url,
            channel.data.media_type,
            channel.data.group_id,
            channel.data.id
        ],
    )?;
    if let Some(mut headers) = channel.headers {
        headers.channel_id = channel.data.id;
        tx.execute(
            r#"
            INSERT INTO channel_http_headers (referrer, user_agent, http_origin, ignore_ssl, channel_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(channel_id) DO UPDATE SET
                referrer = ?1,
                user_agent = ?2,
                http_origin = ?3,
                ignore_ssl = ?4
        "#,
            params![
                headers.referrer,
                headers.user_agent,
                headers.http_origin,
                headers.ignore_ssl,
                headers.channel_id
            ],
        )?;
    } else {
        tx.execute(
            "DELETE FROM channel_http_headers WHERE channel_id = ?",
            params![channel.data.id],
        )?;
    }
    Ok(())
}

pub fn delete_custom_channel(id: i64) -> Result<()> {
    // Dependent rows by hand: foreign keys (and their cascades) are off.
    do_tx(|tx| {
        tx.execute(
            "DELETE FROM channel_http_headers WHERE channel_id = ?",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM scheduled_recordings WHERE channel_id = ?",
            params![id],
        )?;
        tx.execute("DELETE FROM channels WHERE id = ?", params![id])?;
        Ok(())
    })
}

pub fn group_exists(name: &str, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
            SELECT 1
            FROM groups
            WHERE name = ? AND source_id = ?
        "#,
            params![name, source_id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn channel_exists(name: &str, url: &str, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
            SELECT 1
            FROM channels
            WHERE name = ? AND source_id = ? AND url = ?
        "#,
            params![name, source_id, url],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn add_custom_group(tx: &Transaction, group: Group) -> Result<i64> {
    tx.execute(
        r#"
        INSERT INTO groups (name, image, source_id)
        VALUES (?, ?, ?)
    "#,
        params!(group.name, group.image, group.source_id),
    )?;
    Ok(tx.last_insert_rowid())
}

pub fn group_auto_complete(query: Option<String>, source_id: i64) -> Result<Vec<IdName>> {
    let sql = get_conn()?;
    let groups = sql
        .prepare(
            r#"
        SELECT id, name
        FROM groups
        WHERE name LIKE ?
        AND source_id = ?
    "#,
        )?
        .query_map(params![to_sql_like(query), source_id], row_to_id_name)?
        .filter_map(Result::ok)
        .collect();
    Ok(groups)
}

fn row_to_id_name(row: &Row) -> Result<IdName, rusqlite::Error> {
    Ok(IdName {
        id: row.get("id")?,
        name: row.get("name")?,
    })
}

pub fn edit_custom_group(group: Group) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE groups
        SET name = ?, image = ?
        WHERE id = ?
    "#,
        params![group.name, group.image, group.id],
    )?;
    Ok(())
}

fn get_group_by_id(id: i64) -> Result<Option<Group>> {
    let sql = get_conn()?;
    let group: Option<Group> = sql
        .query_row(
            "SELECT * FROM groups WHERE id = ?",
            params![id],
            row_to_custom_group,
        )
        .optional()?;
    Ok(group)
}

fn row_to_custom_group(row: &Row) -> Result<Group, rusqlite::Error> {
    Ok(Group {
        id: row.get("id")?,
        name: row.get("name")?,
        image: row.get("image")?,
        source_id: row.get("source_id")?,
        hidden: row.get("hidden")?,
    })
}

pub fn get_custom_channel_extra_data(
    id: i64,
    group_id: Option<i64>,
) -> Result<CustomChannelExtraData> {
    Ok(CustomChannelExtraData {
        headers: get_channel_headers_by_id(id)?,
        group: match group_id {
            None => None,
            Some(group) => get_group_by_id(group)?,
        },
    })
}

pub fn delete_custom_group(id: i64, new_id: Option<i64>, do_channels_update: bool) -> Result<()> {
    let sql = get_conn()?;
    if do_channels_update {
        sql.execute(
            r#"
        UPDATE channels
        SET group_id = ?
        WHERE group_id = ?
    "#,
            params![new_id, id],
        )?;
    }
    sql.execute(
        r#"
        DELETE FROM groups
        WHERE id = ?
    "#,
        params![id],
    )?;
    Ok(())
}

pub fn group_not_empty(id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
                SELECT 1
                FROM channels
                WHERE group_id = ?
            "#,
            params![id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn get_custom_channels(group_id: Option<i64>, source_id: i64) -> Result<Vec<CustomChannel>> {
    let sql = get_conn()?;
    let mut sql_query = r#"
        SELECT c.name, c.image, c.url, c.media_type, ch.referrer, ch.user_agent, ch.http_origin, ch.ignore_ssl
        FROM channels c
        LEFT JOIN channel_http_headers ch on ch.channel_id = c.id
        WHERE source_id = ?
    "#.to_string();
    let mut params: Vec<i64> = Vec::with_capacity(2);
    params.push(source_id);
    if let Some(id) = group_id {
        sql_query.push_str("\nAND group_id = ?");
        params.push(id);
    } else {
        sql_query.push_str("\nAND group_id IS NULL");
    }
    let result = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_custom_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(result)
}

fn row_to_custom_channel(row: &Row) -> Result<CustomChannel, rusqlite::Error> {
    Ok(CustomChannel {
        data: Channel {
            name: row.get("name")?,
            image: row.get("image")?,
            url: row.get("url")?,
            media_type: row.get("media_type")?,
            favorite: false,
            group_id: None,
            group: None,
            id: None,
            series_id: None,
            source_id: None,
            stream_id: None,
            tv_archive: None,
            season_id: None,
            episode_num: None,
            hidden: Some(false),
            epg_channel_id: None,
        },
        headers: Some(ChannelHttpHeaders {
            http_origin: row.get("http_origin")?,
            ignore_ssl: row.get("ignore_ssl")?,
            referrer: row.get("referrer")?,
            user_agent: row.get("user_agent")?,
            channel_id: None,
            id: None,
        }),
    })
}

fn get_groups_by_source_id(id: i64) -> Result<Vec<Group>> {
    let sql = get_conn()?;
    let result = sql
        .prepare(
            r#"
        SELECT *
        FROM groups
        WHERE source_id = ?
    "#,
        )?
        .query_map(params![id], row_to_custom_group)?
        .filter_map(Result::ok)
        .collect();
    Ok(result)
}

pub fn get_custom_groups(source_id: i64) -> Result<Vec<ExportedGroup>> {
    let groups = get_groups_by_source_id(source_id)?;
    let mut export: Vec<ExportedGroup> = Vec::new();
    for group in groups {
        export.push(ExportedGroup {
            group: Group {
                name: group.name,
                image: group.image,
                source_id: None,
                id: None,
                hidden: Some(false),
            },
            channels: get_custom_channels(group.id, source_id)?,
        });
    }
    Ok(export)
}

pub fn do_tx<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&Transaction) -> Result<T>,
{
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    let result = f(&tx)?;
    tx.commit()?;
    Ok(result)
}

pub fn update_source(source: Source) -> Result<()> {
    let sql = get_conn()?;
    // Try the keychain first; on failure the plaintext is stored as before.
    let db_password = credentials::password_for_db(source.id, source.password.clone());
    sql.execute(
        r#"
        UPDATE sources
        SET username = ?, password = ?, url = ?, use_tvg_id = ?, user_agent = ?, max_streams = ?, stream_user_agent = ?
        WHERE id = ?"#,
        params![
            source.username,
            db_password,
            source.url,
            source.use_tvg_id,
            source.user_agent,
            source.max_streams,
            source.stream_user_agent,
            source.id
        ],
    )?;
    Ok(())
}

/// Distinct media types the source currently has channels for.
pub fn get_media_types_of_source(tx: &Transaction, source_id: i64) -> Result<Vec<u8>> {
    let types = tx
        .prepare("SELECT DISTINCT media_type FROM channels WHERE source_id = ?")?
        .query_map(params![source_id], |row| row.get::<_, u8>(0))?
        .collect::<rusqlite::Result<Vec<u8>>>()?;
    Ok(types)
}

pub fn wipe(tx: &Transaction, id: i64) -> Result<()> {
    delete_seasons_by_source(tx, id)?;
    delete_channels_by_source(tx, id)?;
    delete_groups_by_source(tx, id)?;
    Ok(())
}

pub fn clean_epgs() -> Result<()> {
    let sql = get_conn()?;
    sql.execute_batch(
        r#"
          DELETE FROM epg
          WHERE start_timestamp < strftime('%s', 'now')
        "#,
    )?;
    Ok(())
}

pub fn add_epg(epg: EPGNotify) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "INSERT INTO epg (epg_id, channel_name, title, start_timestamp) VALUES (?,?,?,?)",
        params![epg.epg_id, epg.channel_name, epg.title, epg.start_timestamp],
    )?;
    Ok(())
}

pub fn remove_epg(epg_id: String) -> Result<()> {
    let sql = get_conn()?;
    sql.execute("DELETE FROM epg WHERE epg_id = ?", params![epg_id])?;
    Ok(())
}

pub fn get_epgs() -> Result<Vec<EPGNotify>> {
    let sql = get_conn()?;
    let epgs = sql
        .prepare("SELECT * FROM epg")?
        .query_map(params![], row_to_epg)?
        .filter_map(Result::ok)
        .collect();
    Ok(epgs)
}

pub fn get_epg_ids() -> Result<Vec<String>> {
    let sql = get_conn()?;
    let epgs = sql
        .prepare("SELECT epg_id FROM epg")?
        .query_map(params![], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(epgs)
}

fn row_to_epg(row: &Row) -> Result<EPGNotify, rusqlite::Error> {
    Ok(EPGNotify {
        epg_id: row.get("epg_id")?,
        channel_name: row.get("channel_name")?,
        start_timestamp: row.get("start_timestamp")?,
        title: row.get("title")?,
    })
}

pub fn get_preserve(tx: &Transaction, source_id: i64) -> Result<Vec<ChannelPreserve>> {
    let mut channels: Vec<ChannelPreserve> = tx
        .prepare(
            r#"
              SELECT name, favorite, last_watched, hidden
              FROM channels
              WHERE (favorite = 1 OR last_watched IS NOT NULL OR hidden = 1)
              AND series_id IS NULL
              AND source_id = ?
            "#,
        )?
        .query_map(params![source_id], row_to_channel_preserve)?
        .filter_map(Result::ok)
        .collect();

    let groups: Vec<ChannelPreserve> = tx
        .prepare(
            r#"
              SELECT name, hidden, locked
              FROM groups
              WHERE (hidden = 1 OR locked = 1)
              AND source_id = ?
            "#,
        )?
        .query_map(params![source_id], row_to_group_preserve)?
        .filter_map(Result::ok)
        .collect();

    channels.extend(groups);
    Ok(channels)
}

fn row_to_channel_preserve(row: &Row) -> Result<ChannelPreserve, rusqlite::Error> {
    Ok(ChannelPreserve {
        name: row.get("name")?,
        favorite: row.get("favorite")?,
        last_watched: row.get("last_watched")?,
        hidden: row.get("hidden")?,
        is_group: false,
        locked: false,
    })
}

fn row_to_group_preserve(row: &Row) -> Result<ChannelPreserve, rusqlite::Error> {
    Ok(ChannelPreserve {
        name: row.get("name")?,
        hidden: row.get("hidden")?,
        favorite: false,
        last_watched: None,
        is_group: true,
        locked: row.get::<_, Option<bool>>("locked")?.unwrap_or(false),
    })
}

/// Scheduled recordings of a source with the name of their channel, captured
/// before a refresh deletes the channels. Kept apart from [`get_preserve`],
/// whose output is also exported to favorites backup files.
pub fn get_recording_preserve(tx: &Transaction, source_id: i64) -> Result<Vec<(i64, String)>> {
    let rows = tx
        .prepare(
            r#"
              SELECT r.id, c.name
              FROM scheduled_recordings r
              JOIN channels c ON c.id = r.channel_id
              WHERE c.source_id = ?
            "#,
        )?
        .query_map(params![source_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
    Ok(rows)
}

/// Points recordings captured by [`get_recording_preserve`] at the refreshed
/// channel of the same name; recordings whose channel is gone are removed
/// instead of silently recording whatever channel now has the old id.
pub fn restore_recording_preserve(
    tx: &Transaction,
    source_id: i64,
    recordings: Vec<(i64, String)>,
) -> Result<()> {
    for (id, name) in recordings {
        let channel_id: Option<i64> = tx
            .query_row(
                r#"
                  SELECT id FROM channels
                  WHERE source_id = ? AND name = ? AND media_type = ?
                  LIMIT 1
                "#,
                params![source_id, name, media_type::LIVESTREAM],
                |row| row.get(0),
            )
            .optional()?;
        match channel_id {
            Some(channel_id) => tx.execute(
                "UPDATE scheduled_recordings SET channel_id = ? WHERE id = ?",
                params![channel_id, id],
            )?,
            None => tx.execute("DELETE FROM scheduled_recordings WHERE id = ?", params![id])?,
        };
    }
    Ok(())
}

pub fn restore_preserve(
    tx: &Transaction,
    source_id: i64,
    preserve: Vec<ChannelPreserve>,
) -> Result<()> {
    for item in preserve {
        if item.is_group {
            // A lock is only ever added here: a favorites backup file must
            // not be a way around the parental PIN.
            tx.execute(
                r#"
                  UPDATE groups
                  SET hidden = ?, locked = CASE WHEN ? THEN 1 ELSE locked END
                  WHERE name = ?
                  AND source_id = ?
                "#,
                params![item.hidden, item.locked, item.name, source_id],
            )?;
        } else {
            tx.execute(
                r#"
                  UPDATE channels
                  SET favorite = ?, last_watched = ?, hidden = ?
                  WHERE name = ?
                  AND source_id = ?
                "#,
                params![
                    item.favorite,
                    item.last_watched,
                    item.hidden,
                    item.name,
                    source_id
                ],
            )?;
        }
    }
    Ok(())
}

pub fn analyze(tx: &Transaction) -> Result<()> {
    tx.execute("ANALYZE;", params![])?;
    Ok(())
}

pub fn add_last_watched(id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
          UPDATE channels
          SET last_watched = strftime('%s', 'now')
          WHERE id = ?
        "#,
        params![id],
    )?;
    sql.execute(
        r#"
		  UPDATE channels
          SET last_watched = NULL
          WHERE last_watched IS NOT NULL
		  AND id NOT IN (
				SELECT id
				FROM channels
				WHERE last_watched IS NOT NULL
				ORDER BY last_watched DESC
				LIMIT 36
		  )
        "#,
        params![],
    )?;
    Ok(())
}

pub fn clear_history() -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
          UPDATE channels
          SET last_watched = NULL
          WHERE last_watched IS NOT NULL
        "#,
        params![],
    )?;
    Ok(())
}

pub fn find_all_episodes_after(channel: &Channel) -> Result<Vec<String>> {
    let sql = get_conn()?;
    Ok(sql
        .prepare(
            r#"
        SELECT url FROM channels
        WHERE season_id = ?
        AND episode_num > ?
        ORDER BY episode_num
      "#,
        )?
        .query_map(params![channel.season_id, channel.episode_num], |row| {
            row.get::<_, String>(0)
        })?
        .filter_map(Result::ok)
        .collect())
}

pub fn get_channel_by_id(id: i64) -> Result<Channel> {
    let sql = get_conn()?;
    Ok(sql.query_row(
        "SELECT * FROM channels WHERE id = ?",
        params![id],
        row_to_channel,
    )?)
}

pub fn add_scheduled_recording(rec: &ScheduledRecording) -> Result<i64> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        INSERT INTO scheduled_recordings (channel_id, title, start_timestamp, end_timestamp, status)
        VALUES (?, ?, ?, ?, 0)
        "#,
        params![
            rec.channel_id,
            rec.title,
            rec.start_timestamp,
            rec.end_timestamp
        ],
    )?;
    Ok(sql.last_insert_rowid())
}

pub fn delete_scheduled_recording(id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute("DELETE FROM scheduled_recordings WHERE id = ?", params![id])?;
    Ok(())
}

/// Upcoming (pending) and currently active (recording) scheduled recordings.
pub fn get_scheduled_recordings() -> Result<Vec<ScheduledRecording>> {
    let sql = get_conn()?;
    let recordings = sql
        .prepare(
            r#"
            SELECT * FROM scheduled_recordings
            WHERE status IN (0, 1)
            ORDER BY start_timestamp ASC
            "#,
        )?
        .query_map(params![], row_to_scheduled_recording)?
        .filter_map(Result::ok)
        .collect();
    Ok(recordings)
}

/// Pending recordings whose window contains `now` (start <= now < end).
pub fn get_due_recordings(now: i64) -> Result<Vec<ScheduledRecording>> {
    let sql = get_conn()?;
    let recordings = sql
        .prepare(
            r#"
            SELECT * FROM scheduled_recordings
            WHERE status = 0
            AND start_timestamp <= ?1
            AND end_timestamp > ?1
            "#,
        )?
        .query_map(params![now], row_to_scheduled_recording)?
        .filter_map(Result::ok)
        .collect();
    Ok(recordings)
}

pub fn set_scheduled_recording_status(id: i64, status: u8) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "UPDATE scheduled_recordings SET status = ? WHERE id = ?",
        params![status, id],
    )?;
    Ok(())
}

/// Startup recovery for scheduled recordings:
/// - rows stuck in 'recording' (1) belong to a previous app run whose ffmpeg is
///   long gone, so they are marked failed (3);
/// - pending rows (0) whose whole window already passed can never produce a
///   file, so they are marked failed too.
///
/// Pending rows that already started but still have remaining time are left
/// untouched: the scheduler's first tick picks them up as due and records the rest.
pub fn recover_scheduled_recordings(now: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "UPDATE scheduled_recordings SET status = 3 WHERE status = 1",
        params![],
    )?;
    sql.execute(
        "UPDATE scheduled_recordings SET status = 3 WHERE status = 0 AND end_timestamp <= ?",
        params![now],
    )?;
    Ok(())
}

fn row_to_scheduled_recording(row: &Row) -> Result<ScheduledRecording, rusqlite::Error> {
    Ok(ScheduledRecording {
        id: row.get("id")?,
        channel_id: row.get("channel_id")?,
        title: row.get("title")?,
        start_timestamp: row.get("start_timestamp")?,
        end_timestamp: row.get("end_timestamp")?,
        status: row.get("status")?,
        channel_name: row.get("channel_name").ok().flatten(),
    })
}

/// Every scheduled recording for the recordings view: upcoming and running
/// ones first, then the 100 most recent finished or failed ones.
pub fn get_recording_schedule() -> Result<Vec<ScheduledRecording>> {
    let sql = get_conn()?;
    let recordings = sql
        .prepare(
            r#"
            SELECT * FROM (
              SELECT r.*, c.name AS channel_name
              FROM scheduled_recordings r
              LEFT JOIN channels c ON c.id = r.channel_id
              WHERE r.status IN (0, 1)
              ORDER BY r.start_timestamp ASC
            )
            UNION ALL
            SELECT * FROM (
              SELECT r.*, c.name AS channel_name
              FROM scheduled_recordings r
              LEFT JOIN channels c ON c.id = r.channel_id
              WHERE r.status NOT IN (0, 1)
              ORDER BY r.start_timestamp DESC
              LIMIT 100
            )
            "#,
        )?
        .query_map(params![], row_to_scheduled_recording)?
        .collect::<rusqlite::Result<Vec<ScheduledRecording>>>()?;
    Ok(recordings)
}

/// Removes finished and failed entries from the schedule (files stay).
pub fn clear_finished_recordings() -> Result<()> {
    get_conn()?.execute(
        "DELETE FROM scheduled_recordings WHERE status NOT IN (0, 1)",
        params![],
    )?;
    Ok(())
}

pub fn update_source_last_updated(source_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "UPDATE sources SET last_updated = ? WHERE id = ?",
        params![chrono::Utc::now().timestamp(), source_id],
    )?;
    Ok(())
}

/// Replaces the entire XMLTV programme cache with `programmes`
/// (channel_id, start_timestamp, end_timestamp, title, description).
pub fn replace_xmltv_programmes(
    programmes: &[(String, i64, i64, String, Option<String>)],
) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    tx.execute("DELETE FROM xmltv_programmes", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO xmltv_programmes (channel_id, start_timestamp, end_timestamp, title, description) VALUES (?, ?, ?, ?, ?)",
        )?;
        for (channel_id, start, end, title, desc) in programmes {
            stmt.execute(params![channel_id, start, end, title, desc])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Replaces the programmes of the channels present in `programmes` and drops
/// ended ones, keeping everything else — used when some XMLTV sources failed,
/// so their previous data survives.
pub fn merge_xmltv_programmes(
    programmes: &[(String, i64, i64, String, Option<String>)],
    cutoff: i64,
) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    tx.execute(
        "DELETE FROM xmltv_programmes WHERE end_timestamp < ?",
        params![cutoff],
    )?;
    {
        let mut seen = std::collections::HashSet::new();
        let mut delete = tx.prepare("DELETE FROM xmltv_programmes WHERE channel_id = ?")?;
        for (channel_id, ..) in programmes {
            if seen.insert(channel_id.as_str()) {
                delete.execute(params![channel_id])?;
            }
        }
        let mut stmt = tx.prepare(
            "INSERT INTO xmltv_programmes (channel_id, start_timestamp, end_timestamp, title, description) VALUES (?, ?, ?, ?, ?)",
        )?;
        for (channel_id, start, end, title, desc) in programmes {
            stmt.execute(params![channel_id, start, end, title, desc])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Adds or updates channel-name mappings without dropping the others.
pub fn merge_xmltv_channels(channels: &[(String, String)]) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    {
        let mut delete = tx.prepare("DELETE FROM xmltv_channels WHERE norm_name = ?")?;
        let mut stmt =
            tx.prepare("INSERT INTO xmltv_channels (norm_name, channel_id) VALUES (?, ?)")?;
        for (norm, id) in channels {
            delete.execute(params![norm])?;
            stmt.execute(params![norm, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Replaces the XMLTV channel-name index (normalized name -> channel id).
pub fn replace_xmltv_channels(channels: &[(String, String)]) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    tx.execute("DELETE FROM xmltv_channels", [])?;
    {
        let mut stmt =
            tx.prepare("INSERT INTO xmltv_channels (norm_name, channel_id) VALUES (?, ?)")?;
        for (norm, id) in channels {
            stmt.execute(params![norm, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// XMLTV channel ids known under a normalized channel name, each with the
/// number of its programmes that end after `from`. Several guides (and a
/// channel's SD/HD feeds) often share a name, so the caller picks one.
pub fn get_xmltv_channel_candidates(norm_name: &str, from: i64) -> Result<Vec<(String, i64)>> {
    let sql = get_conn()?;
    let rows = sql
        .prepare(
            r#"
            SELECT c.channel_id,
                   (SELECT COUNT(*) FROM xmltv_programmes p
                     WHERE p.channel_id = c.channel_id AND p.end_timestamp > ?2)
            FROM (SELECT DISTINCT channel_id FROM xmltv_channels WHERE norm_name = ?1) c
            "#,
        )?
        .query_map(params![norm_name, from], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Whether the XMLTV cache holds any programme, so the frontend knows every
/// live channel may have a guide (matched by name when it has no tvg-id).
pub fn has_xmltv_programmes() -> Result<bool> {
    let sql = get_conn()?;
    Ok(
        sql.query_row("SELECT EXISTS(SELECT 1 FROM xmltv_programmes)", [], |row| {
            row.get(0)
        })?,
    )
}

/// Programmes for an XMLTV channel id whose end is still in the future
/// relative to `from`, ordered by start time.
pub fn get_xmltv_programmes(channel_id: &str, from: i64) -> Result<Vec<XmltvProgramme>> {
    let sql = get_conn()?;
    let rows = sql
        .prepare(
            r#"
            SELECT start_timestamp, end_timestamp, title, description
            FROM xmltv_programmes
            WHERE channel_id = ?1 AND end_timestamp > ?2
            ORDER BY start_timestamp ASC
            LIMIT 200
            "#,
        )?
        .query_map(params![channel_id, from], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

pub fn set_group_locked(group_id: i64, locked: bool) -> Result<()> {
    let count = get_conn()?.execute(
        "UPDATE groups SET locked = ? WHERE id = ?",
        params![locked, group_id],
    )?;
    if count != 1 {
        return Err(anyhow!("group not found"));
    }
    Ok(())
}

pub fn get_locked_group_ids() -> Result<Vec<i64>> {
    let ids = get_conn()?
        .prepare("SELECT id FROM groups WHERE locked = 1")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

pub fn unlock_all_groups() -> Result<()> {
    get_conn()?.execute("UPDATE groups SET locked = 0 WHERE locked = 1", [])?;
    Ok(())
}

/// LIKE patterns matching the ways playlists prefix a name with a country
/// code: "TR: x", "TR | x", "TR|x", "TR - x", "[TR] x". Empty without a
/// (valid, two-letter) code, which disables the filter.
fn country_like_patterns(country: Option<&str>) -> Vec<String> {
    let Some(code) = country
        .map(str::trim)
        .filter(|c| c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()))
    else {
        return Vec::new();
    };
    let code = code.to_ascii_uppercase();
    ["{}:%", "{} :%", "{}|%", "{} |%", "{} -%", "{}-%", "[{}]%"]
        .iter()
        .map(|p| p.replace("{}", &code))
        .collect()
}

fn country_sql(patterns: usize) -> String {
    if patterns == 0 {
        return String::new();
    }
    format!("\nAND ({})", vec!["name LIKE ?"; patterns].join(" OR "))
}

/// Moves the write-ahead log back into the database and truncates it. After
/// a large import the -wal file otherwise stays as big as the import was.
/// Best-effort: a busy database simply keeps its WAL until next time.
pub fn checkpoint_wal() {
    let result = get_conn().and_then(|conn| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(anyhow::Error::from)
    });
    if let Err(e) = result {
        crate::log::warn(format!("{:?}", e.context("WAL checkpoint failed")));
    }
}

/// Switches a source to Xtream after its channels were imported that way.
pub fn convert_source_to_xtream(source: &Source) -> Result<()> {
    let id = source.id.context("no source id")?;
    let db_password = credentials::password_for_db(source.id, source.password.clone());
    let count = get_conn()?.execute(
        r#"
        UPDATE sources
        SET source_type = ?, url = ?, username = ?, password = ?, use_tvg_id = NULL
        WHERE id = ?"#,
        params![
            source_type::XTREAM,
            source.url,
            source.username,
            db_password,
            id
        ],
    )?;
    if count != 1 {
        return Err(anyhow!("source {id} not found"));
    }
    Ok(())
}

/// The XMLTV channel assigned by hand to a channel (by source and name, so it
/// survives refreshes that give the channel a new id).
pub fn get_epg_mapping(source_id: i64, channel_name: &str) -> Result<Option<String>> {
    Ok(get_conn()?
        .query_row(
            "SELECT xmltv_id FROM epg_mappings WHERE source_id = ? AND channel_name = ?",
            params![source_id, channel_name],
            |row| row.get(0),
        )
        .optional()?)
}

/// Assigns an XMLTV channel to a channel, or removes the assignment.
pub fn set_epg_mapping(source_id: i64, channel_name: &str, xmltv_id: Option<&str>) -> Result<()> {
    let conn = get_conn()?;
    match xmltv_id {
        Some(id) => conn.execute(
            r#"
            INSERT INTO epg_mappings (source_id, channel_name, xmltv_id) VALUES (?1, ?2, ?3)
            ON CONFLICT(source_id, channel_name) DO UPDATE SET xmltv_id = ?3
            "#,
            params![source_id, channel_name, id],
        )?,
        None => conn.execute(
            "DELETE FROM epg_mappings WHERE source_id = ? AND channel_name = ?",
            params![source_id, channel_name],
        )?,
    };
    Ok(())
}

/// Every hand-made assignment, keyed by (source id, channel name).
pub fn get_all_epg_mappings() -> Result<HashMap<(i64, String), String>> {
    let conn = get_conn()?;
    let rows = conn
        .prepare("SELECT source_id, channel_name, xmltv_id FROM epg_mappings")?
        .query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Number of programmes per XMLTV channel that end after `from`.
pub fn get_xmltv_programme_counts(from: i64) -> Result<HashMap<String, i64>> {
    let conn = get_conn()?;
    let rows = conn
        .prepare(
            "SELECT channel_id, COUNT(*) FROM xmltv_programmes WHERE end_timestamp > ? GROUP BY channel_id",
        )?
        .query_map(params![from], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// The whole normalized-name index: (norm name, XMLTV channel id) pairs.
pub fn get_xmltv_name_index() -> Result<Vec<(String, String)>> {
    let conn = get_conn()?;
    let rows = conn
        .prepare("SELECT DISTINCT norm_name, channel_id FROM xmltv_channels")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// XMLTV channel ids whose id or normalized name contains the query.
pub fn find_xmltv_channel_ids(raw: &str, norm: &str, limit: u32) -> Result<Vec<String>> {
    let conn = get_conn()?;
    let raw = format!("%{}%", raw.trim());
    let norm = format!("%{norm}%");
    let rows = conn
        .prepare(
            r#"
            SELECT channel_id FROM (
              SELECT channel_id FROM xmltv_channels WHERE norm_name LIKE ?1 OR channel_id LIKE ?2
              UNION
              SELECT DISTINCT channel_id FROM xmltv_programmes WHERE channel_id LIKE ?2
            )
            ORDER BY length(channel_id), channel_id
            LIMIT ?3
            "#,
        )?
        .query_map(params![norm, raw, limit], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Title of the programme on air at `now` on an XMLTV channel.
pub fn get_xmltv_now_title(channel_id: &str, now: i64) -> Result<Option<String>> {
    Ok(get_conn()?
        .query_row(
            r#"
            SELECT title FROM xmltv_programmes
            WHERE channel_id = ?1 AND start_timestamp <= ?2 AND end_timestamp > ?2
            LIMIT 1
            "#,
            params![channel_id, now],
            |row| row.get(0),
        )
        .optional()?)
}

/// Upcoming XMLTV programmes (not ended, starting before `until`) whose title
/// contains the query: (channel id, start, end, title, description).
pub fn search_xmltv_programmes(
    query: &str,
    now: i64,
    until: i64,
    limit: u32,
) -> Result<Vec<XmltvProgrammeRow>> {
    let conn = get_conn()?;
    let pattern = format!("%{}%", query.trim());
    let rows = conn
        .prepare(
            r#"
            SELECT channel_id, start_timestamp, end_timestamp, title, description
            FROM xmltv_programmes
            WHERE title LIKE ?1 AND end_timestamp > ?2 AND start_timestamp < ?3
            ORDER BY start_timestamp
            LIMIT ?4
            "#,
        )?
        .query_map(params![pattern, now, until, limit], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Live channels of enabled sources that are not hidden, for EPG matching in
/// bulk. Favorites first, so they represent a guide channel shown by several
/// playlist channels.
pub fn get_live_channels_for_epg(show_locked: bool) -> Result<Vec<Channel>> {
    let conn = get_conn()?;
    let mut query = format!(
        r#"
        SELECT * FROM channels
        WHERE media_type = {}
        AND hidden = 0
        AND url IS NOT NULL
        AND source_id IN (SELECT id FROM sources WHERE enabled = 1)"#,
        media_type::LIVESTREAM
    );
    if !show_locked {
        query += NOT_IN_LOCKED_GROUP;
    }
    query += "\nORDER BY favorite DESC, name";
    let rows = conn
        .prepare(&query)?
        .query_map([], row_to_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Names of the visible channels and groups of the given sources, to find
/// the country prefixes in use.
pub fn get_names_for_countries(source_ids: &[i64]) -> Result<Vec<String>> {
    if source_ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = get_conn()?;
    let placeholders = generate_placeholders(source_ids.len());
    let query = format!(
        r#"
        SELECT name FROM channels
        WHERE source_id IN ({placeholders}) AND hidden = 0 AND series_id IS NULL
        UNION ALL
        SELECT name FROM groups
        WHERE source_id IN ({placeholders}) AND hidden = 0
        "#
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(source_ids.len() * 2);
    params.extend(to_to_sql(source_ids));
    params.extend(to_to_sql(source_ids));
    let rows = conn
        .prepare(&query)?
        .query_map(params_from_iter(params), |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

#[cfg(test)]
mod test_sql {
    use super::{country_like_patterns, get_preserve, restore_preserve};
    use rusqlite::Connection;

    fn groups_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, image TEXT, source_id INTEGER,
              media_type INTEGER, hidden INTEGER DEFAULT 0, locked INTEGER DEFAULT 0);
            CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, source_id INTEGER,
              favorite INTEGER DEFAULT 0, last_watched INTEGER, hidden INTEGER DEFAULT 0,
              series_id INTEGER);
            INSERT INTO groups (name, source_id, hidden, locked) VALUES
              ('Kids', 1, 0, 1), ('Adult', 1, 1, 1), ('News', 1, 0, 0);
            "#,
        )
        .unwrap();
        conn
    }

    fn locked(conn: &Connection, name: &str) -> bool {
        conn.query_row("SELECT locked FROM groups WHERE name = ?", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn test_refresh_keeps_group_locks() {
        let mut conn = groups_db();
        let tx = conn.transaction().unwrap();
        let preserve = get_preserve(&tx, 1).unwrap();
        // A refresh recreates the groups unlocked.
        tx.execute("UPDATE groups SET locked = 0, hidden = 0", [])
            .unwrap();
        restore_preserve(&tx, 1, preserve).unwrap();
        tx.commit().unwrap();
        assert!(locked(&conn, "Kids"));
        assert!(locked(&conn, "Adult"));
        assert!(!locked(&conn, "News"));
    }

    #[test]
    fn test_restore_never_removes_a_lock() {
        let mut conn = groups_db();
        let tx = conn.transaction().unwrap();
        let mut preserve = get_preserve(&tx, 1).unwrap();
        // A crafted favorites backup that says "not locked".
        preserve.iter_mut().for_each(|p| p.locked = false);
        restore_preserve(&tx, 1, preserve).unwrap();
        tx.commit().unwrap();
        assert!(locked(&conn, "Kids"));
        assert!(locked(&conn, "Adult"));
    }

    #[test]
    fn test_country_patterns() {
        assert!(country_like_patterns(None).is_empty());
        assert!(country_like_patterns(Some("TUR")).is_empty());
        assert!(country_like_patterns(Some("1%")).is_empty());
        let p = country_like_patterns(Some("tr"));
        assert!(p.contains(&"TR:%".to_string()));
        assert!(p.contains(&"[TR]%".to_string()));
        assert!(p.contains(&"TR |%".to_string()));
    }
}
