import { Component, ElementRef, HostListener, TemplateRef, ViewChild } from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { ViewMode } from "../models/viewMode";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ConfirmDeleteModalComponent } from "../confirm-delete-modal/confirm-delete-modal.component";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { ThemeService } from "../theme.service";
import { LanguageService } from "../language.service";
import { TranslateService } from "@ngx-translate/core";
import { getVersion } from "@tauri-apps/api/app";
import { UpdateService } from "../update.service";

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
    { id: "blue", color: "#0d6efd" },
    { id: "purple", color: "#8b5cf6" },
    { id: "teal", color: "#14b8a6" },
    { id: "coral", color: "#f4713b" },
    { id: "green", color: "#22c55e" },
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
    { id: "data", label: "SETTINGS.NAV.DATA" },
  ];
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
    { label: "EPGShare · Germany", url: "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz" },
    { label: "EPGShare · Turkey", url: "https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz" },
    { label: "EPGShare · UK", url: "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz" },
    { label: "EPGShare · USA", url: "https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz" },
  ];
  activeCategory = "general";
  @ViewChild("mpvParams") mpvParams!: ElementRef;
  @ViewChild("restoreModal") restoreModal!: TemplateRef<any>;

  constructor(
    private router: Router,
    public memory: MemoryService,
    private nav: Router,
    private modal: NgbModal,
    private theme: ThemeService,
    private language: LanguageService,
    private translate: TranslateService,
    public update: UpdateService,
  ) { }

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  setCategory(id: string) {
    this.activeCategory = id;
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
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !this.isInputFocused())
    ) {
      if (this.memory.ModalRef) {
        this.memory.ModalRef.close("close");
      } else {
        this.goBack();
      }
      event.preventDefault();
    }
  }

  ngOnInit(): void {
    this.getSettings();
    this.getSources();
    this.getXmltvSources();
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

  getSettings() {
    invoke("get_settings").then((x) => {
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
      if (this.settings.use_external_player == undefined) this.settings.use_external_player = false;
      if (this.settings.player_ui == undefined) this.settings.player_ui = "modern";
      if (this.settings.normalize_volume == undefined) this.settings.normalize_volume = false;
      if (this.settings.auto_refresh_hours == undefined) this.settings.auto_refresh_hours = 0;
      if (this.settings.show_channel_source == undefined) this.settings.show_channel_source = true;
      this.settings.language = this.settings.language ?? "system";
    });
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
    invoke("get_sources").then((x) => {
      this.sources = x as Source[];
      if (this.sources.length == 0) {
        this.memory.AddingAdditionalSource = false;
        this.nav.navigateByUrl("setup");
      }
    });
  }

  getExpiries() {
    // Best effort: offline providers simply keep tiles without a badge.
    invoke("get_all_expiries")
      .then(expiries => {
        this.expiries = expiries as Record<number, number>;
      })
      .catch(() => { });
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
    await this.updateSettings();
    this.router.navigateByUrl("");
  }

  async updateSettings() {
    this.settings.mpv_params = this.settings.mpv_params?.trim();
    if (this.settings.mpv_params == "")
      this.settings.mpv_params = undefined;
    this.settings.preferred_subtitle_language = this.settings.preferred_subtitle_language?.trim();
    if (this.settings.preferred_subtitle_language == "")
      this.settings.preferred_subtitle_language = undefined;
    this.settings.preferred_audio_language = this.settings.preferred_audio_language?.trim();
    if (this.settings.preferred_audio_language == "")
      this.settings.preferred_audio_language = undefined;
    this.settings.external_player_args = this.settings.external_player_args?.trim();
    if (this.settings.external_player_args == "")
      this.settings.external_player_args = undefined;
    await invoke("update_settings", { settings: this.settings });
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
    this.memory.ModalRef = this.modal.open(ConfirmDeleteModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "ConfirmDeleteModal";
  }

  async backupDatabase() {
    const date = new Date().toISOString().split("T")[0];
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_BACKUP"),
      defaultPath: `streameo-backup-${date}.sqlite`,
      filters: [{ name: this.translate.instant("SETTINGS.DIALOG.SQLITE_DATABASE"), extensions: ["sqlite"] }],
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
      filters: [{ name: this.translate.instant("SETTINGS.DIALOG.SQLITE_DATABASE"), extensions: ["sqlite"] }],
    });
    if (!file) return;
    this.memory.ModalRef = this.modal.open(this.restoreModal, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    const result = await this.memory.ModalRef.result.catch(() => "cancel");
    this.memory.ModalRef = undefined;
    if (result != "confirm") return;
    const error = await this.memory.tryIPC(
      this.translate.instant("TOAST.RESTORE_SUCCESS"),
      this.translate.instant("TOAST.RESTORE_FAILED"),
      () => invoke("restore_database", { path: file }),
    );
    if (!error) {
      this.getSettings();
      this.memory.RefreshSources.next(true);
    }
  }

  async exportFavorites() {
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("SETTINGS.DIALOG.SAVE_FAVORITES"),
      defaultPath: "streameo-favorites.m3u",
      filters: [{ name: this.translate.instant("SETTINGS.DIALOG.M3U_PLAYLIST"), extensions: ["m3u"] }],
    });
    if (!file) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.FAVORITES_EXPORTED", { path: file }),
      this.translate.instant("TOAST.FAVORITES_EXPORT_FAILED"),
      () => invoke("export_favorites_m3u", { path: file }),
    );
  }

  async clearHistory() {
    await this.memory.tryIPC(
      this.translate.instant("TOAST.HISTORY_CLEARED"),
      this.translate.instant("TOAST.HISTORY_CLEAR_FAILED"),
      async () => {
        await invoke("clear_history");
      },
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
