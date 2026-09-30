import {
  Component,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Output,
  AfterViewInit,
} from "@angular/core";
import { EPG } from "../../models/epg";
import { MemoryService } from "../../memory.service";
import { invoke } from "@tauri-apps/api/core";
import { EPGNotify } from "../../models/epgNotify";
import { ErrorService } from "../../error.service";
import { Channel } from "../../models/channel";
import { MediaType } from "../../models/mediaType";
import { DownloadService } from "../../download.service";
import { Subscription, take } from "rxjs";
import { Download } from "../../models/download";
import { save } from "@tauri-apps/plugin-dialog";
import { getDateFormatted, getExtension, sanitizeFileName } from "../../utils";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-epg-modal-item",
  standalone: false,
  templateUrl: "./epg-modal-item.component.html",
  styleUrl: "./epg-modal-item.component.css",
})
export class EpgModalItemComponent implements OnDestroy, AfterViewInit {
  private static nextUid = 0;
  /** Unique per instance: SVG ids are document-global. */
  readonly gradientId = `epg-dl-progress-${EpgModalItemComponent.nextUid++}`;
  constructor(
    public memory: MemoryService,
    private error: ErrorService,
    private download: DownloadService,
    private ngZone: NgZone,
    private translate: TranslateService,
  ) {}
  @Input()
  epg?: EPG;
  @Input()
  name?: string;
  @Input()
  sourceId?: number;
  @Input()
  channelId?: number;
  @Input()
  scheduledRecordingId?: number;
  @Output()
  scheduleChanged = new EventEmitter<void>();
  playing = false;
  progress = 0;
  loadingSchedule = false;
  subscriptions: Subscription[] = [];

  ngAfterViewInit(): void {
    const download = this.download.Downloads.get(this.getDownloadId());
    if (download) {
      this.downloadSubscribe(download);
    }
  }

  notificationOn(): boolean {
    return this.memory.Watched_epgs.has(this.epg!.epg_id);
  }

  async toggleNotification() {
    if (this.memory.LoadingNotification || !this.memory.trayEnabled) return;
    this.memory.LoadingNotification = true;
    try {
      if (!this.notificationOn()) {
        try {
          await invoke("add_epg", { epg: this.epg_to_epgNotify(this.epg!) });
          this.error.success(this.translate.instant("TOAST.NOTIFICATION_ADDED"));
        } catch (e) {
          this.error.handleError(e);
        }
      } else {
        try {
          await invoke("remove_epg", { epgId: this.epg?.epg_id });
          this.error.success(this.translate.instant("TOAST.NOTIFICATION_REMOVED"));
        } catch (e) {
          this.error.handleError(e);
        }
      }
      await this.memory.get_epg_ids();
    } catch (e) {
      // A failed get_epg_ids must not leave every bell locked.
      this.error.handleError(e);
    } finally {
      this.memory.LoadingNotification = false;
    }
  }

  epg_to_epgNotify(epg: EPG): EPGNotify {
    return {
      channel_name: this.name!,
      epg_id: epg.epg_id,
      start_timestamp: epg.start_timestamp,
      title: epg.title,
    };
  }

  isFuture(): boolean {
    return !!this.epg && this.epg.start_timestamp * 1000 > Date.now();
  }

  async scheduleRecording() {
    if (this.loadingSchedule || this.channelId === undefined || !this.epg) return;
    this.loadingSchedule = true;
    try {
      await invoke("schedule_recording", {
        channelId: this.channelId,
        title: this.epg.title,
        startTimestamp: this.epg.start_timestamp,
        endTimestamp: this.epg.end_timestamp,
      });
      this.error.success(this.translate.instant("TOAST.RECORDING_SCHEDULED"));
      this.scheduleChanged.emit();
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.loadingSchedule = false;
    }
  }

  async cancelScheduledRecording() {
    if (this.loadingSchedule || this.scheduledRecordingId === undefined) return;
    this.loadingSchedule = true;
    try {
      await invoke("cancel_scheduled_recording", { id: this.scheduledRecordingId });
      this.error.success(this.translate.instant("TOAST.RECORDING_CANCELLED"));
      this.scheduleChanged.emit();
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.loadingSchedule = false;
    }
  }

  async timeshift() {
    if (this.playing) return;
    this.playing = true;
    const channel: Channel = {
      id: -1,
      url: this.epg?.timeshift_url,
      name: this.epg?.title,
      media_type: MediaType.movie,

      favorite: false,
      source_id: this.sourceId,
    };
    try {
      await invoke("play", {
        channel: channel,
        record: false,
      });
    } catch (e) {
      console.error(e);
      this.error.handleError(e);
    } finally {
      this.playing = false;
    }
  }

  downloading() {
    return this.download.Downloads.has(this.getDownloadId());
  }

  getDownloadId() {
    return `${this.channelId}-${this.epg?.epg_id}`;
  }

  async downloadTimeshift() {
    let file = undefined;
    if (this.memory.IsContainer || this.memory.AlwaysAskSave) {
      file = await save({
        canCreateDirectories: true,
        title: this.translate.instant("DIALOG.SAVE_CATCHBACK"),
        defaultPath: `${sanitizeFileName(this.epg?.title!)}_${getDateFormatted()}.${getExtension(this.epg?.timeshift_url!)}`,
      });
      if (!file) {
        return;
      }
    }
    if (this.downloading()) return;
    const channel: Channel = {
      id: this.channelId,
      url: this.epg?.timeshift_url,
      name: this.epg?.title,
      media_type: MediaType.movie,
      favorite: false,
      source_id: this.sourceId,
    };
    const download = await this.download.enqueue(this.getDownloadId(), channel, file ?? undefined);
    this.downloadSubscribe(download);
  }

  downloadSubscribe(download: Download) {
    const progressUpdate = download.progressUpdate.subscribe((progress) => {
      this.ngZone.run(() => {
        this.progress = Math.trunc(progress);
      });
    });
    this.subscriptions.push(progressUpdate);
    this.subscriptions.push(
      download.complete.pipe(take(1)).subscribe((_) => {
        progressUpdate.unsubscribe();
        this.progress = 0;
      }),
    );
  }

  async cancelTimeshiftDownload() {
    await this.download.abortDownload(this.getDownloadId());
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
