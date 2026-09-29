import { Component, ElementRef, HostListener, OnDestroy, OnInit } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import { invoke } from "@tauri-apps/api/core";
import { Subject, Subscription, debounceTime } from "rxjs";
import { Channel } from "../models/channel";
import { XmltvChannelHit } from "../models/epgExtras";
import { displayName } from "../country-prefix";
import { ErrorService } from "../error.service";
import { NowPlayingService } from "../now-playing.service";

/**
 * Assigns an XMLTV guide channel to a channel by hand, or hands it back to the
 * automatic matching by name. Closes with `true` when the assignment changed
 * (the channel's cached EPG is dropped then), otherwise with `false`.
 */
@Component({
  selector: "app-epg-mapping-modal",
  standalone: false,
  templateUrl: "./epg-mapping-modal.component.html",
  styleUrl: "./epg-mapping-modal.component.css",
})
export class EpgMappingModalComponent implements OnInit, OnDestroy {
  /// Same convention as the other modals opened through memory.ModalRef.
  name = "EpgMappingModal";
  channel?: Channel;
  /// XMLTV id assigned by hand; null = automatic, undefined = still loading.
  current?: string | null;
  query = "";
  results: XmltvChannelHit[] = [];
  /// Index of the highlighted result (arrow keys), -1 for none.
  active = -1;
  searching = false;
  /// The first search finished; before that "no results" is not shown.
  searched = false;
  saving = false;
  private queries = new Subject<string>();
  private subscription?: Subscription;
  /// Sequence number of the latest search; older answers are dropped.
  private searchSeq = 0;

  constructor(
    public activeModal: NgbActiveModal,
    private translate: TranslateService,
    private error: ErrorService,
    private nowPlaying: NowPlayingService,
    private host: ElementRef<HTMLElement>,
  ) {}

  ngOnInit(): void {
    // The guides name channels without the playlist's "TR: " prefix.
    this.query = displayName(this.channel?.name, "hide");
    this.subscription = this.queries
      .pipe(debounceTime(250))
      .subscribe((query) => this.search(query));
    this.loadCurrent();
    this.search(this.query);
  }

  private async loadCurrent() {
    try {
      this.current =
        (await invoke<string | null>("get_epg_mapping", { channel: this.channel })) ?? null;
    } catch (e) {
      console.error(e);
      this.current = null;
    }
  }

  onQueryChange(query: string) {
    this.query = query;
    this.queries.next(query);
  }

  async search(query: string) {
    const seq = ++this.searchSeq;
    const trimmed = query.trim();
    if (!trimmed) {
      this.results = [];
      this.active = -1;
      this.searching = false;
      this.searched = true;
      return;
    }
    this.searching = true;
    try {
      const results = await invoke<XmltvChannelHit[]>("search_xmltv_channels", {
        query: trimmed,
      });
      if (seq !== this.searchSeq) return;
      this.results = results ?? [];
      this.active = this.results.length > 0 ? 0 : -1;
    } catch (e) {
      if (seq !== this.searchSeq) return;
      this.results = [];
      this.active = -1;
      this.error.handleError(e);
    } finally {
      if (seq === this.searchSeq) {
        this.searching = false;
        this.searched = true;
      }
    }
  }

  /** Arrow keys move through the results, Enter assigns the highlighted one. */
  onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (this.results.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        this.active = Math.min(this.results.length - 1, Math.max(0, this.active + delta));
        this.scrollActiveIntoView();
        break;
      }
      case "Enter":
        event.preventDefault();
        if (this.active >= 0 && this.results[this.active]) this.assign(this.results[this.active]);
        break;
    }
  }

  /// Escape anywhere in the dialog (opened with keyboard: false).
  /// preventDefault keeps the home page's handler from closing it again.
  @HostListener("keydown.escape", ["$event"])
  onEscape(event: Event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    this.cancel();
  }

  private scrollActiveIntoView() {
    setTimeout(() => {
      this.host.nativeElement
        .querySelector(`#epg-mapping-option-${this.active}`)
        ?.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  async assign(hit: XmltvChannelHit) {
    if (hit.id === this.current) {
      this.activeModal.close(false);
      return;
    }
    await this.save(hit.id);
  }

  async automatic() {
    await this.save(null);
  }

  private async save(xmltvId: string | null) {
    if (!this.channel || this.saving) return;
    this.saving = true;
    const name = this.channel.name;
    try {
      await invoke("set_epg_mapping", { channel: this.channel, xmltvId });
      if (this.channel.id !== undefined) this.nowPlaying.invalidate(this.channel.id);
      this.error.success(
        xmltvId
          ? this.translate.instant("TOAST.EPG_MAPPED", { name, id: xmltvId })
          : this.translate.instant("TOAST.EPG_MAPPING_REMOVED", { name }),
      );
      this.activeModal.close(true);
    } catch (e) {
      this.error.handleError(e, this.translate.instant("TOAST.EPG_MAPPING_FAILED"));
    } finally {
      this.saving = false;
    }
  }

  cancel() {
    // close, not dismiss: the openers only follow `result.then`.
    this.activeModal.close(false);
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
