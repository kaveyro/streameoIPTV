import { Injectable, NgZone } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Observable, Subject, defer, share, timer } from "rxjs";
import { MemoryService } from "./memory.service";
import { GuideEpgCache } from "./tv-guide/guide-epg-cache";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { EPG } from "./models/epg";

export interface Programme {
  title: string;
  start_timestamp: number;
  end_timestamp: number;
}

export interface NowPlaying extends Programme {
  /// The programme after the current one, when the guide has it.
  next?: Programme;
}

/** Whether the programme is over (the tile's line then needs a reload). */
export function programmeEnded(programme: Programme): boolean {
  return programme.end_timestamp <= Date.now() / 1000;
}

/** How far the programme is, 0..100. */
export function programmeProgress(programme: Programme): number {
  const duration = programme.end_timestamp - programme.start_timestamp;
  const elapsed = Date.now() / 1000 - programme.start_timestamp;
  return duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
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

  private xmltvListening = false;
  /** Emits when the EPG data behind the tiles changed (a guide appeared or
   *  was refreshed): tiles that are already shown load their line again. */
  readonly changed = new Subject<void>();
  /** Ticks on every full minute for the tiles' progress bars: one timer for
   *  all tiles, started by the first subscriber and stopped with the last. */
  readonly minuteTick: Observable<number> = defer(() =>
    timer(60_000 - (Date.now() % 60_000), 60_000),
  ).pipe(share());

  constructor(
    private memory: MemoryService,
    private guideCache: GuideEpgCache,
    private ngZone: NgZone,
  ) {}

  /** Loads whether an XMLTV guide is cached and follows the background
   *  refreshes of it. Safe to call again. */
  init() {
    this.loadXmltvState();
    if (this.xmltvListening) return;
    this.xmltvListening = true;
    listen("xmltv-refreshed", () => this.ngZone.run(() => this.xmltvChanged())).catch((e) => {
      this.xmltvListening = false;
      console.error(e);
    });
  }

  /** The XMLTV guides were refreshed: cached EPG results are stale. */
  xmltvChanged() {
    this.cache.clear();
    this.guideCache.entries.clear();
    this.loadXmltvState(true);
  }

  /** Drops the cached EPG of one channel, e.g. after its guide was assigned
   *  by hand: the next lookup (tile, guide) asks the backend again. */
  invalidate(channelId: number) {
    this.cache.delete(channelId);
    this.guideCache.entries.delete(channelId);
  }

  private loadXmltvState(dataChanged = false) {
    invoke<boolean>("has_xmltv_data")
      .then((has) => {
        const flipped = has !== this.memory.HasXmltv;
        this.memory.HasXmltv = has;
        // Tiles created before the answer skipped their now-playing line.
        if (flipped || dataChanged) this.changed.next();
      })
      .catch((e) => console.error(e));
  }

  /** A live channel can have EPG from its Xtream provider, from its tvg-id, or
   *  from an external XMLTV guide matched by its name. */
  hasEpg(channel: Channel): boolean {
    return (
      this.memory.HasXmltv ||
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
    if (this.isFresh(cached)) return cached!.value;
    await this.acquireSlot();
    try {
      // Another queued request may have filled the cache while we waited
      const fresh = this.cache.get(channel.id);
      if (this.isFresh(fresh)) return fresh!.value;
      let epg: EPG[] = [];
      try {
        epg = await invoke<EPG[]>("get_epg", { channel: channel });
      } catch {
        epg = [];
      }
      const now = Date.now() / 1000;
      const current = epg.find((x) => x.start_timestamp <= now && now < x.end_timestamp);
      const next = current
        ? epg
            .filter((x) => x.start_timestamp >= current.end_timestamp)
            .sort((a, b) => a.start_timestamp - b.start_timestamp)[0]
        : undefined;
      const value: NowPlaying | undefined = current
        ? {
            title: current.title,
            start_timestamp: current.start_timestamp,
            end_timestamp: current.end_timestamp,
            next: next
              ? {
                  title: next.title,
                  start_timestamp: next.start_timestamp,
                  end_timestamp: next.end_timestamp,
                }
              : undefined,
          }
        : undefined;
      // Cache empty results too, so channels without EPG are not re-fetched
      this.cache.set(channel.id, { expires: Date.now() + NowPlayingService.TTL_MS, value });
      return value;
    } finally {
      this.releaseSlot();
    }
  }

  /// A cached entry is stale once its TTL passed or the cached programme ended.
  private isFresh(entry?: CacheEntry): boolean {
    if (!entry || entry.expires <= Date.now()) return false;
    return !entry.value || entry.value.end_timestamp > Date.now() / 1000;
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
