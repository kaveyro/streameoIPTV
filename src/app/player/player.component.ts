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
import { MediaType } from "../models/mediaType";
import { ErrorService } from "../error.service";
import { NowPlaying, NowPlayingService, programmeProgress } from "../now-playing.service";
import { splitCountryPrefix } from "../country-prefix";
import { WatchProgressService } from "../watch-progress.service";

/// Keys the backend forwards while mpv (not the WebView) has keyboard focus,
/// see the `player-key` event. The digits (top row and numpad) come as
/// `digit-0` … `digit-9`, for the channel number entry. "info" shows the
/// channel banner again, "restart" starts a movie over.
type PlayerKey = "next" | "prev" | "back" | "last" | "info" | "restart" | `digit-${number}`;

/// The channel banner mpv draws over the video (`player_osd_banner`).
interface OsdBanner {
  number?: string;
  title: string;
  /// Below the title, e.g. "20:00–20:15 · Tagesschau".
  line?: string;
  /// Dimmed after the line, e.g. "7 min left".
  detail?: string;
  /// Progress bar under the line, 0..1.
  progress?: number;
  /// Last, smaller line.
  footer?: string;
}

/// "1:32:05" / "42:10" for a position in a movie.
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/// What mpv reports about the running stream (`player-stream-info`).
interface StreamInfo {
  width?: number | null;
  height?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  /** Bits per second. */
  bitrate?: number | null;
  fps?: number | null;
}

/// One entry of the stream info in the player bar. `extra` ones are the first
/// to go when the bar gets narrow.
interface StreamBadge {
  text: string;
  extra: boolean;
}

/// Common names of mpv's (ffmpeg's) video codec ids; others are upper-cased.
const VIDEO_CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1",
  mpeg4: "MPEG-4",
};

/// The channel number from the playlist/provider, when it has one.
function channelNumber(channel: Channel): number | undefined {
  const number = (channel as { number?: number | null }).number;
  return typeof number === "number" ? number : undefined;
}

function resolutionLabel(height: number): string {
  if (height >= 2160) return "4K";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${height}p`;
}

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
  /// Pause after the last typed digit before the channel number is taken.
  private static readonly ZAP_TIMEOUT_MS = 1500;
  /// A number this long is taken right away (no provider numbers beyond it).
  private static readonly ZAP_MAX_DIGITS = 5;
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
  /// Digits of the channel number being typed (empty when none).
  zapDigits = "";
  /// Stream info badges of the running stream, see `player-stream-info`.
  streamBadges: StreamBadge[] = [];
  /// The same as one line, for the tooltip.
  streamInfoText = "";
  private zapTimer?: ReturnType<typeof setTimeout>;
  /// False from a channel switch until its play went out: mpv's info about the
  /// previous stream that is still on its way must not show for the new one.
  private streamInfoReady = false;
  /// Channel ids the automatic fallback already played (or started from)
  /// since the user last picked a channel. Never played twice, so it can't loop.
  private fallbackTried = new Set<number>();
  /// No untried alternative was left: report further errors as usual.
  private fallbackExhausted = false;
  /// switchSeq of the fallback lookup in flight: mpv's retries of the failed
  /// stream report errors meanwhile, they must not start a second one.
  private fallbackSeq?: number;
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
    private watchProgress: WatchProgressService,
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
    // The mini player's own window frame: its close button ends playback,
    // a double-click on its caption brings the video back into the app.
    listen("player-popout-close", () => {
      if (this.active && this.mini) this.ngZone.run(() => this.back());
    }).then((unlisten) => this.unlistens.push(unlisten));
    listen("player-popout-dock", () => {
      if (this.active && this.mini) this.ngZone.run(() => this.expand());
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv reports a double-click / `f` key (rebound to a script-message) here;
    // toggle app-level fullscreen since mpv can't fullscreen an embedded child.
    // The mini player grows back to the full player instead.
    listen("player-toggle-fullscreen", () => {
      if (!this.active) return;
      this.ngZone.run(() => (this.mini ? this.expand() : this.toggleFullscreen()));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // Channel keys pressed while mpv has keyboard focus (the WebView gets no
    // key events then): PgDn/PgUp/Esc/Backspace and the digits.
    listen<string>("player-key", (event) => {
      if (!this.active) return;
      this.ngZone.run(() => this.handlePlayerKey(event.payload as PlayerKey));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // Resolution, codecs, bitrate and frame rate for the player bar.
    listen<StreamInfo>("player-stream-info", (event) => {
      if (!this.active || !this.streamInfoReady) return;
      this.ngZone.run(() => this.setStreamInfo(event.payload));
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv failed to open or read the stream. Without this the video area would
    // just stay black: mpv's output is not captured anywhere else.
    listen<string>("player-error", (event) => {
      // Selecting the failed channel again must retry it.
      this.currentFailed = true;
      this.ngZone.run(() => this.onPlaybackError(event.payload));
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
    // The channel already playing in the mini player: just grow back, a new
    // player_play would restart the stream.
    if (this.active && this.mini && channel.id === this.current?.id && !this.currentFailed) {
      this.expand();
      return;
    }
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
    // A channel started from the app while the mini player floats plays in
    // the full player again: the video goes back into the app first.
    if (this.mini) {
      await this.setPopout(false);
      this.mini = false;
      if (this.isStale(generation)) return;
    }
    this.setCurrent(channel);
    this.currentFailed = false;
    this.nowPlaying = undefined;
    this.clearStreamInfo();
    this.cancelZap();
    this.resetFallback();
    this.active = true;
    this.applyMode();
    const switchSeq = ++this.switchSeq;
    let resumed: number | null = null;
    try {
      await invoke("player_set_visible", { visible: true });
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
      resumed = await this.playChannel(channel);
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
      if (switchSeq === this.switchSeq) this.streamInfoReady = true;
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
    if (switchSeq === this.switchSeq) this.announce(channel, true, resumed);
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
   * scroll. While the mini player floats the app stays fully usable; only a
   * small bar with the way back stays in the app.
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

  /**
   * Moves the video into its own always-on-top window, or back into the app.
   * The backend re-parents mpv's host window, so playback goes on; the user
   * drags and resizes the floating window, and it stays up when the app is
   * minimized. With `popout` it also (re)sets the window title.
   */
  private async setPopout(popout: boolean) {
    try {
      await invoke("player_set_popout", {
        popout,
        title: popout ? (this.current?.name ?? "") : null,
      });
    } catch (e) {
      console.error(e);
    }
  }

  /** Continues playback in a small floating window; the app stays usable. */
  async minimize() {
    if (!this.active || this.mini || this.fullscreen) return;
    this.mini = true;
    this.applyMode();
    await this.setPopout(true);
    // Keep the focus in the app's mini bar (Escape there closes it).
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLElement>(".mini-expand")?.focus();
    }, 0);
  }

  /** Back from the mini player to the full player. */
  async expand() {
    if (!this.active || !this.mini) return;
    await this.setPopout(false);
    // Closed or taken over by open() meanwhile.
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
      invoke("player_osd", { message: text }).catch(() => undefined);
    }
    this.error.handleError(message, this.translate.instant("TOAST.PLAYER_ERROR"));
  }

  /**
   * A `player-error`: a live channel falls back to another feed of the same
   * channel (SD/HD/backup) when the setting allows it; the error is reported
   * only when none is left.
   */
  private async onPlaybackError(message: string) {
    const failed = this.current;
    if (
      this.active &&
      failed &&
      this.memory.AutoFallback &&
      failed.media_type === MediaType.livestream &&
      !this.fallbackExhausted
    ) {
      // mpv keeps retrying the failed stream: its further errors wait for the
      // lookup already running for this switch.
      if (this.fallbackSeq === this.switchSeq) return;
      const outcome = await this.fallBackFrom(failed);
      if (outcome !== "none") return;
    }
    // A live stream that keeps failing makes mpv retry (loop-playlist=inf),
    // so report at most one failure per interval instead of a toast storm.
    const now = Date.now();
    if (now - this.lastErrorAt < PlayerComponent.ERROR_TOAST_INTERVAL_MS) return;
    this.lastErrorAt = now;
    this.reportPlaybackError(message);
  }

  /**
   * Switches to the best alternative of `failed` not tried since the user's
   * last pick. "stale" when the user moved on meanwhile (the error belonged
   * to a channel that is gone), "none" when nothing is left to try.
   */
  private async fallBackFrom(failed: Channel): Promise<"switched" | "none" | "stale"> {
    const seq = this.switchSeq;
    const generation = this.openGeneration;
    this.fallbackSeq = seq;
    if (failed.id !== undefined) this.fallbackTried.add(failed.id);
    let alternatives: Channel[] = [];
    try {
      alternatives = await invoke<Channel[]>("get_alternative_streams", {
        channel: failed,
        showLocked: this.memory.ShowLocked,
      });
    } catch (e) {
      console.error(e);
    } finally {
      if (this.fallbackSeq === seq) this.fallbackSeq = undefined;
    }
    if (!this.active || this.isStale(generation) || seq !== this.switchSeq) return "stale";
    const next = alternatives.find((c) => c.id !== undefined && !this.fallbackTried.has(c.id));
    if (!next) {
      this.fallbackExhausted = true;
      return "none";
    }
    this.fallbackTried.add(next.id!);
    this.osd(this.translate.instant("PLAYER.FALLBACK_SWITCHING", { name: next.name ?? "" }));
    this.switch(next, true);
    return "switched";
  }

  /** A channel the user picked: the fallback may try every feed again. */
  private resetFallback() {
    this.fallbackTried.clear();
    this.fallbackExhausted = false;
    this.fallbackSeq = undefined;
  }

  private async fallback(channel: Channel) {
    try {
      await invoke("play", { channel, record: false, recordPath: null });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  /**
   * Plays another channel in the open player. `fallback`: started by the
   * automatic fallback, not by the user, so the feeds it already tried stay
   * tried and its own OSD message stays up instead of the channel name.
   */
  async switch(channel: Channel, fallback = false) {
    if (!this.active) return;
    if (channel.id === this.current?.id && !this.currentFailed) {
      this.scrollActiveIntoView(false);
      return;
    }
    const generation = this.openGeneration;
    const seq = ++this.switchSeq;
    const focusInList = this.isFocusInList();
    if (!fallback) this.resetFallback();
    this.setCurrent(channel);
    this.currentFailed = false;
    this.nowPlaying = undefined;
    this.clearStreamInfo();
    this.scrollActiveIntoView(focusInList);
    try {
      const resumed = await this.playChannel(channel);
      if (this.isStale(generation)) {
        await this.undoIfClosed();
        return;
      }
      if (seq === this.switchSeq) this.streamInfoReady = true;
      invoke("add_last_watched", { id: channel.id }).catch(() => undefined);
      if (seq === this.switchSeq) this.announce(channel, !fallback, resumed);
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
    if (key.startsWith("digit-")) {
      this.typeDigit(key.slice("digit-".length));
      return;
    }
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
      case "info":
        this.showInfo();
        break;
      case "restart":
        this.restart();
        break;
    }
  }

  /** The channel banner again (the `i` key): name, now and next. */
  showInfo() {
    const channel = this.current;
    if (!this.active || !channel) return;
    if (channel.media_type !== MediaType.livestream) {
      this.banner({ title: channel.name ?? "" });
    } else if (this.nowPlaying) {
      this.banner(this.liveBanner(channel, this.nowPlaying));
    } else {
      this.banner({ number: this.numberText(channel), title: channel.name ?? "" });
    }
  }

  /** Starts the movie or episode over (the Home key) and forgets where it was left. */
  async restart() {
    const channel = this.current;
    if (!this.active || !channel || channel.media_type === MediaType.livestream) return;
    try {
      await invoke("player_restart");
      this.osd(this.translate.instant("PLAYER.RESTARTED"));
      await this.watchProgress.clear(channel);
    } catch (e) {
      console.error(e);
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
    // Channel number entry (top row and numpad give the same `key`).
    if (!inTextInput && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (/^[0-9]$/.test(event.key)) {
        if (!event.repeat) this.typeDigit(event.key);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "Enter" && this.zapDigits) {
        this.commitZap();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "i" || event.key === "I") {
        this.showInfo();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "Home" && this.current?.media_type !== MediaType.livestream) {
        this.restart();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
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

  /**
   * One digit of a channel number. The typed number shows in mpv's OSD (the
   * only surface over the video) and in the player bar; it is taken after a
   * pause, on Enter or once it is as long as a number gets.
   */
  private typeDigit(digit: string) {
    if (!this.active || !/^[0-9]$/.test(digit)) return;
    if (this.zapTimer !== undefined) clearTimeout(this.zapTimer);
    this.zapTimer = undefined;
    this.zapDigits += digit;
    if (this.zapDigits.length >= PlayerComponent.ZAP_MAX_DIGITS) {
      this.commitZap();
      return;
    }
    this.osd(`${this.zapDigits}_`);
    this.zapTimer = setTimeout(() => this.commitZap(), PlayerComponent.ZAP_TIMEOUT_MS);
  }

  private cancelZap() {
    if (this.zapTimer !== undefined) clearTimeout(this.zapTimer);
    this.zapTimer = undefined;
    this.zapDigits = "";
  }

  /** Switches to the channel with the typed number, if there is one. */
  private async commitZap() {
    const digits = this.zapDigits;
    this.cancelZap();
    if (!digits || !this.active) return;
    const number = parseInt(digits, 10);
    const generation = this.openGeneration;
    const seq = this.switchSeq;
    const channel = this.channelByNumber(number) ?? (await this.lookUpNumber(number));
    // The user moved on (or closed the player) while the backend answered.
    if (this.isStale(generation) || seq !== this.switchSeq || !this.active) return;
    if (!channel) {
      this.osd(this.translate.instant("PLAYER.ZAP_UNKNOWN", { number }));
      return;
    }
    if (channel.id === this.current?.id && !this.currentFailed) {
      // Already on it: replace the typed number with the banner.
      this.showInfo();
      this.scrollActiveIntoView(false);
      return;
    }
    this.switch(channel);
  }

  /**
   * The channel of the player's list with that number. A list without any
   * numbers (most M3U playlists) is numbered by its order, starting at 1.
   */
  /**
   * The numbered channel from the backend, for a number beyond the channels
   * the page has loaded so far (it loads them page by page). Only when the
   * list is numbered: otherwise the number is a position in it.
   */
  private async lookUpNumber(number: number): Promise<Channel | undefined> {
    if (!this.channels.some((c) => channelNumber(c) !== undefined)) return undefined;
    try {
      return (
        (await invoke<Channel | null>("get_channel_by_number", {
          sourceIds: Array.from(this.memory.Sources.keys()),
          number,
          showLocked: this.memory.ShowLocked,
        })) ?? undefined
      );
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  private channelByNumber(number: number): Channel | undefined {
    const list = this.channels;
    if (list.some((c) => channelNumber(c) !== undefined)) {
      return list.find((c) => channelNumber(c) === number);
    }
    return number >= 1 ? list[number - 1] : undefined;
  }

  /** Drops the stream info until mpv reports the new stream. */
  private clearStreamInfo() {
    this.streamInfoReady = false;
    this.streamBadges = [];
    this.streamInfoText = "";
  }

  private setStreamInfo(info: StreamInfo) {
    const badges: StreamBadge[] = [];
    if (info.height) badges.push({ text: resolutionLabel(info.height), extra: false });
    if (info.video_codec)
      badges.push({ text: this.videoCodecName(info.video_codec), extra: false });
    if (info.audio_codec) badges.push({ text: info.audio_codec.toUpperCase(), extra: false });
    if (info.bitrate) {
      const value = this.formatNumber(info.bitrate / 1_000_000, 1, 1);
      badges.push({ text: this.translate.instant("PLAYER.BITRATE_MBITS", { value }), extra: true });
    }
    if (info.fps) {
      const value = this.formatNumber(info.fps, 0, 2);
      badges.push({ text: this.translate.instant("PLAYER.FPS_VALUE", { value }), extra: true });
    }
    this.streamBadges = badges;
    this.streamInfoText = badges.map((b) => b.text).join(" · ");
  }

  private videoCodecName(codec: string): string {
    return VIDEO_CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase();
  }

  private formatNumber(value: number, minDigits: number, maxDigits: number): string {
    const options = { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits };
    try {
      return value.toLocaleString(this.translate.getCurrentLang() || "en", options);
    } catch {
      return value.toLocaleString(undefined, options);
    }
  }

  private setCurrent(channel: Channel) {
    if (this.current && this.current.id !== channel.id) this.previous = this.current;
    this.current = channel;
    // mpv keys switch channels in the floating window too: keep its title.
    if (this.active && this.mini) this.setPopout(true);
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
   * Shows the channel banner (number, name, now/next when the guide has it)
   * over the video; mpv draws it, the only surface visible there. Without
   * `showName` a message already up (the fallback's) stays until now/next
   * arrives. A movie picked up where it was left says so.
   */
  private announce(channel: Channel, showName = true, resumed?: number | null) {
    if (channel.media_type !== MediaType.livestream) {
      this.banner(this.movieBanner(channel, resumed ?? undefined));
      return;
    }
    if (showName) this.banner({ number: this.numberText(channel), title: channel.name ?? "" });
    this.loadNowPlaying(channel, true);
  }

  private movieBanner(channel: Channel, resumed?: number): OsdBanner {
    const banner: OsdBanner = { title: channel.name ?? "" };
    if (resumed !== undefined && resumed > 0) {
      banner.line = this.translate.instant("PLAYER.RESUMED_AT", { time: formatDuration(resumed) });
      const duration = channel.watch_duration;
      if (duration && duration > 0) {
        banner.detail = `/ ${formatDuration(duration)}`;
        banner.progress = Math.min(1, resumed / duration);
      }
      banner.footer = this.translate.instant("PLAYER.RESTART_HINT");
    }
    return banner;
  }

  private liveBanner(channel: Channel, nowPlaying: NowPlaying): OsdBanner {
    const minutes = Math.max(0, Math.ceil((nowPlaying.end_timestamp - Date.now() / 1000) / 60));
    const banner: OsdBanner = {
      number: this.numberText(channel),
      title: channel.name ?? "",
      line: `${this.formatTime(nowPlaying.start_timestamp)}–${this.formatTime(nowPlaying.end_timestamp)} · ${nowPlaying.title}`,
      detail: this.translate.instant("PLAYER.MIN_LEFT", { minutes }),
      progress: programmeProgress(nowPlaying) / 100,
    };
    if (nowPlaying.next) {
      banner.footer = `${this.translate.instant("PLAYER.NEXT")}  ${this.formatTime(nowPlaying.next.start_timestamp)} · ${nowPlaying.next.title}`;
    }
    return banner;
  }

  /** The channel's number for the banner: the provider's, or its place in an unnumbered list. */
  private numberText(channel: Channel): string | undefined {
    const number = channelNumber(channel);
    if (number !== undefined) return number.toString();
    const list = this.channels;
    if (list.some((c) => channelNumber(c) !== undefined)) return undefined;
    const index = list.findIndex((c) => c.id === channel.id);
    return index >= 0 ? (index + 1).toString() : undefined;
  }

  private banner(banner: OsdBanner) {
    if (!this.active || !banner.title) return;
    invoke("player_osd_banner", { banner }).catch(() => undefined);
  }

  private osd(message: string) {
    if (!this.active || !message) return;
    invoke("player_osd", { message }).catch(() => undefined);
  }

  private loadNowPlaying(channel: Channel, announce: boolean) {
    this.nowPlayingService
      .getNowPlaying(channel)
      .then((nowPlaying) => {
        if (!this.active || this.current !== channel) return;
        this.nowPlaying = nowPlaying;
        this.updateProgress();
        if (announce && nowPlaying) this.banner(this.liveBanner(channel, nowPlaying));
      })
      .catch((e) => console.error(e));
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
  private async playChannel(channel: Channel): Promise<number | null> {
    try {
      // Where a movie was picked up again, if it was.
      return await invoke<number | null>("player_play", { channel });
    } catch (e) {
      console.error(e);
    }
    this.initialized = false;
    await this.ensureInitialized();
    await invoke("player_set_visible", { visible: true });
    const resumed = await invoke<number | null>("player_play", { channel });
    this.syncBounds();
    return resumed;
  }

  async back() {
    // Invalidates any open()/switch() still awaiting the backend.
    this.closedGeneration = ++this.openGeneration;
    this.switchSeq++;
    if (this.fullscreen) await this.setFullscreen(false);
    // Closing the mini player removes the focused button with it: hand the
    // focus to the page instead of dropping it on <body>.
    const focusToPage = this.mini && this.host.nativeElement.contains(document.activeElement);
    this.active = false;
    this.mini = false;
    this.applyMode();
    if (focusToPage) {
      const main = document.querySelector<HTMLElement>("main");
      if (main) {
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }
    }
    this.filterText = "";
    this.nowPlaying = undefined;
    this.clearStreamInfo();
    this.cancelZap();
    this.resetFallback();
    this.stopBoundsSync();
    this.stopEpgTimer();
    try {
      // Back into the app first (a no-op when it is there), so the next open
      // finds the video where the page expects it.
      await invoke("player_set_popout", { popout: false, title: null });
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
    }).catch(() => undefined);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.cancelZap();
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
