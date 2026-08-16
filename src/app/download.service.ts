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

/// How many finished downloads are kept in the manager before the oldest ones
/// are dropped.
const HISTORY_LIMIT = 50;

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

  constructor(
    private error: ErrorService,
    private ngZone: NgZone,
    private memory: MemoryService,
    private translate: TranslateService,
  ) {
    this.maxConcurrent = this.readStoredConcurrency();
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
  async enqueue(id: string, channel: Channel, path?: string): Promise<Download> {
    const existing = this.Downloads.get(id);
    if (existing) {
      return existing;
    }
    const download: Download = {
      channel: channel,
      progress: 0,
      complete: new Subject(),
      id: id,
      progressUpdate: new Subject(),
      status: DownloadStatus.Queued,
      path: path,
    };
    download.unlisten = await listen<number>(`progress-${download.id}`, (event) => {
      this.ngZone.run(() => {
        download.progress = event.payload;
      });
      download.progressUpdate.next(download.progress);
    });
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

  /// Puts a finished download back at the end of the queue.
  async retry(download: Download) {
    this.removeFromHistory(download.id);
    await this.enqueue(download.id, download.channel, download.path);
  }

  removeFromHistory(id: string) {
    this.History = this.History.filter((x) => x.id !== id);
  }

  clearHistory() {
    this.History = [];
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
      await invoke("download", {
        downloadId: download.id,
        channel: download.channel,
        path: download.path,
      });
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
    this.Downloads.delete(download.id);
    this.History.unshift(download);
    if (this.History.length > HISTORY_LIMIT) {
      this.History.length = HISTORY_LIMIT;
    }
    download.complete.next(true);
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
