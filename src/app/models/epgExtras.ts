import { Channel } from "./channel";

/** Xtream login found in an M3U link (`.../get.php?username=..&password=..`). */
export interface XtreamLogin {
  url: string;
  username: string;
  password: string;
}

/** Result of the last refresh of one XMLTV source. */
export interface XmltvSourceStatus {
  url: string;
  /// Unix seconds of the last successful load.
  updated?: number;
  programmes?: number;
  channels?: number;
  /// Why the last attempt failed.
  error?: string;
}

/** How many live channels the XMLTV guides cover. */
export interface EpgCoverage {
  live: number;
  matched: number;
}

/** An XMLTV channel offered when assigning a guide by hand. */
export interface XmltvChannelHit {
  id: string;
  /// Programmes that have not ended yet.
  programmes: number;
  now_title?: string;
}

/** A programme found by the guide search. */
export interface ProgrammeHit {
  channel: Channel;
  title: string;
  description: string;
  start_timestamp: number;
  end_timestamp: number;
}

/** A country prefix of channel names and how many channels carry it. */
export interface CountryCount {
  code: string;
  count: number;
}
