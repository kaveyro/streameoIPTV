import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  OnInit,
  AfterViewInit,
  OnDestroy,
} from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subject, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { NowPlayingService } from "../now-playing.service";
import { ViewMode } from "../models/viewMode";
import { NgbModal, NgbTooltipModule } from "@ng-bootstrap/ng-bootstrap";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { ThemeService } from "../theme.service";
import { LanguageService } from "../language.service";
import { TranslateService, TranslatePipe } from "@ngx-translate/core";
import { getVersion } from "@tauri-apps/api/app";
import { UpdateService } from "../update.service";
import { ErrorService } from "../error.service";
import { ConfirmService } from "../confirm.service";
import { ToastrService } from "ngx-toastr";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EpgCoverage, XmltvSourceStatus } from "../models/epgExtras";
import {
  COUNTRY_PREFIX_MODES,
  CountryPrefixMode,
  splitCountryPrefix,
  toCountryPrefixMode,
} from "../country-prefix";
import { uiLocale } from "../utils";
import { FREE_EPG_SOURCES } from "../epg-free-sources";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { SourceTileComponent } from "./source-tile/source-tile.component";
import { TimeAgoPipe } from "../pipes/time-ago.pipe";

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

/// Channel name the country prefix preview is rendered with.
const COUNTRY_PREFIX_SAMPLE = "TR: Kanal D";

@Component({
  selector: "app-settings",
  imports: [
    CommonModule,
    FormsModule,
    TranslatePipe,
    NgbTooltipModule,
    SourceTileComponent,
    TimeAgoPipe,
  ],
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent implements OnInit, AfterViewInit, OnDestroy {
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
  /// Configured XMLTV URLs, in the order the backend loads them.
  xmltvUrls: string[] = [];
  /// Result of the last load per URL (get_xmltv_status).
  xmltvStatus: Record<string, XmltvSourceStatus> = {};
  epgCoverage?: EpgCoverage;
  /// Input of the "add XMLTV URL" field and its inline feedback (keys).
  newXmltvUrl = "";
  xmltvUrlError?: string;
  xmltvUrlHint?: string;
  refreshingXmltv = false;
  /// Version of the running app, shown next to the update controls.
  appVersion = "";
  freeEpgSources = FREE_EPG_SOURCES;
  /// Countries covered by two or more of the added free guides.
  duplicateCountries: { code: string; count: number }[] = [];
  countryPrefixModes = COUNTRY_PREFIX_MODES;
  countryPrefixLabels: Record<CountryPrefixMode, string> = {
    show: "SETTINGS.APPEARANCE.COUNTRY_PREFIX_SHOW",
    hide: "SETTINGS.APPEARANCE.COUNTRY_PREFIX_HIDE",
    badge: "SETTINGS.APPEARANCE.COUNTRY_PREFIX_BADGE",
  };
  countryPrefixSampleFull = COUNTRY_PREFIX_SAMPLE;
  countryPrefixSample = splitCountryPrefix(COUNTRY_PREFIX_SAMPLE);
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
    private nowPlaying: NowPlayingService,
  ) {}

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  setCategory(id: string) {
    this.activeCategory = id;
    if (id == "parental") this.refreshParental();
    if (id == "epg") this.loadXmltvStatus();
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
      .then((arr) => this.setXmltvUrls(arr ?? []))
      .catch(() => this.setXmltvUrls([]));
  }

  private setXmltvUrls(urls: string[]) {
    this.xmltvUrls = urls;
    this.updateDuplicateCountries();
  }

  /// Status per URL and the coverage only change with the XMLTV sources or a
  /// refresh, so they are (re)loaded when the EPG category opens and after
  /// either of those.
  async loadXmltvStatus() {
    const [status, coverage] = await Promise.all([
      invoke<XmltvSourceStatus[]>("get_xmltv_status").catch((e) => {
        console.error(e);
        return [] as XmltvSourceStatus[];
      }),
      invoke<EpgCoverage>("get_epg_coverage").catch((e) => {
        console.error(e);
        return undefined;
      }),
    ]);
    this.xmltvStatus = Object.fromEntries((status ?? []).map((s) => [s.url, s]));
    this.epgCoverage = coverage ?? undefined;
  }

  /// Saves the list. On failure the stored list is loaded back, so the page
  /// never shows URLs that were not saved.
  private async saveXmltvSources(urls: string[]) {
    this.setXmltvUrls(urls);
    try {
      await invoke("set_xmltv_sources", { urls });
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.SETTINGS_SAVE_FAILED"));
      this.getXmltvSources();
    }
    await this.loadXmltvStatus();
  }

  isSourceAdded(url: string): boolean {
    return this.xmltvUrls.includes(url);
  }

  async toggleFreeSource(url: string) {
    const urls = this.xmltvUrls.filter((x) => x !== url);
    if (urls.length === this.xmltvUrls.length) urls.push(url);
    await this.saveXmltvSources(urls);
  }

  async addXmltvSource() {
    this.onXmltvUrlInput();
    const url = this.newXmltvUrl.trim();
    if (!url) return;
    if (!this.isHttpUrl(url)) {
      this.xmltvUrlError = "SETTINGS.EPG.INVALID_URL";
      return;
    }
    if (this.xmltvUrls.includes(url)) {
      this.xmltvUrlHint = "SETTINGS.EPG.DUPLICATE_URL";
      return;
    }
    this.newXmltvUrl = "";
    await this.saveXmltvSources([...this.xmltvUrls, url]);
  }

  async removeXmltvSource(url: string) {
    await this.saveXmltvSources(this.xmltvUrls.filter((x) => x !== url));
  }

  /// Typing clears the feedback of the previous attempt.
  onXmltvUrlInput() {
    this.xmltvUrlError = undefined;
    this.xmltvUrlHint = undefined;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
    } catch {
      return false;
    }
  }

  private updateDuplicateCountries() {
    const counts = new Map<string, number>();
    for (const src of this.freeEpgSources) {
      if (this.xmltvUrls.includes(src.url))
        counts.set(src.country, (counts.get(src.country) ?? 0) + 1);
    }
    this.duplicateCountries = [...counts]
      .filter(([, count]) => count > 1)
      .map(([code, count]) => ({ code, count }));
  }

  /// Country name in the UI language ("DE" -> "Deutschland").
  countryName(code: string): string {
    try {
      return new Intl.DisplayNames(uiLocale(this.translate), { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  /// Programme/channel counts with the locale's digit grouping (73.284).
  formatCount(value: number | undefined): string {
    try {
      return new Intl.NumberFormat(uiLocale(this.translate)).format(value ?? 0);
    } catch {
      return String(value ?? 0);
    }
  }

  async refreshXmltv() {
    if (this.refreshingXmltv) return;
    this.refreshingXmltv = true;
    try {
      const failed = await this.memory.tryIPC(
        this.translate.instant("TOAST.EPG_REFRESHED"),
        this.translate.instant("TOAST.EPG_REFRESH_FAILED"),
        () => invoke("refresh_xmltv"),
      );
      if (!failed) this.nowPlaying.xmltvChanged();
    } finally {
      this.refreshingXmltv = false;
    }
    // Also after a failure: the status shows which source failed and why.
    await this.loadXmltvStatus();
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
        // Unset means on, like the player's own check.
        if (this.settings.auto_fallback == undefined) this.settings.auto_fallback = true;
        this.settings.country_prefix = toCountryPrefixMode(this.settings.country_prefix);
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
    this.memory.CountryPrefixMode = toCountryPrefixMode(this.settings.country_prefix);
    this.memory.AutoFallback = this.settings.auto_fallback ?? true;
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

  async updateCountryPrefix(mode?: string) {
    if (mode !== undefined) this.settings.country_prefix = mode;
    // Applied live, like the playlist name, so the lists match on return.
    this.memory.CountryPrefixMode = toCountryPrefixMode(this.settings.country_prefix);
    await this.updateSettings();
  }

  async updateAutoFallback() {
    // The player reads the flag when a stream fails: apply it before saving.
    this.memory.AutoFallback = this.settings.auto_fallback ?? true;
    await this.updateSettings();
  }

  get countryPrefixMode(): CountryPrefixMode {
    return toCountryPrefixMode(this.settings.country_prefix);
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
      .catch(() => undefined);
  }

  ngAfterViewInit(): void {
    this.subscriptions.push(
      fromEvent<KeyboardEvent>(this.mpvParams.nativeElement, "keyup")
        .pipe(
          map((event: KeyboardEvent) => {
            return (event.target as HTMLInputElement).value;
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
    invoke("player_destroy").catch(() => undefined);
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
      invoke("player_destroy").catch(() => undefined);
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

  async openLogFolder() {
    try {
      await invoke("open_log_folder");
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.LOG_FOLDER_FAILED"));
    }
  }

  /// Writes the redacted diagnostics report (no passwords, no stream
  /// addresses) to a file the user picks, e.g. to attach it to a bug report.
  async exportDiagnostics() {
    const date = new Date().toISOString().split("T")[0];
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_DIAGNOSTICS"),
      defaultPath: `streameo-diagnose-${date}.txt`,
      filters: [{ name: this.translate.instant("SETTINGS.DIALOG.TEXT_FILE"), extensions: ["txt"] }],
    });
    if (!file) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.DIAGNOSTICS_EXPORTED", { path: file }),
      this.translate.instant("TOAST.DIAGNOSTICS_EXPORT_FAILED"),
      () => invoke("export_diagnostics", { path: file }),
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
