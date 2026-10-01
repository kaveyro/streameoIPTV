import { Component } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ToastrService } from "ngx-toastr";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-error-modal",
  standalone: false,
  templateUrl: "./error-modal.component.html",
  styleUrl: "./error-modal.component.css",
})
export class ErrorModalComponent {
  error?: string;
  /// The diagnostics report is being written.
  exporting = false;
  constructor(
    public activeModal: NgbActiveModal,
    private toastr: ToastrService,
    private translate: TranslateService,
  ) {}

  async copy() {
    await writeText(this.error ?? "");
    this.toastr.success(this.translate.instant("TOAST.ERROR_COPIED"));
  }

  /// Failures are toasts here, not ErrorService: that would open another
  /// error dialog on top of this one.
  async openLogFolder() {
    try {
      await invoke("open_log_folder");
    } catch (e) {
      console.error(e);
      this.toastr.error(this.translate.instant("TOAST.LOG_FOLDER_FAILED"));
    }
  }

  /// Same report as Settings → Data (no passwords, no stream addresses).
  async exportDiagnostics() {
    if (this.exporting) return;
    const date = new Date().toISOString().split("T")[0];
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_DIAGNOSTICS"),
      defaultPath: `streameo-diagnose-${date}.txt`,
      filters: [{ name: this.translate.instant("SETTINGS.DIALOG.TEXT_FILE"), extensions: ["txt"] }],
    });
    if (!file) return;
    this.exporting = true;
    try {
      await invoke("export_diagnostics", { path: file });
      this.toastr.success(this.translate.instant("TOAST.DIAGNOSTICS_EXPORTED", { path: file }));
    } catch (e) {
      console.error(e);
      this.toastr.error(this.translate.instant("TOAST.DIAGNOSTICS_EXPORT_FAILED"));
    } finally {
      this.exporting = false;
    }
  }
}
