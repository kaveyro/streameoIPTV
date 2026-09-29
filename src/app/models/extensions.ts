export const CHANNEL_EXTENSION = ".siptv";
export const GROUP_EXTENSION = ".siptvg";
export const PLAYLIST_EXTENSION = ".siptvp";
export const RECORD_EXTENSION = ".mp4";
export const FAVS_BACKUP = ".siptvf";

/// Open-file dialog filters. Files exported before the rename used the .otv*
/// extensions of the project this app was forked from; the backend still
/// imports both, so the dialogs accept both too.
export const CHANNEL_EXTENSIONS = ["siptv", "otv"];
export const GROUP_EXTENSIONS = ["siptvg", "otvg"];
export const PLAYLIST_EXTENSIONS = ["siptvp", "otvp"];
export const FAVS_BACKUP_EXTENSIONS = ["siptvf", "otvf"];
