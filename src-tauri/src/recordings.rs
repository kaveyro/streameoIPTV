//! The recordings view: finished files in the recording folder (manual
//! recordings, scheduled recordings and downloads all land there) and the
//! list of scheduled recordings.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::settings::{get_default_record_path, get_settings};

const MEDIA_EXTENSIONS: [&str; 8] = ["ts", "mp4", "mkv", "avi", "mov", "m4v", "webm", "flv"];

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix seconds.
    pub modified: i64,
}

fn recording_dir() -> Result<PathBuf> {
    let dir = match get_settings()?.recording_path {
        Some(path) if !path.trim().is_empty() => path,
        _ => get_default_record_path()?,
    };
    Ok(PathBuf::from(dir))
}

fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Media files directly inside the recording folder, newest first.
pub fn list_files() -> Result<Vec<RecordingFile>> {
    let dir = recording_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<RecordingFile> = std::fs::read_dir(&dir)
        .with_context(|| format!("cannot read the recording folder {}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            if !meta.is_file() || !is_media(&path) {
                return None;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(RecordingFile {
                name: path.file_name()?.to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                modified,
            })
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    Ok(files)
}

/// Deletes one recording. Only media files directly inside the recording
/// folder can be deleted, whatever path the frontend sends.
pub fn delete_file(path: &str) -> Result<()> {
    let file = std::fs::canonicalize(path).context("recording not found")?;
    let dir = std::fs::canonicalize(recording_dir()?).context("recording folder not found")?;
    if file.parent() != Some(dir.as_path()) || !is_media(&file) {
        bail!("only recordings inside the recording folder can be deleted");
    }
    std::fs::remove_file(&file).context("failed to delete the recording")?;
    Ok(())
}

/// The recording folder, for "open folder" in the frontend.
pub fn folder() -> Result<String> {
    let dir = recording_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Opens the recording folder in the system file manager. Done here rather
/// than through the shell plugin, whose scope only allows web links; this can
/// only ever open the recording folder.
pub fn open_folder() -> Result<()> {
    let dir = folder()?;
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    // explorer.exe exits with 1 even on success, so only a failed spawn counts.
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .with_context(|| format!("could not open {dir}"))?;
    Ok(())
}

#[cfg(test)]
mod test_recordings {
    use super::is_media;
    use std::path::Path;

    #[test]
    fn test_media_detection() {
        assert!(is_media(Path::new("a/b/show-20240101-2000.ts")));
        assert!(is_media(Path::new("Movie.MKV")));
        assert!(!is_media(Path::new("notes.txt")));
        assert!(!is_media(Path::new("db.sqlite")));
        assert!(!is_media(Path::new("noext")));
    }
}
