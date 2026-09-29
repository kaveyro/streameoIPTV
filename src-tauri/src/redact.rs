//! Scrubs provider credentials out of text before it is logged or shown.
//!
//! IPTV providers put credentials into URLs in three ways: query parameters
//! (`player_api.php?username=U&password=P`), Xtream stream paths
//! (`/live/U/P/123.ts`) and URL userinfo (`http://U:P@host`). reqwest appends
//! the request URL to every error it produces, so without this a timeout would
//! write the password into the log file and into the error toast.

use regex::Regex;
use std::sync::LazyLock;

const MASK: &str = "***";

static QUERY_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:username|user|password|pass|pwd|token|auth|key|mac)=)[^&#\s)'\x22]*")
        .unwrap()
});

static XTREAM_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(/(?:live|movie|series|timeshift)/)[^/\s?#]+/[^/\s?#]+/").unwrap()
});

static USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@").unwrap());

/// Returns `text` with every credential-looking URL part replaced by `***`.
pub fn redact(text: &str) -> String {
    let text = QUERY_SECRET.replace_all(text, format!("${{1}}{MASK}"));
    let text = XTREAM_PATH.replace_all(&text, format!("${{1}}{MASK}/{MASK}/"));
    let text = USERINFO.replace_all(&text, format!("${{1}}{MASK}@"));
    text.into_owned()
}

#[cfg(test)]
mod test_redact {
    use super::redact;

    #[test]
    fn test_query_credentials() {
        let text = "error sending request for url (http://h:8080/player_api.php?username=bob&password=s3cr3t&action=get_live_streams)";
        let out = redact(text);
        assert!(!out.contains("bob"));
        assert!(!out.contains("s3cr3t"));
        assert!(out.contains("action=get_live_streams"));
    }

    #[test]
    fn test_xtream_stream_path() {
        let out = redact("http://h:8080/live/bob/s3cr3t/1234.ts");
        assert_eq!(out, "http://h:8080/live/***/***/1234.ts");
        let out = redact("http://h/timeshift/bob/s3cr3t/60/2024-01-01:10-00/5.ts");
        assert!(!out.contains("s3cr3t"));
    }

    #[test]
    fn test_userinfo() {
        assert_eq!(redact("rtmp://bob:s3cr3t@host/app"), "rtmp://***@host/app");
    }

    #[test]
    fn test_leaves_plain_text_alone() {
        let text = "Failed to process live: missing field `name` at line 1";
        assert_eq!(redact(text), text);
        assert_eq!(
            redact("http://host/live/stream.m3u8"),
            "http://host/live/stream.m3u8"
        );
    }
}
