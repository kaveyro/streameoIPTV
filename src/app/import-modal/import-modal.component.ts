import { Component } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-import-modal",
  templateUrl: "./import-modal.component.html",
  styleUrl: "./import-modal.component.css",
})
export class ImportModalComponent {
  source_id?: number;
  nameOverride?: string;
  constructor(
    public activeModal: NgbActiveModal,
    public memory: MemoryService,
    private translate: TranslateService,
  ) {}

  async selectFile() {
    const file = await open({
      multiple: false,
      directory: false,
      canCreateDirectories: false,
      title: this.translate.instant("IMPORT.SELECT_FILE"),
      filters: [{ name: "extension", extensions: ["otv", "otvg"] }],
    });
    if (file == null) {
      return;
    }
    this.nameOverride = this.nameOverride?.trim();
    if (this.nameOverride == "") this.nameOverride = undefined;
    let fail = await this.memory.tryIPC(
      this.translate.instant("TOAST.IMPORT_SUCCESS"),
      this.translate.instant("TOAST.IMPORT_FAILED"),
      () =>
      invoke("import", { sourceId: this.source_id, path: file, nameOverride: this.nameOverride }),
    );
    this.memory.RefreshSources.next(true);
    if (!fail) this.activeModal.close("close");
  }
}
