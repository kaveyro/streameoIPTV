import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild,
} from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { Subscription } from "rxjs";
import { TranslateService } from "@ngx-translate/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { ErrorService } from "../error.service";
import { NowPlaying, NowPlayingService } from "../now-playing.service";
import { splitCountryPrefix } from "../country-prefix";

/// Keys the backend forwards while mpv (not the WebView) has keyboard focus,
/// see the `player-key` event.
type PlayerKey = "next" | "prev" | "back" | "last";

/// Class on <body> while the player is shown (the toasts are styled with it).
const BODY_CLASS = "player-open";
/// Class on <body> while the mini player is shown: the floating elements of
/// the page (scroll-to-top, download manager) move out of its corner.
const MINI_BODY_CLASS = "player-mini";

/// Everything behind the overlay. Marked inert while the player is shown, so
/// Tab cannot walk the hidden home page and the tile that started playback
/// loses focus (its Enter handler would otherwise restart that channel).
const BACKGROUND_SELECTOR = "main, app-download-manager";

function setBackgroundInert(inert: boolean) {
  document
    .querySelectorAll(BACKGROUND_SELECTOR)
    .forEach((el) => el.toggleAttribute("inert", inert));
}

/**
 * In-app video surface for the embedded, persistent mpv player.
 *
 * mpv renders into a native child window that the Rust side keeps aligned with
 * the {@link videoHost} rectangle (see `player.rs`). Because that native window
 * always composites above the WebView, NO DOM may be painted over the video —
 * all controls live beside/below it (the bar and the channel list). Switching a
 * channel just sends `player_play` over IPC; mpv never restarts.
 */
@Component({
  selector: "app-player",
  standalone: false,
  templateUrl: "./player.component.html",
  styleUrl: "./player.component.css",
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  /// Minimum gap between two playback-failure toasts.
  private static readonly ERROR_TOAST_INTERVAL_MS = 5000;
  /// How often the now/next line and its progress bar are refreshed.
  private static readonly EPG_REFRESH_MS = 30 * 1000;
  active = false;
  /// Playing on in the small corner window while the rest of the app is used.
  mini = false;
  current?: Channel;
  /// The channel played before {@link current}, for the "last channel" key.
  previous?: Channel;
  fullscreen = false;
  /// Text of the filter input above the side list.
  filterText = "";
  nowPlaying?: NowPlaying;
  nowProgress = 0;
  private initialized = false;
  /// Shared by concurrent opens so player_init runs only once.
  private initPromise?: Promise<void>;
  /// Incremented by every open() and back(): an open that awaited while a
  /// newer open/back happened must not start (or keep) playback.
  private openGeneration = 0;
  /// Value of openGeneration set by the latest back().
  private closedGeneration = 0;
  /// Incremented per channel switch, so late results of an older switch are
  /// ignored.
  private switchSeq = 0;
  /// The last attempt to play {@link current} failed: selecting it again
  /// must retry instead of being ignored as "already playing".
  private currentFailed = false;
  private embeddedUnavailable = false;
  private resizeObserver?: ResizeObserver;
  private subscriptions: Subscription[] = [];
  private unlistens: UnlistenFn[] = [];
  private lastErrorAt = 0;
  private epgTimer?: ReturnType<typeof setInterval>;
  private filterCache?: { source: Channel[]; text: string; result: Channel[] };
  /// Country codes of the names shown as a badge, see {@link countryCode}.
  private countryCodes = new Map<string, string | undefined>();
  /// Whether any ng-bootstrap modal is open.
  private modalsOpen = false;
  /// The native window was hidden because a modal opened over the mini
  /// player; it is shown again when the last modal closes.
  private hiddenForModal = false;
  @ViewChild("videoHost") videoHost?: ElementRef<HTMLDivElement>;
  @ViewChild("playerList") playerList?: ElementRef<HTMLElement>;

  constructor(
    public memory: MemoryService,
    private ngZone: NgZone,
    private error: ErrorService,
    private translate: TranslateService,
    private nowPlayingService: NowPlayingService,
    private modal: NgbModal,
    private host: ElementRef<HTMLElement>,
  ) {}

  ngAfterViewInit(): void {
    this.subscriptions.push(this.memory.PlayerOpen.subscribe((ch) => this.open(ch)));
    // Settings that only apply when mpv spawns changed and the player was torn
    // down: the next open has to build a new one.
    // The mini player's video is gone with it: close the mini player.
    this.subscriptions.push(
      this.memory.PlayerReset.subscribe(() => {
        this.initialized = false;
        if (this.active && this.mini) this.back();
      }),
    );
    // The full player's dialogs hide the video through memory.hidePlayerWhile,
    // which only acts while PlayerVisible. Beside the mini player the page is
    // usable, so any dialog may open: hide the native window while one is.
    this.subscriptions.push(
      this.modal.activeInstances.subscribe((modals) => this.onModalsChanged(modals.length > 0)),
    );
    // mpv reports a double-click / `f` key (rebound to a script-message) here;
    // toggle app-level fullscreen since mpv can't fullscreen an embedded child.
    // The mini player grows back to the full player instead.
    listen("player-toggle-fullscreen", () => {
      if (!this.active) return;
      this.ngZone.run(() => (this.mini ? this.expand() : this.toggleFullscreen()));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // Channel keys pressed while mpv has keyboard focus (the WebView gets no
    // key events then): PgDn/PgUp/Esc/Backspace.
    listen<string>("player-key", (event) => {
      if (!this.active) return;
      this.ngZone.run(() => this.handlePlayerKey(event.payload as PlayerKey));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv failed to open or read the stream. Without this the video area would
    // just stay black: mpv's output is not captured anywhere else.
    listen<string>("player-error", (event) => {
      // Selecting the failed channel again must retry it.
      this.currentFailed = true;
      // A live stream that keeps failing makes mpv retry (loop-playlist=inf),
      // so report at most one failure per interval instead of a toast storm.
      const now = Date.now();
      if (now - this.lastErrorAt < PlayerComponent.ERROR_TOAST_INTERVAL_MS) return;
      this.lastErrorAt = now;
      this.ngZone.run(() => this.reportPlaybackError(event.payload));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv died or its IPC pipe broke and the backend tore the player down; the
    // next play has to build a new one.
    listen("player-crashed", () => {
      this.ngZone.run(() => {
        this.initialized = false;
        this.currentFailed = true;
        this.error.info(this.translate.instant("TOAST.PLAYER_CRASHED"));
        // Nothing left to show in the corner. The full player stays open, so
        // the next channel picked from its list rebuilds mpv.
        if (this.active && this.mini) this.back();
      });
    }).then((unlisten) => this.unlistens.push(unlisten));
  }

  get channels(): Channel[] {
    return this.memory.PlayerChannelList;
  }

  /// The side list after applying the filter input (cached per list + text).
  get visibleChannels(): Channel[] {
    const source = this.memory.PlayerChannelList;
    const text = this.filterText.trim().toLowerCase();
    if (!text) return source;
    const cache = this.filterCache;
    if (cache && cache.source === source && cache.text === text) return cache.result;
    const result = source.filter((c) => c.name?.toLowerCase().includes(text));
    this.filterCache = { source, text, result };
    return result;
  }

  trackById(index: number, channel: Channel) {
    return channel.id ?? index;
  }

  /// The country code shown as a pill in "badge" mode. Cached per name: the
  /// side list asks for every item on each change detection.
  countryCode(name: string | undefined): string | undefined {
    if (this.memory.CountryPrefixMode !== "badge" || !name) return undefined;
    if (!this.countryCodes.has(name)) {
      if (this.countryCodes.size > 5000) this.countryCodes.clear();
      this.countryCodes.set(name, splitCountryPrefix(name).code);
    }
    return this.countryCodes.get(name);
  }

  async open(channel: Channel) {
    const generation = ++this.openGeneration;
    if (this.embeddedUnavailable) {
      await this.fallback(channel);
      return;
    }
    try {
      await this.ensureInitialized();
    } catch (e) {
      if (this.isStale(generation)) return;
      // Embedded player unavailable (e.g. not on Windows): permanently fall
      // back to the classic external mpv window.
      console.error(e);
      this.embeddedUnavailable = true;
      await this.fallback(channel);
      return;
    }
    if (this.isStale(generation)) {
      await this.undoIfClosed();
      return;
    }
    this.setCurrent(channel);
    this.currentFailed = false;
    this.nowPlaying = undefined;
    this.active = true;
    // A channel started from the page beside the mini player opens the full
    // player again.
    this.mini = false;
    this.applyMode();
    const switchSeq = ++this.switchSeq;
    try {
      await this.showNativeWindow();
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
      await this.playChannel(channel);
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
    } catch (e) {
      if (this.isStale(generation)) return;
      if (switchSeq === this.switchSeq) this.currentFailed = true;
      this.error.handleError(e);
    }
    // Wait for *ngIf to render the host element, then align the native window.
    setTimeout(() => {
      this.startBoundsSync();
      // Focus lands in the list, so the keyboard keeps working in the player.
      this.scrollActiveIntoView(true);
    }, 0);
    this.startEpgTimer();
    if (switchSeq === this.switchSeq) this.announce(channel);
  }

  /** Runs player_init at most once at a time; concurrent callers share it. */
  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = invoke("player_init")
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initPromise = undefined;
        });
    }
    return this.initPromise;
  }

  /**
   * Applies the page-level state of the current mode. The full player covers
   * the page: it owns the keyboard, the page behind it is inert and does not
   * scroll. Beside the mini player the page stays fully usable.
   */
  private applyMode() {
    const full = this.active && !this.mini;
    const mini = this.active && this.mini;
    this.memory.PlayerVisible = full;
    this.memory.PlayerMini = mini;
    document.body.classList.toggle(BODY_CLASS, full);
    document.body.classList.toggle(MINI_BODY_CLASS, mini);
    setBackgroundInert(full);
    // Stop the home page behind the overlay from scrolling, so its scrollbar
    // doesn't show at the window edge alongside the channel list's own.
    this.lockBackgroundScroll(full);
  }

  /// Shows the native window, unless it was hidden for a still open modal.
  private async showNativeWindow() {
    if (this.hiddenForModal) return;
    await invoke("player_set_visible", { visible: true });
  }

  private onModalsChanged(open: boolean) {
    this.modalsOpen = open;
    if (!this.active) {
      this.hiddenForModal = false;
      return;
    }
    // Only the mini player hides for a modal (the full player leaves that to
    // hidePlayerWhile). Once hidden, the window comes back when the modals are
    // gone, even if the player grew to the full player meanwhile.
    if (open && this.mini && !this.hiddenForModal) {
      this.hiddenForModal = true;
      invoke("player_set_visible", { visible: false }).catch(() => {});
    } else if (!open && this.hiddenForModal) {
      this.hiddenForModal = false;
      invoke("player_set_visible", { visible: true })
        .then(() => this.syncBounds())
        .catch(() => {});
    }
  }

  /** Continues playback in the small corner window; the app stays usable. */
  minimize() {
    if (!this.active || this.mini || this.fullscreen) return;
    this.mini = true;
    this.applyMode();
    // The modal backdrop covers the player bar, so none should be open here;
    // if one is, hide the window like for a modal opened later.
    if (this.modalsOpen) this.onModalsChanged(true);
    // Wait for the mini layout to render, then align the native window and
    // keep the focus in the player (Escape there closes it).
    setTimeout(() => {
      this.syncBounds();
      this.host.nativeElement.querySelector<HTMLElement>(".mini-expand")?.focus();
    }, 0);
  }

  /** Back from the mini player to the full player. */
  expand() {
    if (!this.active || !this.mini) return;
    this.mini = false;
    this.applyMode();
    setTimeout(() => {
      this.syncBounds();
      // Focus lands in the list, so the keyboard keeps working in the player.
      this.scrollActiveIntoView(true);
    }, 0);
  }

  private isStale(generation: number): boolean {
    return generation !== this.openGeneration;
  }

  /**
   * An open()/switch() that finished after the user already closed the player
   * may have shown the native window or started playback again: undo that.
   * When it was superseded by a newer open() instead, that one takes over.
   */
  private async undoIfClosed() {
    if (this.active || this.openGeneration !== this.closedGeneration) return;
    try {
      await invoke("player_set_visible", { visible: false });
      await invoke("player_stop");
    } catch {
      // best effort
    }
  }

  /**
   * Reports a playback failure. While the player is open a toast is useless:
   * the native video window composites above the WebView, so anything the DOM
   * paints over the video area is invisible. mpv's own OSD is drawn inside
   * that window and is the only surface the user can actually see.
   */
  private reportPlaybackError(message: string) {
    const text = `${this.translate.instant("TOAST.PLAYER_ERROR")}: ${message}`;
    if (this.active) {
      invoke("player_osd", { message: text }).catch(() => {});
    }
    this.error.handleError(message, this.translate.instant("TOAST.PLAYER_ERROR"));
  }

  private async fallback(channel: Channel) {
    try {
      await invoke("play", { channel, record: false, recordPath: null });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async switch(channel: Channel) {
    if (!this.active) return;
    if (channel.id === this.current?.id && !this.currentFailed) {
      this.scrollActiveIntoView(false);
      return;
    }
    const generation = this.openGeneration;
    const seq = ++this.switchSeq;
    const focusInList = this.isFocusInList();
    this.setCurrent(channel);
    this.currentFailed = false;
    this.nowPlaying = undefined;
    this.scrollActiveIntoView(focusInList);
    try {
      await this.playChannel(channel);
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
      invoke("add_last_watched", { id: channel.id }).catch(() => {});
      if (seq === this.switchSeq) this.announce(channel);
    } catch (e) {
      if (this.isStale(generation)) return;
      if (seq === this.switchSeq) this.currentFailed = true;
      this.error.handleError(e);
    }
  }

  /** Next channel of the (filtered) side list, wrapping around. */
  next() {
    const list = this.navigationList();
    if (list.length === 0) return;
    const index = list.findIndex((c) => c.id === this.current?.id);
    this.switch(list[index < 0 ? 0 : (index + 1) % list.length]);
  }

  /** Previous channel of the (filtered) side list, wrapping around. */
  prev() {
    const list = this.navigationList();
    if (list.length === 0) return;
    const index = list.findIndex((c) => c.id === this.current?.id);
    this.switch(list[index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length]);
  }

  /** Back to the previously played channel. */
  last() {
    if (this.previous) this.switch(this.previous);
  }

  /** Escape / back: leave app fullscreen first, otherwise close the player. */
  async escape() {
    if (this.fullscreen) await this.setFullscreen(false);
    else await this.back();
  }

  private navigationList(): Channel[] {
    const visible = this.visibleChannels;
    return visible.length > 0 ? visible : this.channels;
  }

  private handlePlayerKey(key: PlayerKey) {
    switch (key) {
      case "next":
        this.next();
        break;
      case "prev":
        this.prev();
        break;
      case "back":
        // The mini player has no fullscreen to leave: close it.
        if (this.mini) this.back();
        else this.escape();
        break;
      case "last":
        this.last();
        break;
    }
  }

  /**
   * Player keys while the WebView has focus (side list, filter, player bar).
   * Registered on the document before the home page's listener, so
   * stopImmediatePropagation keeps the home page from also reacting.
   * Beside the mini player the keys belong to the page, except Escape while
   * the focus is in the mini player, which closes it.
   */
  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (!this.active || event.defaultPrevented || this.modal.hasOpenModals()) return;
    if (this.mini) {
      if (event.key !== "Escape" || !this.host.nativeElement.contains(document.activeElement)) {
        return;
      }
      this.back();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target as HTMLElement | null;
    const inTextInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    switch (event.key) {
      case "Escape":
      case "BrowserBack":
        if (inTextInput && this.filterText) this.filterText = "";
        else this.escape();
        break;
      case "PageDown":
      case "ArrowDown":
        this.next();
        break;
      case "PageUp":
      case "ArrowUp":
        this.prev();
        break;
      case "Backspace":
        if (inTextInput) return;
        this.last();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private setCurrent(channel: Channel) {
    if (this.current && this.current.id !== channel.id) this.previous = this.current;
    this.current = channel;
  }

  private isFocusInList(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return !!active?.classList.contains("player-list-item");
  }

  /** Keeps the active side-list item visible (and focused if asked). */
  private scrollActiveIntoView(focus: boolean) {
    setTimeout(() => {
      const item = this.playerList?.nativeElement.querySelector<HTMLElement>(
        ".player-list-item.active",
      );
      if (!item) return;
      item.scrollIntoView({ block: "nearest" });
      if (focus) item.focus({ preventScroll: true });
    }, 0);
  }

  /**
   * Shows the channel name (plus now/next when the guide has it) in mpv's
   * OSD, the only surface visible over the video.
   */
  private announce(channel: Channel) {
    this.osd(channel.name ?? "");
    this.loadNowPlaying(channel, true);
  }

  private osd(message: string) {
    if (!this.active || !message) return;
    invoke("player_osd", { message }).catch(() => {});
  }

  private loadNowPlaying(channel: Channel, announce: boolean) {
    this.nowPlayingService
      .getNowPlaying(channel)
      .then((nowPlaying) => {
        if (!this.active || this.current !== channel) return;
        this.nowPlaying = nowPlaying;
        this.updateProgress();
        if (announce && nowPlaying) this.osd(this.osdText(channel, nowPlaying));
      })
      .catch((e) => console.error(e));
  }

  private osdText(channel: Channel, nowPlaying: NowPlaying): string {
    const lines = [
      channel.name ?? "",
      `${this.formatTime(nowPlaying.start_timestamp)}–${this.formatTime(nowPlaying.end_timestamp)}  ${nowPlaying.title}`,
    ];
    if (nowPlaying.next) {
      lines.push(
        `${this.translate.instant("PLAYER.NEXT")}: ${this.formatTime(nowPlaying.next.start_timestamp)}  ${nowPlaying.next.title}`,
      );
    }
    return lines.join("\n");
  }

  formatTime(timestamp: number): string {
    const lang = this.translate.getCurrentLang() || "en";
    try {
      return new Date(timestamp * 1000).toLocaleTimeString(lang, {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return new Date(timestamp * 1000).toLocaleTimeString();
    }
  }

  private updateProgress() {
    const np = this.nowPlaying;
    if (!np) {
      this.nowProgress = 0;
      return;
    }
    const duration = np.end_timestamp - np.start_timestamp;
    const elapsed = Date.now() / 1000 - np.start_timestamp;
    this.nowProgress = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
  }

  private startEpgTimer() {
    if (this.epgTimer !== undefined) return;
    this.epgTimer = setInterval(() => {
      if (!this.active || !this.current) return;
      if (this.nowPlaying && this.nowPlaying.end_timestamp <= Date.now() / 1000) {
        // The programme ended: fetch the one that is on now.
        this.loadNowPlaying(this.current, false);
      } else {
        this.updateProgress();
      }
    }, PlayerComponent.EPG_REFRESH_MS);
  }

  private stopEpgTimer() {
    if (this.epgTimer !== undefined) clearInterval(this.epgTimer);
    this.epgTimer = undefined;
  }

  /**
   * Sends the channel to mpv, rebuilding the player once if it has died. The
   * backend rejects a play on a dead player (and tears its remains down), so
   * without the retry the first click after a crash would be swallowed.
   */
  private async playChannel(channel: Channel) {
    try {
      await invoke("player_play", { channel });
      return;
    } catch (e) {
      console.error(e);
    }
    this.initialized = false;
    await this.ensureInitialized();
    await this.showNativeWindow();
    await invoke("player_play", { channel });
    this.syncBounds();
  }

  async back() {
    // Invalidates any open()/switch() still awaiting the backend.
    this.closedGeneration = ++this.openGeneration;
    this.switchSeq++;
    if (this.fullscreen) await this.setFullscreen(false);
    this.active = false;
    this.mini = false;
    this.hiddenForModal = false;
    this.applyMode();
    this.filterText = "";
    this.nowPlaying = undefined;
    this.stopBoundsSync();
    this.stopEpgTimer();
    try {
      await invoke("player_set_visible", { visible: false });
      await invoke("player_stop");
    } catch {
      // best effort
    }
  }

  async toggleFullscreen() {
    await this.setFullscreen(!this.fullscreen);
  }

  private async setFullscreen(value: boolean) {
    try {
      await getCurrentWindow().setFullscreen(value);
      this.fullscreen = value;
    } catch (e) {
      // Keep the previous state if the OS window couldn't switch, so the layout
      // doesn't pretend to be fullscreen when it isn't.
      this.error.handleError(e);
    }
    // Re-align the native video window after the layout/OS resize settles.
    setTimeout(() => this.syncBounds(), 60);
    setTimeout(() => this.syncBounds(), 250);
    if (!this.fullscreen) setTimeout(() => this.scrollActiveIntoView(false), 60);
  }

  private startBoundsSync() {
    this.syncBounds();
    if (!this.resizeObserver && this.videoHost) {
      this.resizeObserver = new ResizeObserver(() => this.ngZone.run(() => this.syncBounds()));
      this.resizeObserver.observe(this.videoHost.nativeElement);
    }
  }

  private stopBoundsSync() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  @HostListener("window:resize")
  onResize() {
    if (this.active) this.syncBounds();
  }

  /** Locks/unlocks scrolling of the page behind the fixed player overlay. */
  private lockBackgroundScroll(lock: boolean) {
    const value = lock ? "hidden" : "";
    document.documentElement.style.overflow = value;
    document.body.style.overflow = value;
  }

  /** Sends the video host rectangle (physical pixels) to the native window. */
  private syncBounds() {
    const el = this.videoHost?.nativeElement;
    if (!el || !this.active) return;
    const rect = el.getBoundingClientRect();
    // devicePixelRatio (not just OS scale) so the rect stays aligned when the
    // app is zoomed via webview setZoom.
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w <= 0 || h <= 0) return;
    invoke("player_set_bounds", {
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      w,
      h,
    }).catch(() => {});
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.stopBoundsSync();
    this.stopEpgTimer();
    this.unlistens.forEach((unlisten) => unlisten());
    this.lockBackgroundScroll(false);
    document.body.classList.remove(BODY_CLASS, MINI_BODY_CLASS);
    setBackgroundInert(false);
    this.memory.PlayerVisible = false;
    this.memory.PlayerMini = false;
  }
}
