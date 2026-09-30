import { Injectable, NgZone } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Subject } from "rxjs";
import { Channel } from "./models/channel";

/** How far a movie or episode was watched, as the player saves it
 *  (`watch-progress` event). Keyed by source and stored URL. */
export interface WatchProgress {
  source_id: number;
  url: string;
  /** Null once finished or reset: the next play starts at the beginning. */
  position?: number | null;
  duration?: number | null;
  finished: boolean;
}

/** Whether the movie can be resumed (left midway). */
export function isResumable(channel?: Channel): boolean {
  return channel?.watch_position != null && !channel.watch_finished;
}

/** Share of the movie watched, 0..100, when it can be resumed and its length is known. */
export function watchPercent(channel?: Channel): number | undefined {
  const position = channel?.watch_position;
  const duration = channel?.watch_duration;
  if (!isResumable(channel) || position == null || !duration || duration <= 0) return undefined;
  return Math.min(100, Math.max(0, (position / duration) * 100));
}

/**
 * The watch progress of movies and episodes: the tiles' progress bars follow
 * what the player saves, and "play from the start" / "mark as unwatched"
 * reset it.
 */
@Injectable({
  providedIn: "root",
})
export class WatchProgressService {
  /** A movie's progress changed (saved by the player or reset here). */
  readonly changed = new Subject<WatchProgress>();
  private listening = false;

  constructor(private ngZone: NgZone) {}

  /** Follows the progress the player saves. Safe to call again. */
  init() {
    if (this.listening) return;
    this.listening = true;
    listen<WatchProgress>("watch-progress", (event) =>
      this.ngZone.run(() => this.changed.next(event.payload)),
    ).catch((e) => {
      this.listening = false;
      console.error(e);
    });
  }

  /** Applies a change to `channel` when it is that movie; true if it was. */
  static apply(channel: Channel | undefined, progress: WatchProgress): boolean {
    if (!channel || channel.source_id !== progress.source_id || channel.url !== progress.url) {
      return false;
    }
    channel.watch_position = progress.position ?? undefined;
    channel.watch_duration = progress.duration ?? channel.watch_duration;
    channel.watch_finished = progress.finished;
    return true;
  }

  /** Forgets how far the movie was watched: it starts at the beginning. */
  async clear(channel: Channel): Promise<void> {
    if (channel.source_id === undefined || !channel.url) return;
    await invoke("clear_watch_progress", { sourceId: channel.source_id, url: channel.url });
    this.changed.next({
      source_id: channel.source_id,
      url: channel.url,
      position: null,
      duration: channel.watch_duration ?? null,
      finished: false,
    });
  }
}
