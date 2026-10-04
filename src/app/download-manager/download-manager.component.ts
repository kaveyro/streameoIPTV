import { Component } from "@angular/core";
import { DownloadService } from "../download.service";
import { Download, DownloadStatus } from "../models/download";
import { ConfirmService } from "../confirm.service";
import { TranslateService } from "@ngx-translate/core";
import { formatFileSize, uiLocale } from "../utils";

@Component({
  selector: "app-download-manager",
  standalone: false,
  templateUrl: "./download-manager.component.html",
  styleUrl: "./download-manager.component.css",
})
export class DownloadManagerComponent {
  isMinimized = false;
  showHistory = true;
  statusEnum = DownloadStatus;
  concurrencyOptions = Array.from(
    { length: DownloadService.MAX_CONCURRENT_LIMIT },
    (_, i) => i + 1,
  );

  constructor(
    public downloadService: DownloadService,
    private confirmService: ConfirmService,
    private translate: TranslateService,
  ) {}

  /// The percentage is known: the server sent the size (or progress came in).
  hasProgress(download: Download): boolean {
    return !!download.total || download.progress > 0;
  }

  /// "12 MB of 1.2 GB · 2.1 MB/s", "12 MB · 2.1 MB/s" without a known size.
  transferText(download: Download): string {
    if (download.downloaded === undefined) return "";
    const locale = uiLocale(this.translate);
    let text = download.total
      ? this.translate.instant("DOWNLOAD.BYTES_OF", {
          done: formatFileSize(download.downloaded, locale),
          total: formatFileSize(download.total, locale),
        })
      : formatFileSize(download.downloaded, locale);
    if (download.speed !== undefined) {
      text +=
        " · " +
        this.translate.instant("DOWNLOAD.SPEED", {
          speed: formatFileSize(download.speed, locale),
        });
    }
    return text;
  }

  async reveal(download: Download) {
    await this.downloadService.reveal(download);
  }

  async play(download: Download) {
    await this.downloadService.play(download);
  }

  /// Queued and active downloads, in queue order.
  getDownloads() {
    return Array.from(this.downloadService.Downloads.values());
  }

  getHistory() {
    return this.downloadService.History;
  }

  trackById(_index: number, download: Download) {
    return download.id;
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
  }

  toggleHistory() {
    this.showHistory = !this.showHistory;
  }

  togglePause() {
    this.downloadService.togglePause();
  }

  setConcurrency(event: Event) {
    this.downloadService.MaxConcurrent = Number((event.target as HTMLSelectElement).value);
  }

  async cancelDownload(downloadId: string) {
    await this.downloadService.abortDownload(downloadId);
  }

  async cancelAll() {
    const count = this.downloadService.Downloads.size;
    if (count === 0) return;
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.CANCEL_DOWNLOADS_TITLE",
      messages: ["CONFIRM.CANCEL_DOWNLOADS_BODY"],
      confirmLabel: "DOWNLOAD.CANCEL_ALL",
      params: { count },
      trashIcon: false,
    });
    if (!confirmed) return;
    await this.downloadService.abortAll();
  }

  moveUp(downloadId: string) {
    this.downloadService.moveUp(downloadId);
  }

  moveDown(downloadId: string) {
    this.downloadService.moveDown(downloadId);
  }

  canMoveUp(downloadId: string) {
    return this.downloadService.canMoveUp(downloadId);
  }

  canMoveDown(downloadId: string) {
    return this.downloadService.canMoveDown(downloadId);
  }

  async retry(download: Download) {
    await this.downloadService.retry(download);
  }

  remove(downloadId: string) {
    this.downloadService.removeFromHistory(downloadId);
  }

  clearHistory() {
    this.downloadService.clearHistory();
  }

  statusLabel(download: Download) {
    switch (download.status) {
      case DownloadStatus.Queued:
        return "DOWNLOAD.STATUS_QUEUED";
      case DownloadStatus.Active:
        return "DOWNLOAD.STATUS_ACTIVE";
      case DownloadStatus.Completed:
        return "DOWNLOAD.STATUS_COMPLETED";
      case DownloadStatus.Failed:
        return "DOWNLOAD.STATUS_FAILED";
      default:
        return "DOWNLOAD.STATUS_CANCELLED";
    }
  }
}
