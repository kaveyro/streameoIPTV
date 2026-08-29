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
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { ErrorService } from "../error.service";

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
  templateUrl: "./player.component.html",
  styleUrl: "./player.component.css",
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  /// Minimum gap between two playback-failure toasts.
  private static readonly ERROR_TOAST_INTERVAL_MS = 5000;
  active = false;
  current?: Channel;
  fullscreen = false;
  private initialized = false;
  private embeddedUnavailable = false;
  private resizeObserver?: ResizeObserver;
  private subscriptions: Subscription[] = [];
  private unlistens: UnlistenFn[] = [];
  private lastErrorAt = 0;
  @ViewChild("videoHost") videoHost?: ElementRef<HTMLDivElement>;

  constructor(
    public memory: MemoryService,
    private ngZone: NgZone,
    private error: ErrorService,
    private translate: TranslateService,
  ) {}

  ngAfterViewInit(): void {
    this.subscriptions.push(this.memory.PlayerOpen.subscribe((ch) => this.open(ch)));
    // mpv reports a double-click / `f` key (rebound to a script-message) here;
    // toggle app-level fullscreen since mpv can't fullscreen an embedded child.
    listen("player-toggle-fullscreen", () => {
      if (this.active) this.ngZone.run(() => this.toggleFullscreen());
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv failed to open or read the stream. Without this the video area would
    // just stay black: mpv's output is not captured anywhere else.
    listen<string>("player-error", (event) => {
      // A live stream that keeps failing makes mpv retry (loop-playlist=inf),
      // so report at most one failure per interval instead of a toast storm.
      const now = Date.now();
      if (now - this.lastErrorAt < PlayerComponent.ERROR_TOAST_INTERVAL_MS) return;
      this.lastErrorAt = now;
      this.ngZone.run(() =>
        this.error.handleError(event.payload, this.translate.instant("TOAST.PLAYER_ERROR")),
      );
    }).then((unlisten) => this.unlistens.push(unlisten));
    // mpv died or its IPC pipe broke and the backend tore the player down; the
    // next play has to build a new one.
    listen("player-crashed", () => {
      this.ngZone.run(() => {
        this.initialized = false;
        this.error.info(this.translate.instant("TOAST.PLAYER_CRASHED"));
      });
    }).then((unlisten) => this.unlistens.push(unlisten));
  }

  get channels(): Channel[] {
    return this.memory.PlayerChannelList;
  }

  async open(channel: Channel) {
    if (this.embeddedUnavailable) {
      await this.fallback(channel);
      return;
    }
    try {
      if (!this.initialized) {
        await invoke("player_init");
        this.initialized = true;
      }
    } catch (e) {
      // Embedded player unavailable (e.g. not on Windows): permanently fall
      // back to the classic external mpv window.
      this.embeddedUnavailable = true;
      await this.fallback(channel);
      return;
    }
    this.current = channel;
    this.active = true;
    this.memory.PlayerVisible = true;
    // Stop the home page behind the overlay from scrolling, so its scrollbar
    // doesn't show at the window edge alongside the channel list's own.
    this.lockBackgroundScroll(true);
    try {
      await invoke("player_set_visible", { visible: true });
      await this.playChannel(channel);
    } catch (e) {
      this.error.handleError(e);
    }
    // Wait for *ngIf to render the host element, then align the native window.
    setTimeout(() => this.startBoundsSync(), 0);
  }

  private async fallback(channel: Channel) {
    try {
      await invoke("play", { channel, record: false, recordPath: null });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async switch(channel: Channel) {
    if (channel.id === this.current?.id) return;
    this.current = channel;
    try {
      await this.playChannel(channel);
      invoke("add_last_watched", { id: channel.id }).catch(() => {});
    } catch (e) {
      this.error.handleError(e);
    }
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
    await invoke("player_init");
    this.initialized = true;
    await invoke("player_set_visible", { visible: true });
    await invoke("player_play", { channel });
    this.syncBounds();
  }

  async back() {
    if (this.fullscreen) await this.setFullscreen(false);
    this.active = false;
    this.memory.PlayerVisible = false;
    this.lockBackgroundScroll(false);
    this.stopBoundsSync();
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
    this.unlistens.forEach((unlisten) => unlisten());
    this.lockBackgroundScroll(false);
  }
}
