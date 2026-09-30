import { Component, OnDestroy, OnInit } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { TranslateService } from "@ngx-translate/core";
import { ErrorService } from "../error.service";
import { ConfirmService } from "../confirm.service";
import { PlaybackService } from "../playback.service";
import { MemoryService } from "../memory.service";
import { RecordingStatus, ScheduledRecording } from "../models/scheduledRecording";
import { RecordingFile } from "../models/recordingFile";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { EPG_ALERT_MIN_LENGTH, EpgAlert, EpgAlertAction, findEpgAlert } from "../models/epgAlert";
import { formatFileSize, uiLocale } from "../utils";

/**
 * The recordings view of the home page: the recording schedule (pending,
 * running and finished scheduled recordings), the saved guide searches that
 * record or remind automatically, and the finished files in the recording
 * folder.
 *
 * "Open folder" goes through a backend command: the shell plugin's scope
 * only opens web links, and the command can only open the recording folder.
 */
@Component({
  standalone: false,
  selector: "app-recordings",
  templateUrl: "./recordings.component.html",
  styleUrl: "./recordings.component.css",
})
export class RecordingsComponent implements OnInit, OnDestroy {
  /// The schedule and the folder are reloaded this often while the view is shown.
  static readonly REFRESH_MS = 30 * 1000;
  readonly statusEnum = RecordingStatus;
  readonly alertMinLength = EPG_ALERT_MIN_LENGTH;
  schedule: ScheduledRecording[] = [];
  files: RecordingFile[] = [];
  folder?: string;
  scheduleLoaded = false;
  filesLoaded = false;
  clearing = false;
  alerts: EpgAlert[] = [];
  alertsLoaded = false;
  /// The "add" form.
  alertQuery = "";
  alertAction: EpgAlertAction = "record";
  /// Validation messages show after the first attempt to add.
  alertTouched = false;
  addingAlert = false;
  /// Rows with an action in progress ("s<id>" / "a<id>" / "f<path>").
  busy = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private cachedFormats?: { dateTime: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
  private formatLocale?: string;

  constructor(
    private error: ErrorService,
    private translate: TranslateService,
    private confirmService: ConfirmService,
    private playback: PlaybackService,
    public memory: MemoryService,
  ) {}

  ngOnInit(): void {
    this.refresh(false);
    this.loadAlerts();
    this.loadFolder();
    this.timer = setInterval(() => {
      // Nothing to show while the window is hidden (tray).
      if (!document.hidden) this.refresh(true);
    }, RecordingsComponent.REFRESH_MS);
  }

  ngOnDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reloads both lists; `silent` (periodic refresh) does not report errors. */
  async refresh(silent: boolean) {
    await Promise.all([this.loadSchedule(silent), this.loadFiles(silent)]);
  }

  async loadSchedule(silent = false) {
    try {
      this.schedule = await invoke<ScheduledRecording[]>("get_recording_schedule");
    } catch (e) {
      if (!silent)
        this.error.handleError(e, this.translate.instant("TOAST.RECORDINGS_LOAD_FAILED"));
    } finally {
      this.scheduleLoaded = true;
    }
  }

  async loadFiles(silent = false) {
    try {
      this.files = await invoke<RecordingFile[]>("get_recording_files");
    } catch (e) {
      if (!silent)
        this.error.handleError(e, this.translate.instant("RECORDINGS.FILES_LOAD_FAILED"));
    } finally {
      this.filesLoaded = true;
    }
  }

  private async loadFolder() {
    try {
      this.folder = await invoke<string>("get_recording_folder");
    } catch (e) {
      console.error(e);
    }
  }

  async loadAlerts(silent = false) {
    try {
      this.alerts = (await invoke<EpgAlert[]>("get_epg_alerts")) ?? [];
    } catch (e) {
      if (!silent)
        this.error.handleError(e, this.translate.instant("RECORDINGS.ALERTS_LOAD_FAILED"));
    } finally {
      this.alertsLoaded = true;
    }
  }

  canCancel(recording: ScheduledRecording): boolean {
    return (
      recording.status === RecordingStatus.Pending || recording.status === RecordingStatus.Recording
    );
  }

  hasFinished(): boolean {
    return this.schedule.some((r) => !this.canCancel(r));
  }

  statusKey(status: RecordingStatus): string {
    switch (status) {
      case RecordingStatus.Recording:
        return "RECORDING.STATUS_RECORDING";
      case RecordingStatus.Done:
        return "RECORDING.STATUS_DONE";
      case RecordingStatus.Failed:
        return "RECORDING.STATUS_FAILED";
      default:
        return "RECORDING.STATUS_PENDING";
    }
  }

  recordingTitle(recording: ScheduledRecording): string {
    return (
      recording.title ||
      recording.channel_name ||
      this.translate.instant("RECORDINGS.UNKNOWN_CHANNEL")
    );
  }

  private formats(): { dateTime: Intl.DateTimeFormat; time: Intl.DateTimeFormat } {
    const locale = uiLocale(this.translate);
    if (!this.cachedFormats || locale !== this.formatLocale) {
      this.formatLocale = locale;
      const create = (lang?: string) => ({
        dateTime: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }),
        time: new Intl.DateTimeFormat(lang, { timeStyle: "short" }),
      });
      try {
        this.cachedFormats = create(locale);
      } catch {
        this.cachedFormats = create(undefined);
      }
    }
    return this.cachedFormats;
  }

  /** "12 Mar 2026, 20:15 – 21:00" in the UI language. */
  formatRange(recording: ScheduledRecording): string {
    const { dateTime, time } = this.formats();
    return `${dateTime.format(recording.start_timestamp * 1000)} – ${time.format(
      recording.end_timestamp * 1000,
    )}`;
  }

  formatDate(unixSeconds: number): string {
    return this.formats().dateTime.format(unixSeconds * 1000);
  }

  formatSize(bytes: number): string {
    return formatFileSize(bytes, uiLocale(this.translate));
  }

  trackRecording(_: number, recording: ScheduledRecording) {
    return recording.id;
  }

  trackFile(_: number, file: RecordingFile) {
    return file.path;
  }

  trackAlert(_: number, alert: EpgAlert) {
    return alert.id;
  }

  // ----------------------------------------------------------------- alerts

  /// Why the form cannot be sent, as a translation key (undefined: it can).
  alertProblem(): string | undefined {
    const query = this.alertQuery.trim();
    if (query.length < EPG_ALERT_MIN_LENGTH) return "RECORDINGS.ALERT_TOO_SHORT";
    if (findEpgAlert(this.alerts, query, this.alertAction)) return "RECORDINGS.ALERT_EXISTS";
    // Reminders are desktop notifications from the tray process.
    if (this.alertAction === "remind" && !this.memory.trayEnabled) return "GUIDE.ALERT_NEEDS_TRAY";
    return undefined;
  }

  async addAlert() {
    if (this.addingAlert) return;
    this.alertTouched = true;
    if (this.alertProblem()) return;
    const query = this.alertQuery.trim();
    const action = this.alertAction;
    this.addingAlert = true;
    try {
      await invoke<number>("add_epg_alert", { query, action });
      this.error.success(
        this.translate.instant(
          action === "remind" ? "GUIDE.ALERT_REMIND_ADDED" : "GUIDE.ALERT_RECORD_ADDED",
          { query },
        ),
      );
      this.alertQuery = "";
      this.alertTouched = false;
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.addingAlert = false;
    }
    // A recording alert has scheduled the matching programmes right away.
    await Promise.all([this.loadAlerts(), this.loadSchedule()]);
  }

  async deleteAlert(alert: EpgAlert) {
    const key = `a${alert.id}`;
    if (this.busy.has(key)) return;
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.DELETE_ALERT_TITLE",
      messages: [
        alert.action === "remind"
          ? "CONFIRM.DELETE_ALERT_REMIND_BODY"
          : "CONFIRM.DELETE_ALERT_RECORD_BODY",
        "CONFIRM.DELETE_ALERT_KEEP",
      ],
      confirmLabel: "MODAL.DELETE",
      params: { query: alert.query },
    });
    if (!confirmed) return;
    this.busy.add(key);
    try {
      await invoke("delete_epg_alert", { id: alert.id });
      this.error.success(this.translate.instant("GUIDE.ALERT_REMOVED", { query: alert.query }));
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.busy.delete(key);
    }
    await this.loadAlerts();
  }

  async cancel(recording: ScheduledRecording) {
    const key = `s${recording.id}`;
    if (this.busy.has(key)) return;
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.CANCEL_RECORDING_TITLE",
      messages: [
        recording.status === RecordingStatus.Recording
          ? "CONFIRM.STOP_RECORDING_BODY"
          : "CONFIRM.CANCEL_RECORDING_BODY",
      ],
      confirmLabel: "RECORDINGS.CANCEL",
      params: { title: this.recordingTitle(recording) },
    });
    if (!confirmed) return;
    this.busy.add(key);
    try {
      await invoke("cancel_scheduled_recording", { id: recording.id });
      this.error.success(this.translate.instant("TOAST.RECORDING_CANCELLED"));
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.RECORDING_CANCEL_FAILED"));
    } finally {
      this.busy.delete(key);
    }
    await this.loadSchedule();
  }

  async clearFinished() {
    if (this.clearing) return;
    this.clearing = true;
    try {
      await invoke("clear_finished_recordings");
      this.error.success(this.translate.instant("RECORDINGS.CLEARED"));
    } catch (e) {
      this.error.handleError(e, this.translate.instant("RECORDINGS.CLEAR_FAILED"));
    } finally {
      this.clearing = false;
    }
    await this.loadSchedule();
  }

  /** Plays a file through the same path as the channel tiles. */
  async play(file: RecordingFile) {
    const channel: Channel = {
      id: -1,
      name: file.name,
      url: file.path,
      media_type: MediaType.movie,
      favorite: false,
    };
    try {
      await this.playback.play(channel);
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async deleteFile(file: RecordingFile) {
    const key = `f${file.path}`;
    if (this.busy.has(key)) return;
    const confirmed = await this.confirmService.confirm({
      title: "CONFIRM.DELETE_RECORDING_TITLE",
      messages: ["CONFIRM.DELETE_RECORDING_BODY"],
      confirmLabel: "MODAL.DELETE",
      params: { name: file.name },
    });
    if (!confirmed) return;
    this.busy.add(key);
    try {
      await invoke("delete_recording_file", { path: file.path });
      this.error.success(this.translate.instant("RECORDINGS.FILE_DELETED", { name: file.name }));
    } catch (e) {
      this.error.handleError(e, this.translate.instant("RECORDINGS.FILE_DELETE_FAILED"));
    } finally {
      this.busy.delete(key);
    }
    await this.loadFiles();
  }

  async openFolder() {
    try {
      await invoke("open_recording_folder");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async copyFolder() {
    if (!this.folder) return;
    try {
      await writeText(this.folder);
      this.error.success(this.translate.instant("RECORDINGS.PATH_COPIED"));
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
