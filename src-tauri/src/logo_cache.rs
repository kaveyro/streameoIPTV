use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::PathBuf,
};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use directories::ProjectDirs;

use crate::utils::api_client_builder;

/// Maximum logo size we are willing to cache (2 MB). Anything larger is
/// rejected so the frontend falls back to the remote URL.
const MAX_LOGO_SIZE_BYTES: usize = 2 * 1024 * 1024;

const LOGO_CACHE_DIR_NAME: &str = "logo-cache";

const LOGO_USER_AGENT: &str = "Streameo IPTV";

#[tauri::command]
pub async fn get_cached_logo(url: String) -> Result<String, String> {
    get_cached_logo_internal(&url)
        .await
        .map_err(|e| format!("{:?}", e))
}

async fn get_cached_logo_internal(url: &str) -> Result<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("unsupported logo url scheme: {url}");
    }
    let path = get_logo_cache_path(url)?;
    if path.exists() {
        let bytes = tokio::fs::read(&path)
            .await
            .with_context(|| format!("failed to read cached logo {}", path.display()))?;
        if !bytes.is_empty() {
            return Ok(to_data_url(&bytes, url));
        }
    }
    let bytes = download_logo(url).await?;
    let data_url = to_data_url(&bytes, url);
    // Write via a temp file + rename so a crash mid-write never leaves a
    // truncated cache entry behind. Failure to persist is not fatal.
    if let Err(e) = write_cache_file(&path, &bytes).await {
        crate::log::log(format!("failed to cache logo {url}: {e:?}"));
    }
    Ok(data_url)
}

fn get_logo_cache_dir() -> Result<PathBuf> {
    let dirs =
        ProjectDirs::from("dev", "kaveyro", "streameoIPTV").context("project dir not found")?;
    let dir = dirs.data_dir().join(LOGO_CACHE_DIR_NAME);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create logo cache dir {}", dir.display()))?;
    }
    Ok(dir)
}

fn get_logo_cache_path(url: &str) -> Result<PathBuf> {
    Ok(get_logo_cache_dir()?.join(format!("{}.bin", hash_url(url))))
}

fn hash_url(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

async fn download_logo(url: &str) -> Result<Vec<u8>> {
    let client = api_client_builder().user_agent(LOGO_USER_AGENT).build()?;
    let mut response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to fetch logo {url}"))?;
    if !response.status().is_success() {
        bail!("failed to fetch logo {url}: HTTP {}", response.status());
    }
    if let Some(len) = response.content_length()
        && len as usize > MAX_LOGO_SIZE_BYTES
    {
        bail!("logo {url} exceeds size cap ({len} bytes)");
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_LOGO_SIZE_BYTES {
            bail!("logo {url} exceeds size cap");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        bail!("logo {url} returned an empty body");
    }
    Ok(bytes)
}

async fn write_cache_file(path: &PathBuf, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(())
}

fn to_data_url(bytes: &[u8], url: &str) -> String {
    format!(
        "data:{};base64,{}",
        detect_mime(bytes, url),
        STANDARD.encode(bytes)
    )
}

/// Detects the image mime type from magic numbers, falling back to the URL
/// extension, then to a generic default.
fn detect_mime(bytes: &[u8], url: &str) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(b"BM") {
        return "image/bmp";
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return "image/x-icon";
    }
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    if bytes[start..].starts_with(b"<svg") || bytes[start..].starts_with(b"<?xml") {
        return "image/svg+xml";
    }
    mime_from_extension(url).unwrap_or("image/png")
}

fn mime_from_extension(url: &str) -> Option<&'static str> {
    // Strip query string / fragment before looking at the extension.
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

#[cfg(test)]
mod test_logo_cache {
    use super::{detect_mime, hash_url};

    #[test]
    fn test_hash_url_is_stable_and_hex() {
        let a = hash_url("http://example.com/logo.png");
        let b = hash_url("http://example.com/logo.png");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, hash_url("http://example.com/other.png"));
    }

    #[test]
    fn test_detect_mime_magic_numbers() {
        assert_eq!(
            detect_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A], "http://a/x"),
            "image/png"
        );
        assert_eq!(
            detect_mime(&[0xFF, 0xD8, 0xFF, 0xE0], "http://a/x"),
            "image/jpeg"
        );
        assert_eq!(detect_mime(b"GIF89a......", "http://a/x"), "image/gif");
        assert_eq!(
            detect_mime(b"RIFF\x00\x00\x00\x00WEBPVP8", "http://a/x"),
            "image/webp"
        );
        assert_eq!(
            detect_mime(b"<svg xmlns=\"a\">", "http://a/x"),
            "image/svg+xml"
        );
        // Unknown bytes fall back to the URL extension.
        assert_eq!(
            detect_mime(b"\x01\x02\x03\x04", "http://a/logo.jpg?token=1"),
            "image/jpeg"
        );
        // Unknown bytes and extension fall back to png.
        assert_eq!(
            detect_mime(b"\x01\x02\x03\x04", "http://a/logo"),
            "image/png"
        );
    }
}
