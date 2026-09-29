import { Component, ElementRef, OnInit } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import { EPG } from "../models/epg";
import { ScheduledRecording } from "../models/scheduledRecording";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";

@Component({
  selector: "app-epg-modal",
  standalone: false,
  templateUrl: "./epg-modal.component.html",
  styleUrl: "./epg-modal.component.css",
})
export class EpgModalComponent implements OnInit {
  name?: string;
  sourceId?: number;
  channelId?: number;
  epg: EPG[] = [];
  filteredEPGs: EPG[] = [];
  currentDate = new Date();
  // start_timestamp -> scheduled recording id, for this modal's channel
  scheduledRecordings: Map<number, number> = new Map();
  constructor(
    public activeModal: NgbActiveModal,
    private memory: MemoryService,
    private translate: TranslateService,
    private host: ElementRef<HTMLElement>,
  ) {}

  ngOnInit() {
    invoke("get_epg_ids")
      .then((x) => {
        let set = new Set(x as Array<string>);
        this.memory.Watched_epgs = set;
      })
      .catch((e) => console.error(e));
    this.loadScheduledRecordings();
    this.filterEPGs();
    this.scrollToNowPlaying();
  }

  async loadScheduledRecordings() {
    if (this.channelId === undefined) return;
    try {
      const recordings = await invoke<ScheduledRecording[]>("get_scheduled_recordings");
      this.scheduledRecordings = new Map(
        recordings
          .filter((r) => r.channel_id === this.channelId)
          .map((r) => [r.start_timestamp, r.id]),
      );
    } catch (e) {
      console.error(e);
    }
  }

  getScheduledRecordingId(epg: EPG): number | undefined {
    return this.scheduledRecordings.get(epg.start_timestamp);
  }

  /** Date of the shown day, formatted in the active UI language. */
  getFormattedDate() {
    const lang = this.translate.getCurrentLang() || this.translate.getFallbackLang() || undefined;
    try {
      return this.currentDate.toLocaleDateString(lang, {
        weekday: "short",
        month: "long",
        day: "numeric",
      });
    } catch {
      return this.currentDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "long",
        day: "numeric",
      });
    }
  }

  prev() {
    this.currentDate.setDate(this.currentDate.getDate() - 1);
    this.filterEPGs();
  }

  next() {
    this.currentDate.setDate(this.currentDate.getDate() + 1);
    this.filterEPGs();
  }

  filterEPGs() {
    this.filteredEPGs = this.epg.filter((x) =>
      this.isSameDay(new Date(x.start_timestamp * 1000), this.currentDate),
    );
  }

  isSameDay(d1: Date, d2: Date) {
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  }

  /** Brings the currently airing programme into view once the list rendered. */
  private scrollToNowPlaying() {
    if (!this.filteredEPGs.some((x) => x.now_playing)) return;
    // Wait for the list to render and the modal open animation to settle.
    setTimeout(() => {
      const current = this.host.nativeElement.querySelector<HTMLElement>(".epg-entry--now");
      current?.scrollIntoView({ block: "center", behavior: "auto" });
    }, 150);
  }
}
