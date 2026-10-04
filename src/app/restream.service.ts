import { Injectable, NgZone } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { ErrorService } from "./error.service";
import { MemoryService } from "./memory.service";
import { PlaybackService } from "./playback.service";
import { RestreamModalComponent } from "./restream-modal/restream-modal.component";

/// idle: nothing runs; starting: ffmpeg is launched but delivers nothing yet;
/// running: the playlist exists, others can watch; stopping: stop requested.
export type RestreamState = "idle" | "starting" | "running" | "stopping";

/// Why the backend ended a restream (event "restream_stopped").
export type RestreamStopReason = "stopped" | "ffmpeg_exited" | "server_failed";

/// Translation of an unexpected end, shown as an error toast.
export const RESTREAM_STOP_MESSAGES: Record<Exclude<RestreamStopReason, "stopped">, string> = {
  ffmpeg_exited: "RESTREAM.STOPPED_FFMPEG",
  server_failed: "RESTREAM.STOPPED_SERVER",
};

/// The address another device opens for `host` (an address of this
/// machine): the local playback URL (restream_url) with that host. Undefined
/// when the URL cannot be parsed.
export function restreamUrlFor(localUrl: string, host: string): string | undefined {
  if (!localUrl || !host) return undefined;
  try {
    const url = new URL(localUrl);
    url.hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return url.toString();
  } catch {
    return undefined;
  }
}

/// A failed start_restream waits this long for its "restream_stopped" event,
/// which explains the failure better than the raw error.
const STOP_EVENT_GRACE_MS = 500;

/**
 * The one restream (the backend runs at most one). It outlives the dialog:
 * the dialog can be hidden while the restream runs on, a status chip in the
 * app shell shows it and reopens the dialog, and an unexpected end is
 * reported wherever the user is.
 */
@Injectable({
  providedIn: "root",
})
export class RestreamService {
  state: RestreamState = "idle";
  /// The re-streamed channel while a restream starts or runs.
  channel?: Channel;
  /// The port the restream server listens on.
  port?: number;
  /// The open dialog, if any.
  private modalRef?: NgbModalRef;
  /// The start_restream call of the current run failed; reported unless the
  /// "restream_stopped" event explains it first.
  private pendingError?: { error: unknown; timer: ReturnType<typeof setTimeout> };
  /// The current run's end was already reported by its event (also true
  /// before the first run: a stray event reports nothing).
  private stopReported = true;
  /// Name of the last re-streamed channel, for an end reported after the
  /// command already returned.
  private lastName = "";
  private run = 0;

  constructor(
    private ngZone: NgZone,
    private modal: NgbModal,
    private error: ErrorService,
    private translate: TranslateService,
    private memory: MemoryService,
    private playback: PlaybackService,
  ) {
    listen<boolean>("restream_started", () => {
      this.ngZone.run(() => {
        if (this.state === "starting") this.state = "running";
      });
    }).catch((e) => console.error(e));
    listen<{ reason?: RestreamStopReason }>("restream_stopped", (event) => {
      this.ngZone.run(() => this.onStopped(event.payload?.reason ?? "stopped"));
    }).catch((e) => console.error(e));
  }

  /// A restream is starting, running or being stopped.
  get active(): boolean {
    return this.state !== "idle";
  }

  /// Opens the dialog for a channel, or for the running restream (the chip's
  /// "Open"). Escape and "Hide" close it; the restream keeps running.
  open(channel?: Channel): NgbModalRef {
    const shown = this.active ? this.channel : (channel ?? this.channel);
    if (this.modalRef) {
      // Only one dialog: a second one would show the same restream twice.
      if (this.modalRef.componentInstance.channel?.id === shown?.id) return this.modalRef;
      this.modalRef.dismiss();
    }
    const modalRef = this.modal.open(RestreamModalComponent, { size: "xl" });
    modalRef.componentInstance.channel = shown;
    modalRef.componentInstance.name = "RestreamModalComponent";
    this.modalRef = modalRef;
    this.memory.ModalRef = modalRef;
    const closed = modalRef.result.catch(() => undefined);
    closed.then(() => {
      if (this.modalRef === modalRef) this.modalRef = undefined;
      if (this.memory.ModalRef === modalRef) this.memory.ModalRef = undefined;
    });
    // Opened from the chip while the player shows: its native video would
    // cover the dialog.
    void this.memory.hidePlayerWhile(closed);
    return modalRef;
  }

  /// Starts re-streaming a channel. Resolves once the restream has ended
  /// (the backend command only returns then).
  async start(channel: Channel, port: number) {
    if (this.active) return;
    const run = ++this.run;
    this.channel = channel;
    this.lastName = channel.name ?? "";
    this.port = port;
    this.state = "starting";
    this.stopReported = false;
    this.clearPendingError();
    try {
      await invoke("start_restream", { channel, port });
    } catch (e) {
      if (!this.stopReported) {
        const timer = setTimeout(() => this.flushPendingError(), STOP_EVENT_GRACE_MS);
        this.pendingError = { error: e, timer };
      }
    }
    if (run === this.run) this.reset();
  }

  async stop() {
    if (this.state !== "starting" && this.state !== "running") return;
    const previous = this.state;
    this.state = "stopping";
    try {
      await invoke("stop_restream");
    } catch (e) {
      this.state = previous;
      this.error.handleError(e);
    }
  }

  /// Plays the running restream in the embedded player, as others see it.
  async watch() {
    if (this.state !== "running" || this.port === undefined) return;
    try {
      const url = await invoke<string>("restream_url", { port: this.port });
      await this.playback.play(
        {
          id: -1,
          name: `${this.channel?.name ?? ""} (Restream)`,
          url,
          media_type: MediaType.livestream,
          favorite: false,
        },
        [],
      );
    } catch (e) {
      this.error.handleError(e);
    }
  }

  private onStopped(reason: RestreamStopReason) {
    if (this.stopReported) return;
    this.stopReported = true;
    const wasStopping = this.state === "stopping";
    if (reason !== "stopped" && !wasStopping) {
      // The event explains the end better than the command's error.
      this.clearPendingError();
      const key = RESTREAM_STOP_MESSAGES[reason];
      this.error.handleError(
        reason,
        this.translate.instant(key ?? "RESTREAM.STOPPED_UNKNOWN", { name: this.lastName }),
      );
    }
    this.reset();
  }

  private reset() {
    this.state = "idle";
    this.channel = undefined;
    this.port = undefined;
  }

  private flushPendingError() {
    const pending = this.pendingError;
    this.pendingError = undefined;
    if (pending) this.error.handleError(pending.error);
  }

  private clearPendingError() {
    if (this.pendingError) clearTimeout(this.pendingError.timer);
    this.pendingError = undefined;
  }
}
