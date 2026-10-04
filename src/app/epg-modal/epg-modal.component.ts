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
  /// Earliest and latest programme start, cached per programme list.
  private range?: { epg: EPG[]; first: number; last: number };
  constructor(
    public activeModal: NgbActiveModal,
    private memory: MemoryService,
    private translate: TranslateService,
    private host: ElementRef<HTMLElement>,
  ) {}

  ngOnInit() {
    invoke("get_epg_ids")
      .then((x) => {
        const set = new Set(x as Array<string>);
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
    this.shiftDay(-1);
  }

  next() {
    this.shiftDay(1);
  }

  /** Back to today, at the programme on now. */
  goToday() {
    this.currentDate = new Date();
    this.filterEPGs();
    this.scrollAfterDayChange();
  }

  /** The shown day is today. */
  isToday(): boolean {
    return this.isSameDay(this.currentDate, new Date());
  }

  /** A day back (-1) or ahead (+1), as far as the loaded programmes reach. */
  shiftDay(days: number) {
    if (!this.canShiftDay(days)) return;
    const date = new Date(this.currentDate);
    date.setDate(date.getDate() + days);
    this.currentDate = date;
    this.filterEPGs();
    this.scrollAfterDayChange();
  }

  /**
   * Only to a day on which a loaded programme starts (the days are listed by
   * start): the provider's EPG covers a few days, the others would be empty.
   * Today is always reachable.
   */
  canShiftDay(days: number): boolean {
    const target = new Date(this.currentDate);
    target.setHours(0, 0, 0, 0);
    target.setDate(target.getDate() + days);
    if (this.isSameDay(target, new Date())) return true;
    const range = this.startRange();
    if (!range) return false;
    const start = target.getTime() / 1000;
    target.setDate(target.getDate() + 1);
    const end = target.getTime() / 1000;
    return range.first < end && range.last >= start;
  }

  private startRange(): { first: number; last: number } | undefined {
    if (this.epg.length === 0) return undefined;
    if (this.range?.epg !== this.epg) {
      let first = Number.POSITIVE_INFINITY;
      let last = Number.NEGATIVE_INFINITY;
      for (const e of this.epg) {
        first = Math.min(first, e.start_timestamp);
        last = Math.max(last, e.start_timestamp);
      }
      this.range = { epg: this.epg, first, last };
    }
    return this.range;
  }

  /** After a day change: today at the programme on now, other days at the top. */
  private scrollAfterDayChange() {
    if (this.isToday() && this.filteredEPGs.some((x) => x.now_playing)) {
      this.scrollToNowPlaying(0);
      return;
    }
    // The dialog scrolls as a whole (.modal), not its body.
    const modal = this.host.nativeElement.closest<HTMLElement>(".modal");
    if (modal) modal.scrollTop = 0;
    else this.host.nativeElement.scrollIntoView({ block: "start" });
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

  /**
   * Brings the currently airing programme into view once the list rendered
   * (on open after the modal's open animation settled).
   */
  private scrollToNowPlaying(delay = 150) {
    if (!this.filteredEPGs.some((x) => x.now_playing)) return;
    setTimeout(() => {
      const current = this.host.nativeElement.querySelector<HTMLElement>(".epg-entry--now");
      current?.scrollIntoView({ block: "center", behavior: "auto" });
    }, delay);
  }
}
