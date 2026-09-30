import { MediaType } from "./mediaType";

export class Channel {
  id?: number;
  name?: string;
  group_id?: number;
  image?: string;
  url?: string;
  media_type?: MediaType;
  source_id?: number;
  favorite?: boolean;
  stream_id?: number;
  tv_archive?: boolean;
  hidden?: boolean;
  epg_channel_id?: string;
  /// Channel number from the playlist (tvg-chno) or the Xtream provider (num).
  number?: number;
  /// Movies and episodes: where the user stopped watching (seconds).
  watch_position?: number;
  /// Their length as the player last saw it (seconds).
  watch_duration?: number;
  /// Watched to the end.
  watch_finished?: boolean;
}
