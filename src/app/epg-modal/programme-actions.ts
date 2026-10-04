import { invoke } from "@tauri-apps/api/core";
import { ConfirmService } from "../confirm.service";
import { Channel } from "../models/channel";
import { EPG } from "../models/epg";
import { MediaType } from "../models/mediaType";

/**
 * Programme actions shared by the TV guide and the EPG dialog: playing a
 * programme from the archive and the stream check before a recording.
 */

/// The archived programme as a pseudo channel for the player: negative id
/// (no history, no zapping), named "Channel · Title (date)" for the banner
/// and the player bar, so it does not pass for the live channel.
export function catchUpChannel(
  epg: Pick<EPG, "title" | "start_timestamp" | "timeshift_url">,
  channel: { name?: string; source_id?: number },
  locale?: string,
): Channel {
  return {
    id: -1,
    url: epg.timeshift_url,
    name: catchUpName(channel.name, epg.title, epg.start_timestamp, locale),
    media_type: MediaType.movie,
    favorite: false,
    source_id: channel.source_id,
  };
}

/// "Das Erste · Tagesschau (Sa., 3. Okt., 20:00)" in the UI language.
export function catchUpName(
  channelName: string | undefined,
  title: string,
  start: number,
  locale?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(locale, options);
  } catch {
    format = new Intl.DateTimeFormat(undefined, options);
  }
  const name = channelName ? `${channelName} · ${title}` : title;
  return `${name} (${format.format(start * 1000)})`;
}

/// What `recording_conflicts` reports for a planned recording.
export interface RecordingConflicts {
  /// Scheduled (pending or running) recordings of the same source that
  /// overlap the time.
  overlapping: number;
  /// The source's stream limit; null without one.
  max_streams: number | null;
  source_name: string | null;
}

/**
 * Before a recording is scheduled: when the source allows fewer streams
 * than would run at that time, asks whether to schedule it anyway. True
 * when it may be scheduled (also when the check itself fails: the
 * scheduler reports a failed recording on its own).
 */
export async function confirmRecordingConflicts(
  confirm: ConfirmService,
  channelId: number,
  start: number,
  end: number,
  /// The source's name when the backend gives none.
  sourceName = "",
): Promise<boolean> {
  let conflicts: RecordingConflicts | null;
  try {
    conflicts = await invoke<RecordingConflicts | null>("recording_conflicts", {
      channelId,
      // A running programme is recorded from now on.
      startTimestamp: Math.max(start, Math.floor(Date.now() / 1000)),
      endTimestamp: end,
    });
  } catch (e) {
    console.error(e);
    return true;
  }
  const max = conflicts?.max_streams;
  if (!conflicts || max == null || max <= 0 || conflicts.overlapping + 1 <= max) return true;
  return confirm.confirm({
    title: "RECORDING.CONFLICT_TITLE",
    messages: ["RECORDING.CONFLICT_BODY"],
    confirmLabel: "RECORDING.CONFLICT_CONFIRM",
    params: { source: conflicts.source_name || sourceName, max, count: conflicts.overlapping },
    // Nothing is deleted: a plain question, no red button.
    danger: false,
  });
}
