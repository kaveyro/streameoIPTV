import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "./memory.service";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { EPG } from "./models/epg";

export interface NowPlaying {
  title: string;
  start_timestamp: number;
  end_timestamp: number;
}

interface CacheEntry {
  expires: number;
  value?: NowPlaying;
}

@Injectable({
  providedIn: "root",
})
export class NowPlayingService {
  private static readonly TTL_MS = 10 * 60 * 1000;
  private static readonly MAX_IN_FLIGHT = 4;

  private cache: Map<number, CacheEntry> = new Map();
  private inFlight = 0;
  private queue: (() => void)[] = [];

  constructor(private memory: MemoryService) {}

  /** A channel can have EPG from its Xtream provider or from external XMLTV
   *  (any channel that carries a tvg-id / epg_channel_id). */
  hasEpg(channel: Channel): boolean {
    return (
      (channel.source_id !== undefined && this.memory.XtreamSourceIds.has(channel.source_id)) ||
      !!channel.epg_channel_id
    );
  }

  async getNowPlaying(channel: Channel): Promise<NowPlaying | undefined> {
    if (
      channel.media_type !== MediaType.livestream ||
      channel.id === undefined ||
      channel.source_id === undefined ||
      !this.hasEpg(channel)
    ) {
      return undefined;
    }
    const cached = this.cache.get(channel.id);
    if (cached && cached.expires > Date.now()) return cached.value;
    await this.acquireSlot();
    try {
      // Another queued request may have filled the cache while we waited
      const fresh = this.cache.get(channel.id);
      if (fresh && fresh.expires > Date.now()) return fresh.value;
      let epg: EPG[] = [];
      try {
        epg = await invoke<EPG[]>("get_epg", { channel: channel });
      } catch {
        epg = [];
      }
      const now = Date.now() / 1000;
      const current = epg.find((x) => x.start_timestamp <= now && now < x.end_timestamp);
      const value: NowPlaying | undefined = current
        ? {
            title: current.title,
            start_timestamp: current.start_timestamp,
            end_timestamp: current.end_timestamp,
          }
        : undefined;
      // Cache empty results too, so channels without EPG are not re-fetched
      this.cache.set(channel.id, { expires: Date.now() + NowPlayingService.TTL_MS, value });
      return value;
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < NowPlayingService.MAX_IN_FLIGHT) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private releaseSlot() {
    const next = this.queue.shift();
    if (next) next();
    else this.inFlight--;
  }
}
