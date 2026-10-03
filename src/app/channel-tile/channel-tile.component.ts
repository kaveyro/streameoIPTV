import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  Renderer2,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { MatMenuTrigger, MatMenuModule } from "@angular/material/menu";
import { MatDividerModule } from "@angular/material/divider";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { MediaType } from "../models/mediaType";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../error.service";
import { NgbModal, NgbTooltipModule } from "@ng-bootstrap/ng-bootstrap";
import { EditChannelModalComponent } from "../edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "../edit-group-modal/edit-group-modal.component";
import { DeleteGroupModalComponent } from "../delete-group-modal/delete-group-modal.component";
import { EpgModalComponent } from "../epg-modal/epg-modal.component";
import { EpgMappingModalComponent } from "../epg-mapping-modal/epg-mapping-modal.component";
import { EPG } from "../models/epg";
import { RestreamModalComponent } from "../restream-modal/restream-modal.component";
import { DownloadService } from "../download.service";
import { Download } from "../models/download";
import { Subscription, take } from "rxjs";
import { save } from "@tauri-apps/plugin-dialog";
import { CHANNEL_EXTENSION, GROUP_EXTENSION, RECORD_EXTENSION } from "../models/extensions";
import { getDateFormatted, getExtension, sanitizeFileName, uiLocale } from "../utils";
import { fromMediaType } from "../models/nodeType";

import { ViewMode } from "../models/viewMode";
import { ViewFormat } from "../models/viewFormat";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { LogoCacheService } from "../logo-cache.service";
import {
  NowPlaying,
  NowPlayingService,
  programmeEnded,
  programmeProgress,
} from "../now-playing.service";
import { TranslateService, TranslatePipe } from "@ngx-translate/core";
import { ConfirmService } from "../confirm.service";
import { PlaybackService } from "../playback.service";
import { ParentalService } from "../parental.service";
import { splitCountryPrefix } from "../country-prefix";
import { FavoriteList, FavoriteListsService } from "../favorite-lists/favorite-lists.service";
import { CommonModule } from "@angular/common";
import { CountryNamePipe } from "../pipes/country-name.pipe";
import { WatchProgressService, isResumable, watchPercent } from "../watch-progress.service";

/// Tiles this far outside the viewport already load their now/next line, so
/// it is there when they scroll in.
const VISIBILITY_MARGIN = "200px";

/// One clock formatter per locale, shared by all tiles (a grid page shows dozens).
const clockFormats = new Map<string, Intl.DateTimeFormat>();

function formatClock(timestamp: number, locale?: string): string {
  const key = locale ?? "";
  let format = clockFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
    } catch {
      format = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
    }
    clockFormats.set(key, format);
  }
  return format.format(timestamp * 1000);
}

@Component({
  selector: "app-channel-tile",
  imports: [
    CommonModule,
    TranslatePipe,
    NgbTooltipModule,
    MatMenuModule,
    MatDividerModule,
    CountryNamePipe,
  ],
  templateUrl: "./channel-tile.component.html",
  styleUrl: "./channel-tile.component.css",
})
export class ChannelTileComponent implements OnInit, OnChanges, OnDestroy, AfterViewInit {
  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    private el: ElementRef,
    private renderer: Renderer2,
    private download: DownloadService,
    private logoCache: LogoCacheService,
    private nowPlayingService: NowPlayingService,
    private translate: TranslateService,
    private confirmService: ConfirmService,
    private playback: PlaybackService,
    private parental: ParentalService,
    private ngZone: NgZone,
    public favoriteLists: FavoriteListsService,
    private watchProgressService: WatchProgressService,
  ) {}
  @Input() channel?: Channel;
  @Input() id!: number;
  @Input() viewMode = 0;
  @Input() format: ViewFormat = "grid";
  /// The favorites list the home page shows (favorites view only), for
  /// "remove from list".
  @Input() favoriteList?: number;
  /// The home page shows the own order: offer moving the tile.
  @Input() reorderable = false;
  /// First/last tile of the whole order (nothing to move past).
  @Input() first = false;
  @Input() last = false;
  /// "Move forward" (-1) / "move back" (+1) from the context menu; the home
  /// page moves the tile and saves the order.
  @Output() move = new EventEmitter<-1 | 1>();
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;
  @ViewChild("title") titleElement?: ElementRef<HTMLElement>;
  /// The name is cut off (ellipsis or line clamp): only then the tooltip
  /// shows it in full. Measured when the pointer or the focus arrives.
  nameTruncated = false;
  menuTopLeftPosition = { x: 0, y: 0 };
  showImage = true;
  starting = false;
  alreadyExistsInFav = false;
  downloading = false;
  mediaTypeEnum = MediaType;
  viewModeEnum = ViewMode;
  subscriptions: Subscription[] = [];
  fade = false;
  logoSrc?: string;
  nowPlaying?: NowPlaying;
  nowPlayingProgress = 0;
  /// "20:15–21:15" of the current programme and the start of the next one,
  /// formatted once when the programme loads.
  nowPlayingTimes = "";
  nextStart = "";
  /// "Playing now: <title> (20:15–21:15)" for the tile's accessible name.
  private nowPlayingSummary = "";
  private nowPlayingRequested = false;
  /// Within VISIBILITY_MARGIN of the viewport: only such tiles load their
  /// now/next line and follow the minute ticks.
  private visible = false;
  private visibilityObserver?: IntersectionObserver;
  /// Movies and episodes: how far they were watched (0..100) for the bar,
  /// undefined when there is nothing to resume.
  watchProgress?: number;
  /// Left midway: can be resumed or started over.
  resumable = false;
  /// Watched to the end.
  watched = false;
  /// Lists the channel is in, loaded when the context menu opens.
  listMembership?: Set<number>;
  sourceName = "";
  /// Country prefix of the name ("TR"), for the badge display mode.
  countryCode?: string;
  /// A series/category is being opened (get_episodes can take a while); a
  /// second click meanwhile must not push the same level twice.
  private opening = false;
  /// The open context menu came from the ContextMenu key / Shift+F10.
  private menuFromKeyboard = false;

  ngOnInit(): void {
    const image = this.channel?.image;
    if (image) {
      this.logoCache.getLogo(image).then((src) => (this.logoSrc = src));
    }
    this.watchVisibility();
    this.subscriptions.push(
      this.nowPlayingService.changed.subscribe(() => this.reloadNowPlaying()),
      this.nowPlayingService.minuteTick.subscribe(() => this.updateNowPlaying()),
      this.watchProgressService.changed.subscribe((progress) => {
        if (WatchProgressService.apply(this.channel, progress)) this.updateWatchProgress();
      }),
    );
  }

  /// Loads the now/next line once the tile comes near the viewport (a page
  /// of 36 tiles would otherwise ask for 36 guides at once). Without
  /// IntersectionObserver every tile counts as visible.
  private watchVisibility() {
    if (typeof IntersectionObserver === "undefined") {
      this.visible = true;
      this.loadNowPlaying();
      return;
    }
    // Callbacks come often while scrolling: only re-enter the zone when the
    // tile became visible.
    this.ngZone.runOutsideAngular(() => {
      this.visibilityObserver = new IntersectionObserver(
        (entries) => {
          const visible = entries[entries.length - 1]?.isIntersecting ?? false;
          if (visible === this.visible) return;
          this.visible = visible;
          if (visible) this.ngZone.run(() => this.onVisible());
        },
        { rootMargin: VISIBILITY_MARGIN },
      );
      this.visibilityObserver.observe(this.el.nativeElement);
    });
  }

  private onVisible() {
    if (!this.nowPlayingRequested) this.loadNowPlaying();
    else this.updateNowPlaying();
  }

  /// Minute tick (and back in view): moves the progress bar on, or loads the
  /// next programme once the current one ended.
  private updateNowPlaying() {
    if (!this.visible || !this.nowPlaying) return;
    if (programmeEnded(this.nowPlaying)) this.reloadNowPlaying();
    else this.nowPlayingProgress = programmeProgress(this.nowPlaying);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["channel"]) {
      this.sourceName = this.getSourceName();
      this.countryCode = splitCountryPrefix(this.channel?.name).code;
      this.updateWatchProgress();
    }
    if (changes["format"] && !changes["format"].firstChange) {
      this.loadNowPlaying();
    }
  }

  private loadNowPlaying() {
    if (this.nowPlayingRequested || !this.visible || !this.showNowPlayingLine()) return;
    this.nowPlayingRequested = true;
    this.nowPlayingService.getNowPlaying(this.channel!).then((nowPlaying) => {
      if (!nowPlaying) {
        // Nothing on air now (a gap in the guide): drop the ended programme.
        this.nowPlaying = undefined;
        this.nowPlayingProgress = 0;
        this.nowPlayingTimes = "";
        this.nextStart = "";
        this.nowPlayingSummary = "";
        return;
      }
      this.nowPlaying = nowPlaying;
      this.nowPlayingProgress = programmeProgress(nowPlaying);
      const locale = uiLocale(this.translate);
      this.nowPlayingTimes = `${formatClock(nowPlaying.start_timestamp, locale)}–${formatClock(nowPlaying.end_timestamp, locale)}`;
      this.nextStart = nowPlaying.next ? formatClock(nowPlaying.next.start_timestamp, locale) : "";
      this.nowPlayingSummary = `${this.translate.instant("EPG.PLAYING_NOW")}: ${nowPlaying.title} (${this.nowPlayingTimes})`;
    });
  }

  /** Loads the now-playing line again, e.g. after the EPG was assigned. */
  reloadNowPlaying() {
    this.nowPlaying = undefined;
    this.nowPlayingProgress = 0;
    this.nowPlayingSummary = "";
    this.nowPlayingRequested = false;
    this.loadNowPlaying();
  }

  private updateWatchProgress() {
    this.resumable = isResumable(this.channel);
    this.watchProgress = watchPercent(this.channel);
    this.watched = this.channel?.watch_finished === true;
  }

  /** Accessible name: number, the full channel name and what is on right now
   *  (or how far a movie was watched). */
  ariaLabel(): string {
    const number = this.channel?.number;
    const name = (number != null ? `${number} ` : "") + (this.channel?.name ?? "");
    if (this.nowPlayingSummary) return `${name}, ${this.nowPlayingSummary}`;
    if (this.watchProgress !== undefined) {
      const percent = Math.round(this.watchProgress);
      return `${name}, ${this.translate.instant("TILE.WATCH_PROGRESS", { percent })}`;
    }
    if (this.watched) return `${name}, ${this.translate.instant("TILE.WATCHED")}`;
    return name;
  }

  /** Forgets the resume point and plays the movie from the beginning. */
  async playFromStart() {
    if (!this.channel) return;
    try {
      await this.watchProgressService.clear(this.channel);
    } catch (e) {
      this.error.handleError(e);
      return;
    }
    await this.click();
  }

  async markUnwatched() {
    if (!this.channel) return;
    try {
      await this.watchProgressService.clear(this.channel);
    } catch (e) {
      this.error.handleError(e);
    }
  }

  showNowPlayingLine(): boolean {
    return (
      this.channel?.media_type === MediaType.livestream &&
      this.nowPlayingService.hasEpg(this.channel)
    );
  }

  ngAfterViewInit(): void {
    this.getExistingDownload();
  }

  // Download progress is drawn by channel-tile.component.css (.channel.downloading)
  // from the --dl-progress custom property, so theming/hover/focus keep working.
  setDownloadGradient(progress: number) {
    const element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    if (!element) return;
    const clamped = Math.min(100, Math.max(0, progress || 0));
    this.renderer.addClass(element, "downloading");
    (element as HTMLElement).style.setProperty("--dl-progress", `${clamped}%`);
  }

  clearDownloadGradient() {
    const element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    if (!element) return;
    this.renderer.removeClass(element, "downloading");
    (element as HTMLElement).style.removeProperty("--dl-progress");
  }

  /** Enter/Space on the tile (role="button"): one activation per press. */
  onActivateKey(event: Event) {
    // Space would scroll the page; a handled Enter must not also reach the
    // home page's key handler.
    event.preventDefault();
    if ((event as KeyboardEvent).repeat) return;
    void this.click();
  }

  checkNameTruncated() {
    const title = this.titleElement?.nativeElement;
    this.nameTruncated =
      !!title && (title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight);
  }

  /// The tooltip only repeats the name, which the aria-label already
  /// carries: no aria-describedby, so screen readers do not read it twice.
  onTooltipShown() {
    this.tileElement()?.removeAttribute("aria-describedby");
  }

  async click(record = false) {
    if (this.starting === true) {
      try {
        await invoke("cancel_play", {
          sourceId: this.channel?.source_id,
          channelId: this.channel?.id,
        });
      } catch (e) {
        this.error.handleError(e);
      }
      return;
    }
    if (
      this.channel?.media_type == MediaType.serie ||
      this.channel?.media_type == MediaType.group ||
      this.channel?.media_type == MediaType.season
    ) {
      if (this.opening) return;
      this.opening = true;
      try {
        if (
          this.channel.media_type == MediaType.serie &&
          !this.memory.SeriesRefreshed.has(this.channel.id!)
        ) {
          this.memory.HideChannels.next(false);
          try {
            await invoke("get_episodes", { channel: this.channel });
            this.memory.SeriesRefreshed.set(this.channel.id!, true);
          } catch (e) {
            this.error.handleError(e, this.translate.instant("TOAST.FETCH_SERIES_FAILED"));
          }
        }
        this.memory.SetNode.next({
          id:
            this.channel?.media_type == MediaType.serie
              ? parseInt(this.channel.url!)
              : this.channel.id!,
          name: this.channel.name!,
          type: fromMediaType(this.channel.media_type),
          sourceId: this.channel.source_id,
        });
      } finally {
        this.opening = false;
      }
      return;
    }
    let file = undefined;
    if (record && (this.memory.IsContainer || this.memory.AlwaysAskSave)) {
      file = await save({
        canCreateDirectories: true,
        title: this.translate.instant("DIALOG.SAVE_RECORDING"),
        defaultPath: `${sanitizeFileName(this.channel?.name!)}_${getDateFormatted()}${RECORD_EXTENSION}`,
      });
      if (!file) return;
    }
    this.starting = true;
    this.memory.SetFocus.next(this.id);
    try {
      // Recording keeps using the classic spawn-a-window path; everything
      // else goes through the shared playback path (embedded player, which
      // switches channels over IPC without restarting mpv, or the user's
      // external player).
      if (record) {
        await invoke("play", { channel: this.channel, record: record, recordPath: file });
      } else {
        await this.playback.play(this.channel!, this.memory.LibraryChannelList);
      }
    } catch (e) {
      // Nothing played: keep it out of the history.
      this.error.handleError(e);
      this.starting = false;
      return;
    }
    this.playback.addToHistory(this.channel!).catch((e) => {
      console.error(e);
      this.error.handleError(e);
    });
    this.starting = false;
  }

  onRightClick(event: MouseEvent) {
    if (this.channel?.media_type == MediaType.season) return;
    event.preventDefault();
    // The ContextMenu key / Shift+F10 also fire a contextmenu event, usually
    // without pointer coordinates; the keyboard handler already opened the
    // menu at the tile then.
    const fromKeyboard = event.button !== 2 || (event.clientX === 0 && event.clientY === 0);
    if (fromKeyboard) {
      if (!this.isMenuOpen()) this.openContextMenuFromKeyboard();
      return;
    }
    this.openMenuAt(event.clientX, event.clientY);
  }

  /** Opens the context menu anchored to the tile (ContextMenu key, Shift+F10). */
  openContextMenuFromKeyboard() {
    if (this.channel?.media_type == MediaType.season) return;
    const element = this.tileElement() ?? (this.el.nativeElement as HTMLElement);
    const rect = element.getBoundingClientRect();
    this.openMenuAt(rect.left + Math.min(rect.width / 2, 48), rect.top + rect.height / 2);
    this.menuFromKeyboard = true;
  }

  private tileElement(): HTMLElement | null {
    return this.el.nativeElement.querySelector(`#tile-${this.id}`) as HTMLElement | null;
  }

  /// The menu's trigger is an invisible helper that cannot take the focus
  /// back, so it would end up on <body>. A menu opened by keyboard returns
  /// it to the tile; otherwise only a focus that is already lost is put back.
  /// While the menu animates out, its focused item is still in the DOM.
  onMenuClosed() {
    const fromKeyboard = this.menuFromKeyboard;
    this.menuFromKeyboard = false;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const inMenu = active?.closest(".mat-mdc-menu-panel") != null;
    if (lost || (fromKeyboard && inMenu)) this.tileElement()?.focus({ preventScroll: true });
  }

  private isMenuOpen(): boolean {
    return this.memory.currentContextMenu === this.matMenuTrigger && this.matMenuTrigger.menuOpen;
  }

  private openMenuAt(x: number, y: number) {
    this.menuFromKeyboard = false;
    this.alreadyExistsInFav = this.channel!.favorite!;
    this.downloading = this.isDownloading();
    this.loadListMembership();
    this.menuTopLeftPosition.x = x;
    this.menuTopLeftPosition.y = y;
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    // Let the trigger move to the new position before the overlay measures it.
    setTimeout(() => this.matMenuTrigger.openMenu(), 0);
  }

  /** Whether favorite() makes sense here (same rule as the context menu). */
  canFavorite(): boolean {
    return (
      this.channel?.media_type != MediaType.group &&
      this.channel?.media_type != MediaType.season &&
      this.viewMode != ViewMode.History
    );
  }

  /// Fills the check marks of the "add to list" submenu. The lists
  /// themselves come from the service (loaded by the home page).
  private loadListMembership() {
    this.listMembership = undefined;
    if (!this.canFavorite() || !this.channel) return;
    if (this.favoriteLists.lists.value === undefined) void this.favoriteLists.load();
    const channel = this.channel;
    this.favoriteLists.membership(channel).then((ids) => {
      if (this.channel === channel) this.listMembership = ids;
    });
  }

  isInList(list: FavoriteList): boolean {
    return this.listMembership?.has(list.id) ?? false;
  }

  /** Adds the channel to the list or takes it out (check mark in the submenu). */
  async toggleList(list: FavoriteList, event?: Event) {
    // Keep the submenu open, so several lists can be ticked in a row.
    event?.stopPropagation();
    if (!this.channel || !this.listMembership) return;
    const member = !this.isInList(list);
    if (await this.favoriteLists.setMember(list, this.channel, member)) {
      if (member) this.listMembership.add(list.id);
      else this.listMembership.delete(list.id);
      // Taken out of the list that is shown: gone after the next load.
      if (!member && list.id === this.favoriteList) this.memory.Refresh.next(false);
    }
  }

  /** "New list…": asks for a name and puts the channel into the new list. */
  async addToNewList() {
    const channel = this.channel;
    if (!channel) return;
    const id = await this.favoriteLists.promptCreate();
    const list = this.favoriteLists.current().find((l) => l.id === id);
    if (list) await this.favoriteLists.setMember(list, channel, true);
  }

  /** "Remove from list" in the list view of a favorites list. */
  async removeFromList() {
    const list = this.favoriteLists.current().find((l) => l.id === this.favoriteList);
    if (!list || !this.channel) return;
    if (await this.favoriteLists.setMember(list, this.channel, false)) {
      this.memory.Refresh.next(false);
    }
  }

  moveBy(delta: -1 | 1) {
    this.move.emit(delta);
  }

  onError(_event: Event) {
    // If the cached data URL fails to render, fall back to the remote URL
    // once; if that fails too (or there is nothing to fall back to), hide
    // the image like before.
    const remote = this.channel?.image;
    if (remote && this.logoSrc && this.logoSrc !== remote) {
      this.logoSrc = remote;
    } else {
      this.showImage = false;
    }
  }

  async favorite() {
    let call = "favorite_channel";
    const wasFavorite = this.channel!.favorite;
    const name = this.channel?.name;
    if (wasFavorite) {
      call = "unfavorite_channel";
    }
    try {
      await invoke(call, { channelId: this.channel!.id });
      this.channel!.favorite = !wasFavorite;
      // A favorites list is kept apart from the favorite flag: the tile
      // stays in the list shown, only its star goes.
      const list = this.shownList();
      if (wasFavorite && this.favoriteList !== undefined) {
        this.toastr.success(
          list
            ? this.translate.instant("TOAST.FAVORITE_REMOVED_STAYS_IN_LIST", {
                name,
                list: list.name,
              })
            : this.translate.instant("TOAST.FAVORITE_REMOVED", { name }),
        );
      } else if (wasFavorite) {
        if (this.viewMode == ViewMode.Favorites) this.fade = true;
        this.toastr.success(this.translate.instant("TOAST.FAVORITE_REMOVED", { name }));
      } else {
        if (this.viewMode == ViewMode.Favorites) this.fade = false;
        this.toastr.success(this.translate.instant("TOAST.FAVORITE_ADDED", { name }));
      }
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.FAVORITE_FAILED", { name }));
    }
  }

  /// The favorites list the home page shows, if one (not the favorites).
  private shownList(): FavoriteList | undefined {
    if (this.favoriteList === undefined) return undefined;
    return this.favoriteLists.current().find((l) => l.id === this.favoriteList);
  }

  isGroup(): boolean {
    return this.channel?.media_type == MediaType.group;
  }

  /// Locking needs a parental PIN; a group locked before the PIN was removed
  /// can still be unlocked.
  canLockGroup(): boolean {
    return this.isGroup() && (this.memory.HasParentalPin || this.isLockedGroup());
  }

  /** A locked group, shown because the PIN was entered in this session. */
  isLockedGroup(): boolean {
    return this.isGroup() && this.parental.isLocked(this.channel);
  }

  /** Movies and episodes in the history resume where they were left. */
  showResumeBadge(): boolean {
    return this.resumable;
  }

  async toggleGroupLock() {
    if (!this.channel) return;
    if (await this.parental.toggleGroupLock(this.channel)) this.memory.Refresh.next(false);
  }

  async removeFromHistory() {
    const name = this.channel?.name;
    try {
      await invoke("remove_from_history", { id: this.channel!.id });
      this.memory.Refresh.next(false);
      this.toastr.success(this.translate.instant("TOAST.HISTORY_REMOVED", { name }));
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.HISTORY_REMOVE_FAILED", { name }));
    }
  }

  async record() {
    await this.click(true);
  }

  isMovie() {
    return this.channel?.media_type == MediaType.movie;
  }

  isLivestream() {
    return this.channel?.media_type == MediaType.livestream;
  }

  isCustom(): boolean {
    return this.memory.CustomSourceIds!.has(this.channel?.source_id!);
  }

  showEPG(): boolean {
    return (
      this.channel?.media_type == MediaType.livestream &&
      !this.isCustom() &&
      this.nowPlayingService.hasEpg(this.channel)
    );
  }

  /** Assigning a guide by hand needs an XMLTV guide to pick from. */
  canMapEpg(): boolean {
    return this.isLivestream() && this.memory.HasXmltv;
  }

  getSourceName(): string {
    if (!this.channel?.source_id) return "";
    return this.memory.Sources.get(this.channel.source_id)?.name || "";
  }

  async showEPGModal() {
    try {
      const data: EPG[] = await invoke("get_epg", { channel: this.channel });
      if (data.length == 0) {
        this.toastr.info(this.translate.instant("TOAST.NO_EPG"));
        return;
      }
      this.memory.ModalRef = this.modal.open(EpgModalComponent, {
        backdrop: "static",
        size: "xl",
        keyboard: false,
      });
      this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
      this.memory.ModalRef.componentInstance.epg = data;
      this.memory.ModalRef.componentInstance.name = this.channel?.name;
      this.memory.ModalRef.componentInstance.channelId = this.channel?.id;
      this.memory.ModalRef.componentInstance.sourceId = this.channel?.source_id;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.EPG_MISSING_STREAM_ID"));
    }
  }

  openEpgMapping() {
    this.memory.ModalRef = this.modal.open(EpgMappingModalComponent, {
      backdrop: "static",
      size: "lg",
      keyboard: false,
      ariaLabelledBy: "epg-mapping-title",
    });
    this.memory.ModalRef.componentInstance.channel = this.channel;
    this.memory.ModalRef.result.then((changed) => {
      this.memory.ModalRef = undefined;
      if (changed === true) this.reloadNowPlaying();
    });
  }

  edit() {
    if (this.channel?.media_type == MediaType.group) this.edit_group();
    else {
      this.edit_channel();
    }
  }

  edit_group() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.group = {
      id: this.channel!.id,
      name: this.channel!.name,
      image: this.channel!.image,
      source_id: this.channel!.source_id,
    };
    this.memory.ModalRef.componentInstance.originalName = this.channel!.name;
  }

  edit_channel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.channel.data = { ...this.channel };
  }

  async share() {
    const isGroup = this.channel?.media_type == MediaType.group;
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant(isGroup ? "DIALOG.EXPORT_GROUP" : "DIALOG.EXPORT_CHANNEL"),
      defaultPath:
        sanitizeFileName(this.channel?.name!) + (isGroup ? GROUP_EXTENSION : CHANNEL_EXTENSION),
    });
    if (!file) {
      return;
    }
    if (isGroup) {
      this.memory.tryIPC(
        this.translate.instant("TOAST.CATEGORY_EXPORTED", { path: file }),
        this.translate.instant("TOAST.EXPORT_FAILED"),
        () => invoke("share_custom_group", { group: this.channel, path: file }),
      );
    } else {
      this.memory.tryIPC(
        this.translate.instant("TOAST.CHANNEL_EXPORTED", { path: file }),
        this.translate.instant("TOAST.EXPORT_FAILED"),
        () => invoke("share_custom_channel", { channel: this.channel, path: file }),
      );
    }
  }

  async delete() {
    if (this.channel?.media_type == MediaType.group) this.deleteGroup();
    else await this.deleteChannel();
  }

  async deleteGroup() {
    try {
      if (await invoke("group_not_empty", { id: this.channel?.id })) {
        this.openDeleteGroupModal();
      } else await this.deleteGroupNoReplace();
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async deleteGroupNoReplace() {
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.DELETE_CATEGORY_TITLE",
      messages: ["CONFIRM.DELETE_CATEGORY_BODY"],
      confirmLabel: "MODAL.DELETE",
      params: { name: this.channel?.name ?? "" },
    });
    if (!confirmed) return;
    try {
      await invoke("delete_custom_group", {
        id: this.channel?.id,
        doChannelsUpdate: false,
      });
      this.memory.Refresh.next(true);
      this.error.success(this.translate.instant("TOAST.CATEGORY_DELETED"));
    } catch (e) {
      this.error.handleError(e);
    }
  }

  openDeleteGroupModal() {
    this.memory.ModalRef = this.modal.open(DeleteGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "DeleteGroupModal";
    this.memory.ModalRef.componentInstance.group = { ...this.channel };
  }

  openRestreamModal() {
    this.memory.ModalRef = this.modal.open(RestreamModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.componentInstance.channel = this.channel;
    this.memory.ModalRef.componentInstance.name = "RestreamModalComponent";
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
  }

  async deleteChannel() {
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.DELETE_CHANNEL_TITLE",
      messages: ["CONFIRM.DELETE_CHANNEL_BODY"],
      confirmLabel: "MODAL.DELETE",
      params: { name: this.channel?.name ?? "" },
    });
    if (!confirmed) return;
    await this.memory.tryIPC(
      this.translate.instant("TOAST.CHANNEL_DELETED"),
      this.translate.instant("TOAST.CHANNEL_DELETE_FAILED"),
      () => invoke("delete_custom_channel", { id: this.channel?.id }),
    );
    this.memory.Refresh.next(true);
  }

  isDownloading() {
    return this.download.Downloads.has(this.channel!.id!.toString());
  }

  async downloadVod() {
    let file = undefined;
    if (this.memory.IsContainer || this.memory.AlwaysAskSave) {
      file = await save({
        canCreateDirectories: true,
        title: this.translate.instant("DIALOG.DOWNLOAD_MOVIE"),
        defaultPath: `${sanitizeFileName(this.channel?.name!)}.${getExtension(this.channel?.url!)}`,
      });
      if (!file) {
        return;
      }
    }
    const download = await this.download.enqueue(
      this.channel!.id!.toString(),
      this.channel!,
      file ?? undefined,
    );
    this.downloadSubscribe(download);
  }

  async cancelDownload() {
    await this.download.abortDownload(this.channel!.id!.toString());
  }

  getExistingDownload() {
    const download = this.download.Downloads.get(this.channel!.id!.toString());
    if (download) {
      this.setDownloadGradient(download.progress);
      this.downloadSubscribe(download);
    }
  }

  downloadSubscribe(download: Download) {
    const progressUpdate = download.progressUpdate.subscribe((progress) => {
      this.setDownloadGradient(progress);
      if (progress == 100) progressUpdate.unsubscribe();
    });
    this.subscriptions.push(progressUpdate);
    this.subscriptions.push(
      download.complete.pipe(take(1)).subscribe((_) => {
        progressUpdate.unsubscribe();
        this.clearDownloadGradient();
      }),
    );
  }

  async copyURL() {
    try {
      // Stored Xtream URLs hold placeholders instead of the login.
      const url = await invoke<string>("resolve_channel_url", { channel: this.channel });
      await writeText(url ?? "");
      this.error.success(this.translate.instant("TOAST.URL_COPIED"));
    } catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy() {
    this.visibilityObserver?.disconnect();
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
