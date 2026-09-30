import { Component } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { Group } from "../models/group";
import { ErrorService } from "../error.service";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-edit-group-modal",
  standalone: false,
  templateUrl: "./edit-group-modal.component.html",
  styleUrl: "./edit-group-modal.component.css",
})
export class EditGroupModalComponent {
  editing = false;
  group: Group = {};
  loading = false;
  originalName?: string;

  constructor(
    public activeModal: NgbActiveModal,
    private error: ErrorService,
    private memory: MemoryService,
    private translate: TranslateService,
  ) {}

  async save() {
    // Stay disabled until the backend answered, so a double submit cannot
    // create the same category twice.
    if (this.loading) return;
    this.loading = true;
    try {
      if (this.editing) await this.edit_group();
      else await this.add_group();
    } finally {
      this.loading = false;
    }
  }

  sanitize() {
    this.group.name = this.group.name?.trim();
    this.group.image = this.group.image?.trim();
  }

  async edit_group() {
    try {
      this.sanitize();
      await invoke("edit_custom_group", { group: this.group });
      this.error.success(this.translate.instant("TOAST.CATEGORY_UPDATED"));
      this.memory.Refresh.next(true);
      this.activeModal.close("close");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async add_group() {
    try {
      this.sanitize();
      await invoke("add_custom_group", { group: this.group });
      this.error.success(this.translate.instant("TOAST.CATEGORY_ADDED"));
      this.memory.RefreshSources.next(true);
      this.activeModal.close("close");
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
