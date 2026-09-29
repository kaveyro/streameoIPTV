import { Component, ElementRef, HostListener, ViewChild } from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subject, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { ViewMode } from "../models/viewMode";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { ThemeService } from "../theme.service";
import { LanguageService } from "../language.service";
import { TranslateService } from "@ngx-translate/core";
import { getVersion } from "@tauri-apps/api/app";
import { UpdateService } from "../update.service";
import { ErrorService } from "../error.service";
import { ConfirmService } from "../confirm.service";
import { ToastrService } from "ngx-toastr";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/// Settings that are passed to mpv as launch arguments (see
/// get_global_mpv_args in src-tauri/src/mpv.rs): changing one only takes effect
/// once the embedded player is rebuilt.
const PLAYER_SPAWN_SETTINGS = [
  "enable_hwdec",
  "enable_gpu",
  "volume",
  "preferred_subtitle_language",
  "preferred_audio_language",
  "player_ui",
  "normalize_volume",
  "mpv_params",
  "mpv_debug_log",
] as const;

/// Debounce for settings saved on every input change (sliders, number fields).
const SAVE_DEBOUNCE_MS = 300;
/// At most one "Saved" confirmation per this interval.
const SAVED_TOAST_INTERVAL_MS = 2000;

@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  subscriptions: Subscription[] = [];
  settings: Settings = {
    use_stream_caching: true,
    default_view: ViewMode.All,
    volume: 100,
    restream_port: 3000,
    enable_tray_icon: true,
    zoom: 100,
    default_sort: SortType.provider,
    enable_hwdec: true,
    always_ask_save: false,
    enable_gpu: false,
  };
  viewModeEnum = ViewMode;
  accentColors = [
    { id: "blue", color: "#0d6efd", label: "SETTINGS.APPEARANCE.ACCENT_BLUE" },
    { id: "purple", color: "#8b5cf6", label: "SETTINGS.APPEARANCE.ACCENT_PURPLE" },
    { id: "teal", color: "#14b8a6", label: "SETTINGS.APPEARANCE.ACCENT_TEAL" },
    { id: "coral", color: "#f4713b", label: "SETTINGS.APPEARANCE.ACCENT_CORAL" },
    { id: "green", color: "#22c55e", label: "SETTINGS.APPEARANCE.ACCENT_GREEN" },
  ];
  sources: Source[] = [];
  expiries: Record<number, number> = {};
  expiriesLoaded = false;
  sortTypes = SORT_TYPES;
  settingsCategories = [
    { id: "general", label: "SETTINGS.NAV.GENERAL" },
    { id: "appearance", label: "SETTINGS.NAV.APPEARANCE" },
    { id: "playback", label: "SETTINGS.NAV.PLAYBACK" },
    { id: "recording", label: "SETTINGS.NAV.RECORDING" },
    { id: "network", label: "SETTINGS.NAV.NETWORK" },
    { id: "sources", label: "SETTINGS.NAV.SOURCES" },
    { id: "epg", label: "SETTINGS.NAV.EPG" },
    { id: "parental", label: "SETTINGS.NAV.PARENTAL" },
    { id: "data", label: "SETTINGS.NAV.DATA" },
  ];
  /// Parental lock form (set/change and remove the PIN).
  pinForm = { current: "", next: "", repeat: "", remove: "" };
  pinBusy = false;
  xmltvSourcesText = "";
  /// Version of the running app, shown next to the update controls.
  appVersion = "";
  // Curated free public XMLTV EPG sources for one-click adding.
  freeEpgSources = [
    { label: "IPTV-EPG · Deutschland", url: "https://iptv-epg.org/files/epg-de.xml" },
    { label: "IPTV-EPG · Türkiye", url: "https://iptv-epg.org/files/epg-tr.xml" },
    { label: "IPTV-EPG · United Kingdom", url: "https://iptv-epg.org/files/epg-uk.xml" },
    { label: "IPTV-EPG · United States", url: "https://iptv-epg.org/files/epg-us.xml" },
    { label: "IPTV-EPG · France", url: "https://iptv-epg.org/files/epg-fr.xml" },
    { label: "IPTV-EPG · Nederland", url: "https://iptv-epg.org/files/epg-nl.xml" },
    { label: "IPTV-EPG · España", url: "https://iptv-epg.org/files/epg-es.xml" },
    { label: "IPTV-EPG · Italia", url: "https://iptv-epg.org/files/epg-it.xml" },
    {
      label: "EPGShare · Germany",
      url: "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    },
    {
      label: "EPGShare · Turkey",
      url: "https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz",
    },
    { label: "EPGShare · UK", url: "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz" },
    { label: "EPGShare · USA", url: "https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz" },
  ];
  activeCategory = "general";
  @ViewChild("mpvParams") mpvParams!: ElementRef;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private savedToast = new Subject<void>();
  private lastSavedToastAt = 0;
  /// Player launch settings as last saved, to detect when mpv must be rebuilt.
  private playerSnapshot?: string;

  constructor(
    private router: Router,
    public memory: MemoryService,
    private nav: Router,
    private modal: NgbModal,
    private theme: ThemeService,
    private language: LanguageService,
    private translate: TranslateService,
    public update: UpdateService,
    private error: ErrorService,
    private confirmService: ConfirmService,
    private toastr: ToastrService,
  ) {}

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  setCategory(id: string) {
    this.activeCategory = id;
    if (id == "parental") this.refreshParental();
    if (id == "sources" && !this.expiriesLoaded) {
      this.expiriesLoaded = true;
      this.getExpiries();
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

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    // A mat-menu (e.g. a source's "more actions") handles Escape itself; its
    // keydown still bubbles here and must not also leave the settings.
    if (
      event.defaultPrevented ||
      document.querySelector(".cdk-overlay-container .mat-mdc-menu-panel")
    ) {
      return;
    }
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !this.isInputFocused())
    ) {
      // Any open modal (also untracked ones like the error or confirm dialog)
      // owns the key: never leave the settings behind it.
      if (this.modal.hasOpenModals()) {
        if (this.memory.ModalRef && event.key != "Backspace") this.memory.ModalRef.close("close");
        return;
      }
      this.goBack();
      event.preventDefault();
    }
  }

  ngOnInit(): void {
    this.subscriptions.push(
      this.savedToast.pipe(debounceTime(600)).subscribe(() => {
        const now = Date.now();
        if (now - this.lastSavedToastAt < SAVED_TOAST_INTERVAL_MS) return;
        this.lastSavedToastAt = now;
        this.toastr.success(this.translate.instant("TOAST.SETTINGS_SAVED"), undefined, {
          timeOut: 1500,
          progressBar: false,
          closeButton: false,
        });
      }),
    );
    this.getSettings();
    this.getSources();
    this.getXmltvSources();
    this.refreshParental();
    getVersion()
      .then((version) => (this.appVersion = version))
      .catch(() => (this.appVersion = "?"));
  }

  /// Manual check from the settings: reports every outcome, including that
  /// there is nothing to install.
  async checkForUpdates() {
    await this.update.check(true);
  }

  getXmltvSources() {
    invoke<string[]>("get_xmltv_sources")
      .then((arr) => {
        this.xmltvSourcesText = (arr ?? []).join("\n");
      })
      .catch(() => {
        this.xmltvSourcesText = "";
      });
  }

  private currentUrls(): string[] {
    return this.xmltvSourcesText
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  async saveXmltvSources() {
    await invoke("set_xmltv_sources", { urls: this.currentUrls() });
  }

  isSourceAdded(url: string): boolean {
    return this.currentUrls().includes(url);
  }

  async toggleFreeSource(url: string) {
    const urls = this.currentUrls();
    const idx = urls.indexOf(url);
    if (idx >= 0) urls.splice(idx, 1);
    else urls.push(url);
    this.xmltvSourcesText = urls.join("\n");
    await this.saveXmltvSources();
  }

  async refreshXmltv() {
    await this.memory.tryIPC(
      this.translate.instant("TOAST.EPG_REFRESHED"),
      this.translate.instant("TOAST.EPG_REFRESH_FAILED"),
      () => invoke("refresh_xmltv"),
    );
  }

  getSettings(): Promise<void> {
    return invoke("get_settings")
      .then((x) => {
        this.settings = x as Settings;
        if (this.settings.use_stream_caching == undefined) this.settings.use_stream_caching = true;
        // Matches the startup behaviour, which checks unless explicitly disabled.
        if (this.settings.auto_update == undefined) this.settings.auto_update = true;
        if (this.settings.default_view == undefined) this.settings.default_view = ViewMode.All;
        if (this.settings.volume == undefined) this.settings.volume = 100;
        if (this.settings.restream_port == undefined) this.settings.restream_port = 3000;
        if (this.settings.enable_tray_icon == undefined) this.settings.enable_tray_icon = true;
        if (this.settings.zoom == undefined) this.settings.zoom = 100;
        if (this.settings.default_sort == undefined) this.settings.default_sort = SortType.provider;
        if (this.settings.enable_hwdec == undefined) this.settings.enable_hwdec = true;
        if (this.settings.always_ask_save == undefined) this.settings.always_ask_save = false;
        if (this.settings.enable_gpu == undefined) this.settings.enable_gpu = false;
        if (this.settings.theme == undefined) this.settings.theme = "dark";
        if (this.settings.accent_color == undefined) this.settings.accent_color = "blue";
        if (this.settings.use_external_player == undefined)
          this.settings.use_external_player = false;
        if (this.settings.player_ui == undefined) this.settings.player_ui = "modern";
        if (this.settings.normalize_volume == undefined) this.settings.normalize_volume = false;
        if (this.settings.auto_refresh_hours == undefined) this.settings.auto_refresh_hours = 0;
        if (this.settings.show_channel_source == undefined)
          this.settings.show_channel_source = true;
        this.settings.language = this.settings.language ?? "system";
        this.playerSnapshot = this.playerSettingsSnapshot();
      })
      .catch((e) => this.error.handleError(e));
  }

  private playerSettingsSnapshot(): string {
    const settings = this.settings as unknown as Record<string, unknown>;
    return JSON.stringify(PLAYER_SPAWN_SETTINGS.map((key) => settings[key] ?? null));
  }

  /// Saves after the input settled (slider drags, number fields).
  scheduleSave(delay = SAVE_DEBOUNCE_MS) {
    this.clearScheduledSave();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.updateSettings();
    }, delay);
  }

  private clearScheduledSave(): boolean {
    if (this.saveTimer === undefined) return false;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    return true;
  }

  /// Applies the UI zoom right away, the save itself is debounced.
  /// Applied on `change` (blur, Enter, spinner), not per keystroke: typing
  /// "120" would otherwise shrink the whole UI to 12% on the way.
  onZoomChange(zoom: number | null) {
    if (zoom == null || !Number.isFinite(zoom)) return;
    zoom = Math.min(300, Math.max(50, Math.round(zoom)));
    this.settings.zoom = zoom;
    getCurrentWebview()
      .setZoom(Math.trunc(zoom * 100) / 10000)
      .catch((e) => console.error(e));
    this.scheduleSave();
  }

  /// Re-applies theme, accent, language and zoom from the loaded settings.
  private applyLoadedAppearance() {
    this.theme.apply(this.settings.theme, this.settings.accent_color);
    this.language.apply(this.settings.language === "system" ? undefined : this.settings.language);
    this.memory.ShowChannelSource = this.settings.show_channel_source ?? true;
    if (this.settings.zoom) {
      getCurrentWebview()
        .setZoom(Math.trunc(this.settings.zoom * 100) / 10000)
        .catch((e) => console.error(e));
    }
  }

  async updateTheme(theme?: string) {
    // Take the value from the change event when provided: the (ngModelChange)
    // handler can run before the [(ngModel)] two-way binding assigns the new
    // value, so reading this.settings.theme here would be one selection behind.
    if (theme !== undefined) this.settings.theme = theme;
    this.theme.apply(this.settings.theme, this.settings.accent_color);
    await this.updateSettings();
  }

  async updateLanguage(language?: string) {
    if (language !== undefined) this.settings.language = language;
    this.language.apply(this.settings.language === "system" ? undefined : this.settings.language);
    await this.updateSettings();
  }

  async setAccentColor(accent: string) {
    this.settings.accent_color = accent;
    await this.updateTheme();
  }

  async updateShowChannelSource() {
    // Apply live so the home tiles reflect it immediately on return.
    this.memory.ShowChannelSource = this.settings.show_channel_source ?? true;
    await this.updateSettings();
  }

  getSources() {
    invoke("get_sources")
      .then((x) => {
        this.sources = x as Source[];
        if (this.sources.length == 0) {
          this.memory.AddingAdditionalSource = false;
          this.nav.navigateByUrl("setup");
        }
      })
      .catch((e) => this.error.handleError(e));
  }

  getExpiries() {
    // Best effort: offline providers simply keep tiles without a badge.
    invoke("get_all_expiries")
      .then((expiries) => {
        this.expiries = expiries as Record<number, number>;
      })
      .catch(() => {});
  }

  ngAfterViewInit(): void {
    this.subscriptions.push(
      fromEvent(this.mpvParams.nativeElement, "keyup")
        .pipe(
          map((event: any) => {
            return event.target.value;
          }),
          debounceTime(500),
          distinctUntilChanged(),
        )
        .subscribe(async () => {
          await this.updateSettings();
        }),
    );
    this.subscriptions.push(
      this.memory.RefreshSources.subscribe((_) => {
        this.getSources();
      }),
    );
  }

  addSource() {
    this.memory.AddingAdditionalSource = true;
    this.nav.navigateByUrl("setup");
  }

  async refreshAll() {
    this.memory.SeriesRefreshed.clear();
    await this.memory.tryIPC(
      this.translate.instant("TOAST.SOURCES_UPDATED"),
      this.translate.instant("TOAST.SOURCES_REFRESH_FAILED"),
      () => invoke("refresh_all"),
    );
  }

  async goBack() {
    this.clearScheduledSave();
    try {
      await this.updateSettings();
    } finally {
      // Leave even if saving failed; the error was already reported.
      this.router.navigateByUrl("");
    }
  }

  /// Saves the settings. Returns false (after showing an error) on failure.
  async updateSettings(): Promise<boolean> {
    this.settings.mpv_params = this.settings.mpv_params?.trim();
    if (this.settings.mpv_params == "") this.settings.mpv_params = undefined;
    this.settings.preferred_subtitle_language = this.settings.preferred_subtitle_language?.trim();
    if (this.settings.preferred_subtitle_language == "")
      this.settings.preferred_subtitle_language = undefined;
    this.settings.preferred_audio_language = this.settings.preferred_audio_language?.trim();
    if (this.settings.preferred_audio_language == "")
      this.settings.preferred_audio_language = undefined;
    this.settings.external_player_args = this.settings.external_player_args?.trim();
    if (this.settings.external_player_args == "") this.settings.external_player_args = undefined;
    try {
      await invoke("update_settings", { settings: this.settings });
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.SETTINGS_SAVE_FAILED"));
      return false;
    }
    this.savedToast.next();
    this.resetPlayerIfNeeded();
    return true;
  }

  /// mpv reads hwdec/gpu/volume/UI/... only when it is spawned: tear the
  /// embedded player down so the next channel opens with the new settings.
  private resetPlayerIfNeeded() {
    const snapshot = this.playerSettingsSnapshot();
    if (this.playerSnapshot === undefined || snapshot === this.playerSnapshot) {
      this.playerSnapshot = snapshot;
      return;
    }
    this.playerSnapshot = snapshot;
    this.memory.PlayerReset.next();
    invoke("player_destroy").catch(() => {});
  }

  private refreshParental() {
    this.memory.refreshParental().catch((e) => console.error(e));
  }

  pinValid(pin: string): boolean {
    return /^\d{4,8}$/.test(pin);
  }

  /** Sets the first PIN or changes the existing one. */
  async savePin() {
    const { current, next, repeat } = this.pinForm;
    if (this.pinBusy) return;
    if (!this.pinValid(next)) {
      this.toastr.error(this.translate.instant("PARENTAL.PIN_FORMAT"));
      return;
    }
    if (next !== repeat) {
      this.toastr.error(this.translate.instant("PARENTAL.PIN_MISMATCH"));
      return;
    }
    const changing = this.memory.HasParentalPin;
    this.pinBusy = true;
    try {
      await invoke("set_parental_pin", { currentPin: changing ? current : null, newPin: next });
      this.toastr.success(
        this.translate.instant(changing ? "PARENTAL.PIN_CHANGED" : "PARENTAL.PIN_SET"),
      );
      this.pinForm = { current: "", next: "", repeat: "", remove: "" };
    } catch (e) {
      // "Wrong PIN", "The PIN must be 4 to 8 digits": meant for the user.
      this.toastr.error(String(e));
    } finally {
      this.pinBusy = false;
    }
    this.refreshParental();
  }

  /** Removes the PIN, which also unlocks every locked group. */
  async removePin() {
    const current = this.pinForm.remove;
    if (this.pinBusy || !current) return;
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.REMOVE_PIN_TITLE",
      messages: ["CONFIRM.REMOVE_PIN_BODY"],
      confirmLabel: "SETTINGS.PARENTAL.REMOVE_BTN",
    });
    if (!confirmed) return;
    this.pinBusy = true;
    try {
      await invoke("set_parental_pin", { currentPin: current, newPin: null });
      this.memory.ShowLocked = false;
      this.toastr.success(this.translate.instant("PARENTAL.PIN_REMOVED"));
      this.pinForm = { current: "", next: "", repeat: "", remove: "" };
    } catch (e) {
      this.toastr.error(String(e));
    } finally {
      this.pinBusy = false;
    }
    this.refreshParental();
  }

  async selectFolder() {
    const folder = await open({
      multiple: false,
      directory: true,
      canCreateDirectories: true,
    });
    if (folder) {
      this.settings.recording_path = folder;
      await this.updateSettings();
    }
  }

  async selectExternalPlayer() {
    const file = await open({
      multiple: false,
      directory: false,
      title: this.translate.instant("SETTINGS.DIALOG.SELECT_EXTERNAL_PLAYER"),
    });
    if (file) {
      this.settings.external_player_path = file;
      await this.updateSettings();
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

  async backupDatabase() {
    const date = new Date().toISOString().split("T")[0];
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_BACKUP"),
      defaultPath: `streameo-backup-${date}.sqlite`,
      filters: [
        { name: this.translate.instant("SETTINGS.DIALOG.SQLITE_DATABASE"), extensions: ["sqlite"] },
      ],
    });
    if (!file) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.BACKUP_SAVED", { path: file }),
      this.translate.instant("TOAST.BACKUP_FAILED"),
      () => invoke("backup_database", { path: file }),
    );
  }

  async restoreDatabase() {
    const file = await open({
      multiple: false,
      directory: false,
      title: this.translate.instant("SETTINGS.DIALOG.SELECT_BACKUP"),
      filters: [
        { name: this.translate.instant("SETTINGS.DIALOG.SQLITE_DATABASE"), extensions: ["sqlite"] },
      ],
    });
    if (!file) return;
    const confirmed = await this.confirmService.confirm({
      title: "SETTINGS.RESTORE_MODAL.TITLE",
      messages: ["SETTINGS.RESTORE_MODAL.BODY1", "SETTINGS.RESTORE_MODAL.BODY2"],
      confirmLabel: "SETTINGS.RESTORE_MODAL.CONFIRM",
      html: true,
    });
    if (!confirmed) return;
    const error = await this.memory.tryIPC(
      this.translate.instant("TOAST.RESTORE_SUCCESS"),
      this.translate.instant("TOAST.RESTORE_FAILED"),
      () => invoke("restore_database", { path: file }),
    );
    if (!error) {
      await this.getSettings();
      this.applyLoadedAppearance();
      this.memory.RefreshSources.next(true);
      // The restored settings may change how mpv is launched.
      this.memory.PlayerReset.next();
      invoke("player_destroy").catch(() => {});
    }
  }

  async exportFavorites() {
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_FAVORITES"),
      defaultPath: "streameo-favorites.m3u",
      filters: [
        { name: this.translate.instant("SETTINGS.DIALOG.M3U_PLAYLIST"), extensions: ["m3u"] },
      ],
    });
    if (!file) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.FAVORITES_EXPORTED", { path: file }),
      this.translate.instant("TOAST.FAVORITES_EXPORT_FAILED"),
      () => invoke("export_favorites_m3u", { path: file }),
    );
  }

  async clearHistory() {
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.CLEAR_HISTORY_TITLE",
      messages: ["CONFIRM.CLEAR_HISTORY_BODY"],
      confirmLabel: "SETTINGS.DATA.CLEAR_BTN",
    });
    if (!confirmed) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.HISTORY_CLEARED"),
      this.translate.instant("TOAST.HISTORY_CLEAR_FAILED"),
      async () => {
        await invoke("clear_history");
      },
    );
  }

  ngOnDestroy(): void {
    // Don't drop a change that was still waiting for its debounce.
    if (this.clearScheduledSave()) this.updateSettings();
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
