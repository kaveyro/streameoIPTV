import { Component, Input } from "@angular/core";
import { Source } from "../../models/source";
import { SourceType } from "../../models/sourceType";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../../memory.service";
import { EditChannelModalComponent } from "../../edit-channel-modal/edit-channel-modal.component";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { EditGroupModalComponent } from "../../edit-group-modal/edit-group-modal.component";
import { ImportModalComponent } from "../../import-modal/import-modal.component";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FAVS_BACKUP, FAVS_BACKUP_EXTENSIONS, PLAYLIST_EXTENSION } from "../../models/extensions";
import { sanitizeFileName } from "../../utils";
import { TranslateService } from "@ngx-translate/core";
import { ConfirmService } from "../../confirm.service";
import { ToastrService } from "ngx-toastr";
import { canCheckSource, sourceForCheck } from "../../source-check";

@Component({
  selector: "app-source-tile",
  templateUrl: "./source-tile.component.html",
  styleUrl: "./source-tile.component.css",
})
export class SourceTileComponent {
  @Input("source")
  source?: Source;
  @Input("expiry")
  expiry?: number;
  showUsername = false;
  showPassword = false;
  loading = false;
  sourceTypeEnum = SourceType;
  editing = false;
  /// "Test connection" is running.
  checking = false;
  editableSource: Source = {};
  defaultUserAgent = "streameoIPTV";

  constructor(
    public memory: MemoryService,
    private modal: NgbModal,
    private translate: TranslateService,
    private confirmService: ConfirmService,
    private toastr: ToastrService,
  ) {}

  get_source_type_name() {
    if (!this.source) return null;
    return SourceType[this.source.source_type!];
  }

  get expiryLabel(): string | undefined {
    if (this.source?.source_type != SourceType.Xtream || !this.expiry) return undefined;
    const date = new Date(this.expiry * 1000).toLocaleDateString();
    return this.translate.instant(this.expiryExpired ? "SOURCE.EXPIRED" : "SOURCE.EXPIRES", {
      date,
    });
  }

  get expiryExpired(): boolean {
    return !!this.expiry && this.expiry * 1000 <= Date.now();
  }

  get expiryDanger(): boolean {
    if (!this.expiry) return false;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return this.expiry * 1000 - Date.now() < sevenDaysMs;
  }

  async refresh() {
    if (this.source?.source_type == SourceType.Xtream) this.memory.SeriesRefreshed.clear();
    await this.memory.tryIPC(
      this.translate.instant("TOAST.SOURCE_UPDATED"),
      this.translate.instant("TOAST.SOURCE_REFRESH_FAILED"),
      () => invoke("refresh_source", { source: this.source }),
    );
  }

  async delete() {
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.DELETE_SOURCE_TITLE",
      messages: ["CONFIRM.DELETE_SOURCE_BODY"],
      confirmLabel: "MODAL.DELETE",
      params: { name: this.source?.name ?? "" },
    });
    if (!confirmed) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.SOURCE_DELETED"),
      this.translate.instant("TOAST.SOURCE_DELETE_FAILED"),
      () => invoke("delete_source", { id: this.source?.id }),
    );
    this.memory.RefreshSources.next(true);
  }

  async toggleEnabled() {
    await this.memory.tryIPC(
      this.translate.instant("TOAST.SOURCE_TOGGLED"),
      this.translate.instant("TOAST.SOURCE_TOGGLE_FAILED"),
      () => invoke("toggle_source", { value: !this.source?.enabled, sourceId: this.source?.id }),
    );
    this.memory.RefreshSources.next(true);
  }

  async addCustomChannel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.channel.data.source_id = this.source?.id;
  }

  async addCustomGroup() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.group.source_id = this.source?.id;
  }

  async import() {
    this.memory.ModalRef = this.modal.open(ImportModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "ImportModalComponent";
    this.memory.ModalRef.componentInstance.source_id = this.source?.id;
  }

  async share() {
    let file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("DIALOG.EXPORT_SOURCE"),
      defaultPath: sanitizeFileName(this.source?.name!) + PLAYLIST_EXTENSION,
    });
    if (file) {
      await this.memory.tryIPC(
        this.translate.instant("TOAST.SOURCE_EXPORTED", { path: file }),
        this.translate.instant("TOAST.SOURCE_EXPORT_FAILED"),
        () => invoke("share_custom_source", { source: this.source, path: file }),
      );
    }
  }

  edit() {
    this.editableSource = { ...this.source };
    this.editing = true;
  }

  async save() {
    await this.memory.tryIPC(
      this.translate.instant("TOAST.CHANGES_SAVED"),
      this.translate.instant("TOAST.CHANGES_SAVE_FAILED"),
      async () => {
        this.editableSource.user_agent = this.editableSource.user_agent?.trim();
        this.editableSource.stream_user_agent = this.editableSource.stream_user_agent?.trim();
        if (this.editableSource.user_agent == "") this.editableSource.user_agent = undefined;
        if (this.editableSource.stream_user_agent == "")
          this.editableSource.stream_user_agent = undefined;
        await invoke("update_source", { source: this.editableSource });
        this.source = this.editableSource;
        this.editing = false;
        this.editableSource = {};
      },
    );
  }

  async browse() {
    const file = await open({
      multiple: false,
      directory: false,
      title: this.translate.instant("DIALOG.SELECT_M3U"),
      filters: [
        {
          name: this.translate.instant("SETTINGS.DIALOG.M3U_PLAYLIST"),
          extensions: ["m3u", "m3u8"],
        },
      ],
    });
    if (file) {
      this.editableSource.url = file;
    }
  }

  canCheck(): boolean {
    return canCheckSource(this.source?.source_type);
  }

  /** Checks the edited settings without saving or refreshing anything. */
  async testConnection() {
    if (this.checking || !this.canCheck()) return;
    this.checking = true;
    try {
      await invoke("check_source", { source: sourceForCheck(this.editableSource) });
      this.toastr.success(this.translate.instant("SOURCE.CHECK_OK"));
    } catch (e) {
      // The backend message is already redacted and meant for the user.
      this.toastr.error(String(e), this.translate.instant("SOURCE.CHECK_FAILED"));
    } finally {
      this.checking = false;
    }
  }

  cancel() {
    this.editableSource = {};
    this.editing = false;
  }

  async backupFavs() {
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("DIALOG.SAVE_FAVORITES"),
      defaultPath: `${sanitizeFileName(this.source?.name!)}_favs${FAVS_BACKUP}`,
    });
    if (file) {
      await this.memory.tryIPC(
        this.translate.instant("TOAST.FAVS_BACKUP_SUCCESS"),
        this.translate.instant("TOAST.FAVS_BACKUP_FAILED"),
        async () => {
          await invoke("backup_favs", { id: this.source?.id, path: file });
        },
      );
    }
  }

  async restoreFavs() {
    const file = await open({
      canCreateDirectories: false,
      title: this.translate.instant("DIALOG.SELECT_FAVS_BACKUP"),
      directory: false,
      multiple: false,
      filters: [
        {
          name: this.translate.instant("DIALOG.FILTER_FAVS_BACKUP"),
          extensions: FAVS_BACKUP_EXTENSIONS,
        },
      ],
    });
    if (file) {
      await this.memory.tryIPC(
        this.translate.instant("TOAST.FAVS_RESTORE_SUCCESS"),
        this.translate.instant("TOAST.FAVS_RESTORE_FAILED"),
        async () => {
          await invoke("restore_favs", { id: this.source?.id, path: file });
        },
      );
    }
  }
}
