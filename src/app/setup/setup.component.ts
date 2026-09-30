import { Component, HostListener, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { NgbModal, NgbTooltipModule } from "@ng-bootstrap/ng-bootstrap";
import { ToastrService } from "ngx-toastr";
import { invoke } from "@tauri-apps/api/core";
import { SourceType } from "../models/sourceType";
import { Source } from "../models/source";
import { open } from "@tauri-apps/plugin-dialog";
import { ConfirmModalComponent } from "./confirm-modal/confirm-modal.component";
import { MemoryService } from "../memory.service";
import { ErrorService } from "../error.service";
import { TranslateService, TranslatePipe } from "@ngx-translate/core";
import { ConfirmService } from "../confirm.service";
import { LanguageService } from "../language.service";
import { ThemeService } from "../theme.service";
import { Settings } from "../models/settings";
import { PLAYLIST_EXTENSIONS } from "../models/extensions";
import { canCheckSource, sourceForCheck } from "../source-check";
import { CountryCount, XtreamLogin } from "../models/epgExtras";
import { ConfirmDeleteModalComponent } from "../confirm-delete-modal/confirm-delete-modal.component";
import { NowPlayingService } from "../now-playing.service";
import { FREE_EPG_SOURCES, freeEpgSourcesFor, topCountries } from "../epg-free-sources";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { LoadingComponent } from "../loading/loading.component";
import { NotEmptyValidatorDirective } from "./validators/not-empty-validator.directive";
import { SourceNameExistsValidator } from "./validators/source-name-exists-validator.directive";

/// How to import an M3U link that turned out to be an Xtream login.
type LinkImportChoice = "xtream" | "m3u" | "abort";

/// First-run wizard: add a source, pick free guides, done. Adding another
/// source later only has the first step.
export type SetupStep = "source" | "epg" | "done";

@Component({
  selector: "app-setup",
  imports: [
    CommonModule,
    FormsModule,
    TranslatePipe,
    NgbTooltipModule,
    LoadingComponent,
    NotEmptyValidatorDirective,
    SourceNameExistsValidator,
  ],
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
    private nowPlaying: NowPlayingService,
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
  step: SetupStep = "source";
  readonly freeEpgSources = FREE_EPG_SOURCES;
  /// URLs of the free guides chosen in the EPG step.
  selectedEpg = new Set<string>();
  /// The EPG step is detecting the playlist's countries or saving.
  epgBusy = false;
  /// Configured XMLTV URLs that are no free guide: kept when applying.
  private otherXmltvUrls: string[] = [];

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
    if (this.memory.AddingAdditionalSource) {
      this.nav.navigateByUrl("");
      return;
    }
    // First run: offer a TV guide before the channels open.
    this.goToStep("epg");
    void this.suggestEpgSources();
  }

  /// Preselects the free guides for the countries most channels of the
  /// imported playlist carry in their names. Best effort: without an answer
  /// nothing is preselected.
  async suggestEpgSources() {
    this.epgBusy = true;
    try {
      const [sources, configured] = await Promise.all([
        invoke<Source[]>("get_sources"),
        invoke<string[]>("get_xmltv_sources").catch(() => [] as string[]),
      ]);
      const sourceIds = (sources ?? [])
        .filter((s) => s.enabled && s.id != undefined)
        .map((s) => s.id);
      const countries =
        (await invoke<CountryCount[]>("get_countries", { sourceIds, showLocked: false })) ?? [];
      const free = new Set(this.freeEpgSources.map((s) => s.url));
      this.otherXmltvUrls = (configured ?? []).filter((url) => !free.has(url));
      this.selectedEpg = new Set([
        ...(configured ?? []).filter((url) => free.has(url)),
        ...freeEpgSourcesFor(topCountries(countries)).map((s) => s.url),
      ]);
    } catch (e) {
      console.error(e);
    } finally {
      this.epgBusy = false;
    }
  }

  isEpgSelected(url: string): boolean {
    return this.selectedEpg.has(url);
  }

  toggleEpg(url: string) {
    if (!this.selectedEpg.delete(url)) this.selectedEpg.add(url);
  }

  /// Saves the chosen guides and loads them in the background: the download
  /// can take a while and must not hold up the first look at the channels.
  async applyEpg() {
    if (this.epgBusy) return;
    const urls = [
      ...this.otherXmltvUrls,
      ...this.freeEpgSources.map((s) => s.url).filter((url) => this.selectedEpg.has(url)),
    ];
    this.epgBusy = true;
    try {
      await invoke("set_xmltv_sources", { urls });
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.SETTINGS_SAVE_FAILED"));
      return;
    } finally {
      this.epgBusy = false;
    }
    if (urls.length) {
      this.toastr.info(this.translate.instant("TOAST.EPG_LOADING"));
      invoke("refresh_xmltv")
        .then(() => {
          this.nowPlaying.xmltvChanged();
          this.toastr.success(this.translate.instant("TOAST.EPG_REFRESHED"));
        })
        .catch((e) =>
          this.error.handleError(e, this.translate.instant("TOAST.EPG_REFRESH_FAILED")),
        );
    }
    this.goToStep("done");
  }

  skipEpg() {
    this.goToStep("done");
  }

  /// Moves the focus to the new step's heading so keyboard and screen reader
  /// users start there instead of on the removed form.
  private goToStep(step: SetupStep) {
    this.step = step;
    setTimeout(() => document.getElementById("setup-step-title")?.focus());
  }

  finish() {
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
    const login = await this.detectXtreamLogin(this.source.url);
    if (login) {
      const choice = await this.askImportAsXtream();
      if (choice == "abort") return;
      if (choice == "xtream") {
        // Kept so a failed Xtream import (API disabled at the provider)
        // leaves the pasted link in the form for the M3U import.
        const link = { ...this.source };
        this.source.source_type = SourceType.Xtream;
        this.source.url = login.url;
        this.source.username = login.username;
        this.source.password = login.password;
        if (!(await this.getXtream())) this.source = link;
        return;
      }
    }
    this.loading = true;
    try {
      await invoke("get_m3u8_from_link", { source: this.source });
      this.success();
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
    }
    this.loading = false;
  }

  /// The Xtream login inside an M3U link (`.../get.php?username=..`), if any.
  /// Best effort: without an answer the link is imported as before.
  private async detectXtreamLogin(url?: string): Promise<XtreamLogin | undefined> {
    if (!url) return undefined;
    try {
      return (await invoke<XtreamLogin | null>("detect_xtream_login", { url })) ?? undefined;
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  /// Offers the Xtream import (provider EPG, catch-up, series by season). Not
  /// ConfirmService: its cancel and dismiss mean the same, but here the cancel
  /// button is the explicit "import as M3U link" choice and only closing the
  /// dialog (cross, Escape, backdrop: a rejected result) aborts.
  askImportAsXtream(): Promise<LinkImportChoice> {
    const ref = this.modalService.open(ConfirmDeleteModalComponent, { centered: true });
    const dialog = ref.componentInstance as ConfirmDeleteModalComponent;
    dialog.title = "SETUP.XTREAM_DETECTED_TITLE";
    dialog.messages = ["SETUP.XTREAM_DETECTED_BODY1", "SETUP.XTREAM_DETECTED_BODY2"];
    dialog.confirmLabel = "SETUP.IMPORT_AS_XTREAM";
    dialog.cancelLabel = "SETUP.IMPORT_AS_M3U";
    dialog.danger = false;
    dialog.choice = true;
    const choice = ref.result.then(
      (value): LinkImportChoice => (value === true ? "xtream" : "m3u"),
      (): LinkImportChoice => "abort",
    );
    void this.memory.hidePlayerWhile(choice);
    return choice;
  }

  /// Imports the form as an Xtream source; resolves to whether it worked.
  async getXtream(): Promise<boolean> {
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
      return false;
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
      return true;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.INVALID_CREDENTIALS"));
      return false;
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
