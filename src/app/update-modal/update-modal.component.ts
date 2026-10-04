import { Component, Input, NgZone } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { invoke } from "@tauri-apps/api/core";
import { DownloadEvent } from "@tauri-apps/plugin-updater";
import { TranslateService } from "@ngx-translate/core";
import { ErrorService } from "../error.service";
import { renderReleaseNotes } from "./release-notes";

/// Downloads and installs the offered update, reporting the progress.
export type UpdateInstaller = (onEvent: (event: DownloadEvent) => void) => Promise<void>;

/**
 * Asks before an update is installed. Installing restarts the app, which used
 * to happen unannounced right after launch - in the middle of playback if the
 * check happened to finish late. Running recordings and downloads (and
 * recordings due soon) are named before they are cut off, and the download
 * shows its progress in the dialog. Closes with true once the update is
 * installed (the caller relaunches), false otherwise.
 */
@Component({
  selector: "app-update-modal",
  standalone: false,
  templateUrl: "./update-modal.component.html",
  styleUrl: "./update-modal.component.css",
})
export class UpdateModalComponent {
  @Input() version = "";
  @Input() currentVersion = "";
  /// Release notes as published with the update (Markdown), may be empty.
  @Input()
  set notes(value: string) {
    this._notes = value ?? "";
    this.notesHtml = renderReleaseNotes(this._notes);
  }
  get notes(): string {
    return this._notes;
  }
  /// Without one the dialog only confirms (closes with true).
  @Input() install?: UpdateInstaller;
  private _notes = "";
  /// The notes rendered from their Markdown subset (escaped, see release-notes.ts).
  notesHtml = "";
  /// offer: the question; warn: work would be stopped; installing: progress.
  state: "offer" | "warn" | "installing" = "offer";
  /// Recordings and downloads running or due within the next hours.
  pendingCount = 0;
  /// The pending work is being counted.
  checkingPending = false;
  downloaded = 0;
  /// Size of the download; unknown until (and unless) the server sends it.
  total?: number;

  constructor(
    public activeModal: NgbActiveModal,
    private ngZone: NgZone,
    private error: ErrorService,
    private translate: TranslateService,
  ) {}

  /// Percent downloaded, undefined while the size is unknown.
  get percent(): number | undefined {
    if (!this.total) return undefined;
    return Math.min(100, Math.round((this.downloaded / this.total) * 100));
  }

  /// "Install now": first warns about work the restart would stop.
  async requestInstall() {
    if (this.checkingPending) return;
    this.checkingPending = true;
    // An older backend without the command counts as nothing pending.
    const count = await invoke<number>("pending_work_count").catch(() => 0);
    this.checkingPending = false;
    if (count > 0) {
      this.pendingCount = count;
      this.state = "warn";
      return;
    }
    await this.installNow();
  }

  /// "Install anyway", or "Install now" with nothing pending.
  async installNow() {
    if (this.state === "installing") return;
    if (!this.install) {
      this.activeModal.close(true);
      return;
    }
    this.state = "installing";
    try {
      // The updater reports from outside Angular's zone.
      await this.install((event) => this.ngZone.run(() => this.onProgress(event)));
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.UPDATE_INSTALL_FAILED"));
      this.activeModal.close(false);
      return;
    }
    this.activeModal.close(true);
  }

  onProgress(event: DownloadEvent) {
    switch (event.event) {
      case "Started":
        this.downloaded = 0;
        this.total = event.data.contentLength || undefined;
        break;
      case "Progress":
        this.downloaded += event.data.chunkLength;
        break;
      case "Finished":
        if (this.total) this.downloaded = this.total;
        break;
    }
  }
}
