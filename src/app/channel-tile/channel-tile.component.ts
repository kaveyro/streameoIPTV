import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Renderer2,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { MediaType } from "../models/mediaType";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../error.service";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
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
import { NodeType, fromMediaType } from "../models/nodeType";

import { ViewMode } from "../models/viewMode";
import { ViewFormat } from "../models/viewFormat";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { LogoCacheService } from "../logo-cache.service";
import { NowPlaying, NowPlayingService } from "../now-playing.service";
import { TranslateService } from "@ngx-translate/core";
import { ConfirmService } from "../confirm.service";
import { PlaybackService } from "../playback.service";
import { ParentalService } from "../parental.service";
import { splitCountryPrefix } from "../country-prefix";

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
  standalone: false,
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
  ) {}
  @Input() channel?: Channel;
  @Input() id!: number;
  @Input() viewMode: number = 0;
  @Input() format: ViewFormat = "grid";
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;
  menuTopLeftPosition = { x: 0, y: 0 };
  showImage: boolean = true;
  starting: boolean = false;
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
  sourceName = "";
  /// Country prefix of the name ("TR"), for the badge display mode.
  countryCode?: string;
  /// A series/category is being opened (get_episodes can take a while); a
  /// second click meanwhile must not push the same level twice.
  private opening = false;

  ngOnInit(): void {
    const image = this.channel?.image;
    if (image) {
      this.logoCache.getLogo(image).then((src) => (this.logoSrc = src));
    }
    this.loadNowPlaying();
    this.subscriptions.push(
      this.nowPlayingService.changed.subscribe(() => this.reloadNowPlaying()),
    );
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["channel"]) {
      this.sourceName = this.getSourceName();
      this.countryCode = splitCountryPrefix(this.channel?.name).code;
    }
    if (changes["format"] && !changes["format"].firstChange) {
      this.loadNowPlaying();
    }
  }

  private loadNowPlaying() {
    if (this.nowPlayingRequested || !this.showNowPlayingLine()) return;
    this.nowPlayingRequested = true;
    this.nowPlayingService.getNowPlaying(this.channel!).then((nowPlaying) => {
      if (!nowPlaying) return;
      this.nowPlaying = nowPlaying;
      const duration = nowPlaying.end_timestamp - nowPlaying.start_timestamp;
      const elapsed = Date.now() / 1000 - nowPlaying.start_timestamp;
      this.nowPlayingProgress =
        duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
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

  /** Accessible name: the full channel name plus what is on right now. */
  ariaLabel(): string {
    const name = this.channel?.name ?? "";
    return this.nowPlayingSummary ? `${name}, ${this.nowPlayingSummary}` : name;
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
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    if (!element) return;
    const clamped = Math.min(100, Math.max(0, progress || 0));
    this.renderer.addClass(element, "downloading");
    (element as HTMLElement).style.setProperty("--dl-progress", `${clamped}%`);
  }

  clearDownloadGradient() {
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    if (!element) return;
    this.renderer.removeClass(element, "downloading");
    (element as HTMLElement).style.removeProperty("--dl-progress");
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
        await this.playback.play(this.channel!);
      }
    } catch (e) {
      this.error.handleError(e);
    }
    invoke("add_last_watched", { id: this.channel?.id }).catch((e) => {
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
    const element = this.el.nativeElement.querySelector(`#tile-${this.id}`) as HTMLElement | null;
    const rect = (element ?? (this.el.nativeElement as HTMLElement)).getBoundingClientRect();
    this.openMenuAt(rect.left + Math.min(rect.width / 2, 48), rect.top + rect.height / 2);
  }

  private isMenuOpen(): boolean {
    return this.memory.currentContextMenu === this.matMenuTrigger && this.matMenuTrigger.menuOpen;
  }

  private openMenuAt(x: number, y: number) {
    this.alreadyExistsInFav = this.channel!.favorite!;
    this.downloading = this.isDownloading();
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

  onError(event: Event) {
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
      if (wasFavorite) {
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

  isGroup(): boolean {
    return this.channel?.media_type == MediaType.group;
  }

  /** A locked group, shown because the PIN was entered in this session. */
  isLockedGroup(): boolean {
    return this.isGroup() && this.parental.isLocked(this.channel);
  }

  /** Movies and episodes in the history resume where they were left. */
  showResumeBadge(): boolean {
    return this.viewMode == ViewMode.History && this.isMovie();
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
      let data: EPG[] = await invoke("get_epg", { channel: this.channel });
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
    let file = await save({
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
    let download = await this.download.enqueue(
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
    let download = this.download.Downloads.get(this.channel!.id!.toString());
    if (download) {
      this.setDownloadGradient(download.progress);
      this.downloadSubscribe(download);
    }
  }

  downloadSubscribe(download: Download) {
    let progressUpdate = download.progressUpdate.subscribe((progress) => {
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
      await writeText(this.channel?.url ?? "");
      this.error.success(this.translate.instant("TOAST.URL_COPIED"));
    } catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
