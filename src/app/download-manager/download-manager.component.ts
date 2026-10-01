import { Component } from "@angular/core";
import { DownloadService } from "../download.service";
import { Download, DownloadStatus } from "../models/download";
import { ConfirmService } from "../confirm.service";

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
  ) {}

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
