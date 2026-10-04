import { Injectable } from "@angular/core";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import { MemoryService } from "./memory.service";
import { ErrorService } from "./error.service";
import { UpdateInstaller, UpdateModalComponent } from "./update-modal/update-modal.component";

/**
 * Update checks against the endpoint configured in tauri.conf.json.
 *
 * Nothing is installed behind the user's back: an available update is offered
 * in a dialog, and only a confirmed install downloads and relaunches. The
 * automatic check on startup can be turned off in the settings; a manual check
 * always reports its outcome, including "you are up to date".
 */
@Injectable({
  providedIn: "root",
})
export class UpdateService {
  /// True while a check, the offer dialog or the download is running, so the
  /// settings button can disable itself instead of starting a second one.
  Busy = false;
  /// Only the request to the update endpoint: the settings button says
  /// "Checking..." for this part, not while the dialog is open.
  Checking = false;

  constructor(
    private modal: NgbModal,
    private error: ErrorService,
    private translate: TranslateService,
    private memory: MemoryService,
  ) {}

  /**
   * @param manual true for the button in the settings: report every outcome.
   *               false for the check on startup: stay quiet unless an update
   *               is actually there.
   */
  async check(manual: boolean) {
    if (this.Busy) {
      return;
    }
    this.Busy = true;
    this.Checking = true;
    try {
      const update = await check();
      this.Checking = false;
      if (!update) {
        if (manual) {
          this.error.info(this.translate.instant("TOAST.UPDATE_UP_TO_DATE"));
        }
        return;
      }
      await this.offer(update);
    } catch (e) {
      console.error(e);
      // On startup the endpoint may simply be unreachable; only a check the
      // user asked for is worth interrupting them about.
      if (manual) {
        this.error.handleError(e, this.translate.instant("TOAST.UPDATE_FAILED"));
      }
    } finally {
      this.Checking = false;
      this.Busy = false;
    }
  }

  private async offer(update: Update) {
    const modalRef = this.modal.open(UpdateModalComponent, {
      backdrop: "static",
      keyboard: false,
    });
    modalRef.componentInstance.version = update.version;
    modalRef.componentInstance.currentVersion = await getVersion();
    modalRef.componentInstance.notes = update.body ?? "";
    // The dialog asks about running work first, then downloads with its
    // progress shown. The user explicitly asked for the install, so the dialog
    // reports a failure even for the quiet startup check.
    const install: UpdateInstaller = (onEvent) => update.downloadAndInstall(onEvent);
    modalRef.componentInstance.install = install;
    // The startup check can resolve while a channel is playing; the native
    // video would cover the dialog.
    void this.memory.hidePlayerWhile(modalRef.result);
    const installed = await modalRef.result.catch(() => false);
    if (!installed) {
      return;
    }
    this.error.success(this.translate.instant("TOAST.UPDATE_INSTALLED"));
    try {
      await relaunch();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.UPDATE_RELAUNCH_FAILED"));
    }
  }
}
