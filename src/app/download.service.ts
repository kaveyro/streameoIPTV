import { Injectable, NgZone } from "@angular/core";
import { Download, DownloadStatus } from "./models/download";
import { Subject } from "rxjs";
import { invoke } from "@tauri-apps/api/core";
import { ErrorService } from "./error.service";
import { listen } from "@tauri-apps/api/event";
import { Channel } from "./models/channel";
import { MemoryService } from "./memory.service";
import { TranslateService } from "@ngx-translate/core";
import { DOWNLOAD_MAX_CONCURRENT } from "./models/localStorage";
import { PlaybackService } from "./playback.service";
import { MediaType } from "./models/mediaType";

/// How many finished downloads are kept in the manager before the oldest ones
/// are dropped.
const HISTORY_LIMIT = 50;
/// localStorage key of the finished downloads, restored on the next start.
export const DOWNLOAD_HISTORY = "downloadHistory";
/// Weight of the newest sample in the smoothed transfer rate.
const SPEED_SMOOTHING = 0.3;

/// Payload of the download-bytes-<id> event (about every 500 ms).
export interface DownloadBytes {
  downloaded: number;
  total: number | null;
}

/// What is kept of a finished download across restarts.
type StoredDownload = Pick<
  Download,
  "id" | "channel" | "status" | "path" | "error" | "downloaded" | "total" | "filePath"
>;

@Injectable({
  providedIn: "root",
})
export class DownloadService {
  /// Queued and active downloads, in queue order (Map preserves insertion order).
  /// Reordering rebuilds the map, so this is also the authoritative order.
  Downloads: Map<string, Download> = new Map();
  /// Finished downloads (completed/failed/cancelled), newest first, until cleared.
  History: Download[] = [];
  /// While paused no new download is started; running ones keep going.
  Paused = false;

  static readonly MAX_CONCURRENT_LIMIT = 5;
  private maxConcurrent = 1;
  /// Downloads whose progress listener is still being registered, by id.
  private pendingEnqueues: Map<string, Promise<Download>> = new Map();
  /// Last byte count per download and when it arrived, for the rate.
  private byteSamples: Map<string, { bytes: number; at: number }> = new Map();

  constructor(
    private error: ErrorService,
    private ngZone: NgZone,
    private memory: MemoryService,
    private translate: TranslateService,
    private playback: PlaybackService,
  ) {
    this.maxConcurrent = this.readStoredConcurrency();
    this.History = this.readStoredHistory();
  }

  get MaxConcurrent() {
    return this.maxConcurrent;
  }

  set MaxConcurrent(value: number) {
    const clamped = Math.min(
      Math.max(Math.trunc(value) || 1, 1),
      DownloadService.MAX_CONCURRENT_LIMIT,
    );
    this.maxConcurrent = clamped;
    localStorage.setItem(DOWNLOAD_MAX_CONCURRENT, String(clamped));
    this.pump();
  }

  /// Puts a download at the end of the queue. It starts as soon as a slot is
  /// free; the returned object is the same instance the manager displays, so
  /// callers can subscribe to its progress right away.
  /// `resume` continues the partial file a failed transfer left behind.
  enqueue(id: string, channel: Channel, path?: string, resume = false): Promise<Download> {
    const existing = this.Downloads.get(id);
    if (existing) {
      return Promise.resolve(existing);
    }
    // Reserve the id before the first await: a second call (double Retry,
    // double click) while the listener is still being registered must get the
    // same download instead of starting a second backend transfer.
    const pending = this.pendingEnqueues.get(id);
    if (pending) {
      return pending;
    }
    const promise = this.createDownload(id, channel, path, resume).finally(() =>
      this.pendingEnqueues.delete(id),
    );
    this.pendingEnqueues.set(id, promise);
    return promise;
  }

  private async createDownload(
    id: string,
    channel: Channel,
    path: string | undefined,
    resume: boolean,
  ): Promise<Download> {
    const download: Download = {
      channel: channel,
      progress: 0,
      complete: new Subject(),
      id: id,
      progressUpdate: new Subject(),
      status: DownloadStatus.Queued,
      path: path,
      resume: resume,
    };
    const unlistenProgress = await listen<number>(`progress-${download.id}`, (event) => {
      this.ngZone.run(() => {
        download.progress = event.payload;
      });
      download.progressUpdate.next(download.progress);
    });
    let unlistenBytes: (() => void) | undefined;
    try {
      // Also when the size is unknown (no percentage then): bytes and rate.
      unlistenBytes = await listen<DownloadBytes>(`download-bytes-${download.id}`, (event) => {
        this.ngZone.run(() => this.onBytes(download, event.payload));
      });
    } catch (e) {
      console.error(e);
    }
    download.unlisten = () => {
      unlistenProgress();
      unlistenBytes?.();
    };
    this.Downloads.set(download.id, download);
    this.pump();
    return download;
  }

  /// Cancels a download whether it is still queued or already running.
  async abortDownload(id: string) {
    const download = this.Downloads.get(id);
    if (!download) {
      return;
    }
    if (download.status === DownloadStatus.Queued) {
      this.finish(download, DownloadStatus.Cancelled);
      return;
    }
    try {
      // The running transfer rejects with "download aborted", which is where
      // the entry is moved to the history - don't do it twice here.
      await invoke("abort_download", {
        sourceId: download.channel.source_id,
        downloadId: download.id,
      });
    } catch (e) {
      console.error(e);
      this.error.handleError(e);
    }
  }

  /// Cancels everything: queued entries are dropped, running ones aborted.
  async abortAll() {
    for (const download of Array.from(this.Downloads.values())) {
      await this.abortDownload(download.id);
    }
  }

  togglePause() {
    this.Paused = !this.Paused;
    if (!this.Paused) {
      this.pump();
    }
  }

  /// Moves a queued entry one position towards the front of the queue.
  moveUp(id: string) {
    this.move(id, -1);
  }

  /// Moves a queued entry one position towards the back of the queue.
  moveDown(id: string) {
    this.move(id, 1);
  }

  canMoveUp(id: string) {
    return this.findSwapTarget(id, -1) !== undefined;
  }

  canMoveDown(id: string) {
    return this.findSwapTarget(id, 1) !== undefined;
  }

  /// Puts a finished download back at the end of the queue. It continues
  /// where a failed transfer stopped (the backend keeps the partial file
  /// after a network failure, and starts over when there is none).
  async retry(download: Download) {
    this.removeFromHistory(download.id);
    await this.enqueue(download.id, download.channel, download.path, true);
  }

  removeFromHistory(id: string) {
    this.History = this.History.filter((x) => x.id !== id);
    this.storeHistory();
  }

  clearHistory() {
    this.History = [];
    this.storeHistory();
  }

  /// Opens the folder of a finished download with the file selected.
  async reveal(download: Download) {
    if (!download.filePath) return;
    try {
      await invoke("reveal_path", { path: download.filePath });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  /// Plays a finished download from disk, like a recording.
  async play(download: Download) {
    if (!download.filePath) return;
    try {
      await this.playback.play(
        {
          id: -1,
          name: download.channel.name,
          url: download.filePath,
          media_type: MediaType.movie,
          favorite: false,
        },
        [],
      );
    } catch (e) {
      this.error.handleError(e);
    }
  }

  activeCount() {
    return Array.from(this.Downloads.values()).filter((x) => x.status === DownloadStatus.Active)
      .length;
  }

  queuedCount() {
    return Array.from(this.Downloads.values()).filter((x) => x.status === DownloadStatus.Queued)
      .length;
  }

  /// Starts as many queued downloads as the concurrency settings allow.
  private pump() {
    if (this.Paused) {
      return;
    }
    for (const download of Array.from(this.Downloads.values())) {
      if (this.activeCount() >= this.maxConcurrent) {
        return;
      }
      if (download.status !== DownloadStatus.Queued || !this.hasFreeSourceSlot(download)) {
        continue;
      }
      void this.run(download);
    }
  }

  /// The backend cancels the oldest transfer of a source once its max_streams
  /// limit is reached, so a download is only started while its source still has
  /// a free slot - otherwise it would kill one of our own running downloads.
  private hasFreeSourceSlot(download: Download): boolean {
    const sourceId = download.channel.source_id;
    if (sourceId === undefined || sourceId === null) {
      return true;
    }
    const maxStreams = this.memory.Sources.get(sourceId)?.max_streams ?? 1;
    const activeForSource = Array.from(this.Downloads.values()).filter(
      (x) => x.status === DownloadStatus.Active && x.channel.source_id === sourceId,
    ).length;
    return activeForSource < Math.max(maxStreams, 1);
  }

  private async run(download: Download) {
    download.status = DownloadStatus.Active;
    try {
      const filePath = await invoke<string | null>("download", {
        downloadId: download.id,
        channel: download.channel,
        path: download.path,
        resume: download.resume ?? false,
      });
      download.filePath = filePath || download.path;
      download.progress = 100;
      this.finish(download, DownloadStatus.Completed);
      this.error.success(
        this.translate.instant("TOAST.DOWNLOAD_COMPLETED", { name: download.channel.name }),
      );
    } catch (e) {
      if (e == "download aborted") {
        this.finish(download, DownloadStatus.Cancelled);
        this.error.info(
          this.translate.instant("TOAST.DOWNLOAD_CANCELLED", { name: download.channel.name }),
        );
      } else {
        download.error = typeof e === "string" ? e : JSON.stringify(e);
        this.finish(download, DownloadStatus.Failed);
        this.error.handleError(e);
      }
    }
    this.pump();
  }

  /// Takes a download out of the queue, notifies its subscribers and records it
  /// in the history.
  private finish(download: Download, status: DownloadStatus) {
    download.status = status;
    try {
      download.unlisten?.();
    } catch (e) {
      console.error(e);
    }
    download.unlisten = undefined;
    download.speed = undefined;
    this.byteSamples.delete(download.id);
    this.Downloads.delete(download.id);
    this.History.unshift(download);
    if (this.History.length > HISTORY_LIMIT) {
      this.History.length = HISTORY_LIMIT;
    }
    this.storeHistory();
    download.complete.next(true);
  }

  /// Bytes so far, the size if known, and a smoothed transfer rate.
  private onBytes(download: Download, payload: DownloadBytes) {
    const now = Date.now();
    download.downloaded = payload.downloaded;
    download.total = payload.total ?? null;
    const last = this.byteSamples.get(download.id);
    if (last && now > last.at && payload.downloaded >= last.bytes) {
      const rate = ((payload.downloaded - last.bytes) * 1000) / (now - last.at);
      download.speed =
        download.speed === undefined
          ? rate
          : download.speed * (1 - SPEED_SMOOTHING) + rate * SPEED_SMOOTHING;
    }
    this.byteSamples.set(download.id, { bytes: payload.downloaded, at: now });
  }

  /// Best effort: storage may be full or unavailable.
  private storeHistory() {
    try {
      const stored: StoredDownload[] = this.History.map((x) => ({
        id: x.id,
        channel: x.channel,
        status: x.status,
        path: x.path,
        error: x.error,
        downloaded: x.downloaded,
        total: x.total,
        filePath: x.filePath,
      }));
      localStorage.setItem(DOWNLOAD_HISTORY, JSON.stringify(stored));
    } catch (e) {
      console.error(e);
    }
  }

  private readStoredHistory(): Download[] {
    try {
      const raw = localStorage.getItem(DOWNLOAD_HISTORY);
      const stored = raw ? (JSON.parse(raw) as StoredDownload[]) : [];
      if (!Array.isArray(stored)) return [];
      const statuses = Object.values(DownloadStatus) as string[];
      return stored
        .filter((x) => x && typeof x.id === "string" && x.channel)
        .slice(0, HISTORY_LIMIT)
        .map((x) => {
          // Only finished states are stored; anything else counts as failed.
          const status =
            statuses.includes(x.status) &&
            x.status !== DownloadStatus.Queued &&
            x.status !== DownloadStatus.Active
              ? x.status
              : DownloadStatus.Failed;
          return {
            ...x,
            status,
            progress: status === DownloadStatus.Completed ? 100 : 0,
            complete: new Subject<boolean>(),
            progressUpdate: new Subject<number>(),
          };
        });
    } catch (e) {
      console.error(e);
      return [];
    }
  }

  /// Nearest neighbour in the given direction that may swap places with `id`.
  /// Active downloads are skipped: they already hold a slot, reordering them
  /// would not change anything.
  private findSwapTarget(id: string, delta: number): number | undefined {
    const items = Array.from(this.Downloads.values());
    const index = items.findIndex((x) => x.id === id);
    if (index < 0 || items[index].status !== DownloadStatus.Queued) {
      return undefined;
    }
    for (let i = index + delta; i >= 0 && i < items.length; i += delta) {
      if (items[i].status === DownloadStatus.Queued) {
        return i;
      }
    }
    return undefined;
  }

  private move(id: string, delta: number) {
    const target = this.findSwapTarget(id, delta);
    if (target === undefined) {
      return;
    }
    const items = Array.from(this.Downloads.values());
    const index = items.findIndex((x) => x.id === id);
    [items[index], items[target]] = [items[target], items[index]];
    this.Downloads = new Map(items.map((x) => [x.id, x]));
  }

  private readStoredConcurrency(): number {
    const stored = Number(localStorage.getItem(DOWNLOAD_MAX_CONCURRENT));
    if (!Number.isFinite(stored) || stored < 1) {
      return 1;
    }
    return Math.min(Math.trunc(stored), DownloadService.MAX_CONCURRENT_LIMIT);
  }
}
