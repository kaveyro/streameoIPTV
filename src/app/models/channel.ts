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
}
