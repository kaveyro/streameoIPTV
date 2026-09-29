use chrono::Local;
use directories::ProjectDirs;
use std::{fs, sync::LazyLock};

static USE_LOGGER: LazyLock<bool> = LazyLock::new(init_logger);

/// How many log files (one per app start) are kept in the logs folder.
const MAX_LOG_FILES: usize = 10;

pub fn log(message: String) {
    let message = crate::redact::redact(&message);
    // Unit tests must not create/write log files in the real app cache dir.
    if cfg!(test) {
        eprintln!("{message}");
        return;
    }
    if *USE_LOGGER {
        log::error!("{message}");
    } else {
        eprintln!("{message}");
    }
}

fn init_logger() -> bool {
    let file = match fs::File::create(get_and_create_log_path()) {
        Ok(val) => val,
        Err(e) => {
            eprint!("Failed to create file for logger, {:?}", e);
            return false;
        }
    };
    match simplelog::WriteLogger::init(
        simplelog::LevelFilter::Error,
        simplelog::Config::default(),
        file,
    ) {
        Ok(_) => true,
        Err(e) => {
            eprint!("Failed to init logger, {:?}", e);
            false
        }
    }
}

fn get_and_create_log_path() -> String {
    let mut path = ProjectDirs::from("dev", "kaveyro", "streameoIPTV")
        .unwrap()
        .cache_dir()
        .to_owned();
    path.push("logs");
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    prune_old_logs(&path);
    path.push(get_log_name());
    path.to_string_lossy().to_string()
}

fn get_log_name() -> String {
    let current_time = Local::now();
    let formatted_time = current_time.format("%Y-%m-%d-%H-%M-%S").to_string();
    format!("{formatted_time}.log")
}

/// Deletes the oldest app logs so a new file per start does not pile up
/// forever. File names are timestamps, so name order is age order. mpv.log is
/// a single file mpv truncates itself and is left alone.
fn prune_old_logs(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|ext| ext == "log")
                && p.file_name().is_some_and(|n| n != "mpv.log")
        })
        .collect();
    logs.sort();
    // Leave room for the file about to be created.
    let excess = (logs.len() + 1).saturating_sub(MAX_LOG_FILES);
    for old in logs.into_iter().take(excess) {
        let _ = fs::remove_file(old);
    }
}
