import { Component, OnInit } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { EPG } from "../models/epg";
import { ScheduledRecording } from "../models/scheduledRecording";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";

@Component({
  selector: "app-epg-modal",
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
  ) { }

  ngOnInit() {
    invoke("get_epg_ids").then((x) => {
      let set = new Set(x as Array<string>);
      this.memory.Watched_epgs = set;
    });
    this.loadScheduledRecordings();
    this.filterEPGs();
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

  getFormattedDate() {
    return this.currentDate
      .toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
      .replace(",", "");
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
}
