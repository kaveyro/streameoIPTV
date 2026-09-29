import { Component, HostListener, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ToastrService } from "ngx-toastr";
import { invoke } from "@tauri-apps/api/core";
import { SourceType } from "../models/sourceType";
import { Source } from "../models/source";
import { open } from "@tauri-apps/plugin-dialog";
import { ConfirmModalComponent } from "./confirm-modal/confirm-modal.component";
import { MemoryService } from "../memory.service";
import { ErrorService } from "../error.service";
import { TranslateService } from "@ngx-translate/core";
import { ConfirmService } from "../confirm.service";
import { LanguageService } from "../language.service";
import { ThemeService } from "../theme.service";
import { Settings } from "../models/settings";
import { PLAYLIST_EXTENSIONS } from "../models/extensions";
import { canCheckSource, sourceForCheck } from "../source-check";

@Component({
  selector: "app-setup",
  templateUrl: "./setup.component.html",
  styleUrl: "./setup.component.css",
})
export class SetupComponent implements OnInit {
  constructor(
    private nav: Router,
    private toastr: ToastrService,
    private modalService: NgbModal,
    public memory: MemoryService,
    private error: ErrorService,
    private translate: TranslateService,
    private confirmService: ConfirmService,
    private languageService: LanguageService,
    private themeService: ThemeService,
  ) {}
  loading = false;
  /// "Test connection" is running.
  checking = false;
  /// Inline error for the URL field (e.g. an URL that cannot be parsed).
  urlError?: string;
  /// Stored settings, so the first-run language/theme pickers can persist
  /// their choice the same way the settings page does.
  settings: Settings = {};
  readonly languageOptions = LanguageService.OPTIONS;
  readonly themeOptions = [
    { id: "system", label: "SETTINGS.APPEARANCE.THEME_SYSTEM" },
    { id: "dark", label: "SETTINGS.APPEARANCE.THEME_DARK" },
    { id: "light", label: "SETTINGS.APPEARANCE.THEME_LIGHT" },
    { id: "oled", label: "SETTINGS.APPEARANCE.THEME_OLED" },
  ];
  sourceTypeEnum = SourceType;
  source: Source = {
    source_type: SourceType.M3U,
    enabled: true,
    use_tvg_id: false,
  };

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    // A modal (URL confirmation, delete confirmation, error) owns the key.
    if (this.modalService.hasOpenModals()) return;
    if (
      (event.key == "Escape" || event.key == "Backspace") &&
      this.memory.AddingAdditionalSource &&
      !this.isInputFocused()
    ) {
      this.goBack();
      event.preventDefault();
    }
  }

  isInputFocused(): boolean {
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    );
  }

  ngOnInit(): void {
    invoke<Settings>("get_settings")
      .then((settings) => {
        this.settings = settings ?? {};
        this.settings.language = this.settings.language ?? "system";
        this.settings.theme = this.settings.theme ?? "dark";
      })
      .catch(() => {
        // First launch: nothing stored yet, keep the defaults.
        this.settings = { language: "system", theme: "dark" };
      });
  }

  async updateLanguage(language: string) {
    this.settings.language = language;
    this.languageService.apply(language === "system" ? undefined : language);
    await this.saveSettings();
  }

  async updateTheme(theme: string) {
    this.settings.theme = theme;
    this.themeService.apply(theme, this.settings.accent_color);
    await this.saveSettings();
  }

  private async saveSettings() {
    try {
      await invoke("update_settings", { settings: this.settings });
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.SETTINGS_SAVE_FAILED"));
    }
  }

  canCheck(): boolean {
    return canCheckSource(this.source.source_type);
  }

  /** Checks that the source can be reached and logged into, without importing. */
  async testConnection() {
    if (this.checking || !this.canCheck()) return;
    this.checking = true;
    try {
      await invoke("check_source", { source: sourceForCheck(this.source) });
      this.toastr.success(this.translate.instant("SOURCE.CHECK_OK"));
    } catch (e) {
      // The backend message is already redacted and meant for the user.
      this.toastr.error(String(e), this.translate.instant("SOURCE.CHECK_FAILED"));
    } finally {
      this.checking = false;
    }
  }

  switchMode(sourceType: SourceType) {
    this.source.source_type = sourceType;
  }

  goBack() {
    this.nav.navigateByUrl("settings");
  }

  async getM3U() {
    this.removeUnusedFieldsFromSource();
    const file = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: this.translate.instant("SETTINGS.DIALOG.M3U_PLAYLIST"),
          extensions: ["m3u", "m3u8"],
        },
      ],
    });
    if (file == null) {
      return;
    }
    this.loading = true;
    this.source.url = file;
    try {
      await invoke("get_m3u8", { source: this.source });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.PARSE_FILE_FAILED"));
    } finally {
      this.loading = false;
    }
  }

  success() {
    this.toastr.success(this.translate.instant("TOAST.SOURCE_ADDED", { name: this.source.name }));
    this.nav.navigateByUrl("");
  }

  removeUnusedFieldsFromSource() {
    this.source.username = undefined;
    this.source.password = undefined;
  }

  async submit() {
    this.source.name = this.source.name?.trim();
    switch (this.source.source_type) {
      case SourceType.M3U:
        await this.getM3U();
        break;
      case SourceType.M3ULink:
        await this.getM3ULink();
        break;
      case SourceType.Xtream:
        await this.getXtream();
        break;
      case SourceType.Custom:
        await this.custom();
        break;
      case SourceType.CustomImport:
        await this.customImport();
        break;
    }
  }

  async customImport() {
    const file = await open({
      multiple: false,
      directory: false,
      canCreateDirectories: false,
      title: this.translate.instant("SETUP.SELECT_EXPORT_FILE"),
      filters: [
        {
          name: this.translate.instant("DIALOG.FILTER_STREAMEO_EXPORT"),
          extensions: PLAYLIST_EXTENSIONS,
        },
      ],
    });
    if (file == null) {
      return;
    }
    let nameOverride = this.source.name?.trim();
    if (nameOverride == "") nameOverride = undefined;
    try {
      await invoke("import", { path: file, nameOverride: nameOverride });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
    }
  }

  async custom() {
    this.loading = true;
    try {
      await invoke("add_custom_source", { name: this.source.name });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
    }
    this.loading = false;
  }

  async getM3ULink() {
    this.removeUnusedFieldsFromSource();
    this.source.url = this.source.url?.trim();
    this.loading = true;
    try {
      await invoke("get_m3u8_from_link", { source: this.source });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
    }
    this.loading = false;
  }

  async getXtream() {
    this.urlError = undefined;
    this.source.use_tvg_id = undefined;
    this.source.url = this.source.url?.trim();
    this.source.username = this.source.username?.trim();
    this.source.password = this.source.password?.trim();
    if (!this.source?.url?.startsWith("http://") && !this.source?.url?.startsWith("https://")) {
      this.source.url = `http://${this.source.url}`;
      this.toastr.info(this.translate.instant("TOAST.HTTP_ASSUMED"));
    }
    let url: URL;
    try {
      url = new URL(this.source.url);
    } catch {
      // e.g. "http://my host:8080": report it instead of hanging on the
      // loading screen.
      this.urlError = this.translate.instant("SETUP.INVALID_URL", { url: this.source.url });
      this.toastr.error(this.urlError);
      return;
    }
    this.loading = true;
    try {
      if (url.pathname == "/") {
        const result = await this.modalService
          .open(ConfirmModalComponent, {
            keyboard: false,
            backdrop: "static",
          })
          .result.catch(() => "ignore");
        if (result == "correct") {
          url.pathname = "/player_api.php";
          this.source.url = url.toString();
        }
      }
      await invoke("get_xtream", { source: this.source });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
    } finally {
      this.loading = false;
    }
  }

  async nuke() {
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM_DELETE.TITLE",
      messages: ["CONFIRM_DELETE.BODY1", "CONFIRM_DELETE.BODY2"],
      confirmLabel: "MODAL.CONFIRM_DELETE",
    });
    if (!confirmed) return;
    try {
      // The backend schedules the wipe and exits the app.
      await invoke("delete_database");
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
