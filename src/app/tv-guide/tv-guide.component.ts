import {
  AfterViewInit,
  Component,
  ElementRef,
  Injectable,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from "@angular/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { invoke } from "@tauri-apps/api/core";
import { TranslateService } from "@ngx-translate/core";
import { Subscription } from "rxjs";
import { MemoryService } from "../memory.service";
import { ErrorService } from "../error.service";
import { PlaybackService } from "../playback.service";
import { Channel } from "../models/channel";
import { EPG } from "../models/epg";
import { EPGNotify } from "../models/epgNotify";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { ViewMode } from "../models/viewMode";
import { ScheduledRecording } from "../models/scheduledRecording";
import { ProgrammeHit } from "../models/epgExtras";
import { EpgAlert, EpgAlertAction, findEpgAlert } from "../models/epgAlert";
import { splitCountryPrefix } from "../country-prefix";
import { uiLocale } from "../utils";

/// Session cache of the guide data per channel id, kept when the guide closes.
@Injectable({ providedIn: "root" })
export class GuideEpgCache {
  readonly entries: Map<number, EPG[]> = new Map();
}

type ProgrammeState = "past" | "now" | "future";

/// What the programme actions need: a guide block's EPG or a search hit.
type Programme = Pick<EPG, "epg_id" | "title" | "start_timestamp" | "end_timestamp">;

export interface GuideBlock {
  epg: EPG;
  /// Offset from the start of the time window and width, in px.
  offset: number;
  width: number;
  state: ProgrammeState;
  /// "Title, 20:15 – 21:00" for screen readers.
  label: string;
  /// Title, time and description for the tooltip.
  tooltip: string;
}

export interface GuideRow {
  channel: Channel;
  /// idle: not requested yet; queued: waiting for a free request slot.
  state: "idle" | "queued" | "loading" | "done" | "error";
  blocks: GuideBlock[];
}

export interface GuideSlot {
  timestamp: number;
  label: string;
}

export interface GuideSearchHit {
  hit: ProgrammeHit;
  state: ProgrammeState;
  /// "20:15 – 21:45".
  time: string;
  /// How much of a running programme has aired, 0..100.
  progress: number;
}

export interface GuideSearchDay {
  /// Local date, "2026-9-29".
  key: string;
  /// "Today", "Tomorrow" or weekday and date.
  label: string;
  hits: GuideSearchHit[];
}

/**
 * TV guide: live channels as rows, time (now - 1 h .. now + 6 h, 30 minute
 * slots) as columns. EPG data is fetched lazily for the rows near the
 * viewport, at most {@link MAX_IN_FLIGHT} at a time, and cached per channel
 * for the session.
 */
@Component({
  standalone: false,
  selector: "app-tv-guide",
  templateUrl: "./tv-guide.component.html",
  styleUrls: ["./tv-guide.component.css", "./tv-guide-search.css", "./tv-guide-alerts.css"],
})
export class TvGuideComponent implements OnInit, AfterViewInit, OnDestroy {
  static readonly PAGE_SIZE = 36;
  static readonly MAX_IN_FLIGHT = 4;
  static readonly SLOT_SECONDS = 30 * 60;
  /// Width of one 30 minute slot in px (keep in sync with --guide-slot-width).
  static readonly SLOT_WIDTH = 120;
  static readonly PX_PER_SECOND = TvGuideComponent.SLOT_WIDTH / TvGuideComponent.SLOT_SECONDS;
  static readonly SEARCH_DEBOUNCE_MS = 300;
  /// The backend answers shorter queries with nothing.
  static readonly SEARCH_MIN_LENGTH = 2;

  /// Restricts the rows to one group (the one open in the library).
  @Input() group?: { id: number; name: string };

  readonly slotWidth = TvGuideComponent.SLOT_WIDTH;
  rows: GuideRow[] = [];
  slots: GuideSlot[] = [];
  windowStart = 0;
  windowEnd = 0;
  timelineWidth = 0;
  nowOffset = 0;
  loading = false;
  loaded = false;
  reachedMax = false;
  loadFailed = false;
  /// Roving tabindex: the one cell reachable with Tab. Column 0 is the
  /// channel name, column i + 1 the i-th programme block of the row.
  activeRow = 0;
  activeCol = 0;
  /// Programme the "future" menu was opened for.
  menuRow?: GuideRow;
  menuBlock?: GuideBlock;
  menuPosition = { x: 0, y: 0 };
  /// "channelId:start" -> scheduled recording id.
  scheduled: Map<string, number> = new Map();
  scheduling = false;
  /// Programme search: while a query is active the results replace the grid
  /// (which is only hidden, so it comes back as it was).
  searchQuery = "";
  searchResults: ProgrammeHit[] = [];
  searchDays: GuideSearchDay[] = [];
  searching = false;
  /// An answer for the current query has arrived.
  searched = false;
  /// Saved searches ("always remind / record"), offered for the current query.
  alerts: EpgAlert[] = [];
  alertBusy = false;

  @ViewChild("scroller") scroller?: ElementRef<HTMLElement>;
  @ViewChild("sentinel") sentinel?: ElementRef<HTMLElement>;
  @ViewChildren("rowEl") rowEls?: QueryList<ElementRef<HTMLElement>>;
  @ViewChild(MatMenuTrigger) menuTrigger?: MatMenuTrigger;

  private page = 0;
  private loadSeq = 0;
  private queue: GuideRow[] = [];
  private inFlight = 0;
  private destroyed = false;
  private rowObserver?: IntersectionObserver;
  private sentinelObserver?: IntersectionObserver;
  private observed = new WeakSet<Element>();
  private timer?: ReturnType<typeof setInterval>;
  private subscriptions: Subscription[] = [];
  private timeFormat?: Intl.DateTimeFormat;
  private dayFormat?: Intl.DateTimeFormat;
  /// Bumped on every query change, so answers to older queries are dropped.
  private searchSeq = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    public memory: MemoryService,
    private error: ErrorService,
    private translate: TranslateService,
    private playback: PlaybackService,
    private cache: GuideEpgCache,
    private ngZone: NgZone,
    private host: ElementRef<HTMLElement>,
  ) {}

  ngOnInit(): void {
    this.computeWindow();
    this.load();
    this.loadScheduled();
    this.loadAlerts();
    this.memory.get_epg_ids().catch((e) => console.error(e));
    // The "now" line moves every minute; programme states follow it.
    this.timer = setInterval(() => this.tick(), 60 * 1000);
  }

  ngAfterViewInit(): void {
    const root = this.scroller?.nativeElement ?? null;
    if (typeof IntersectionObserver !== "undefined") {
      this.rowObserver = new IntersectionObserver(
        (entries) => this.ngZone.run(() => this.onRowsIntersect(entries)),
        { root, rootMargin: "200px 0px" },
      );
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) this.ngZone.run(() => this.loadMore());
        },
        { root, rootMargin: "0px 0px 300px 0px" },
      );
      if (this.sentinel) this.sentinelObserver.observe(this.sentinel.nativeElement);
    }
    this.observeRows();
    // The menu's trigger is an invisible anchor: give the focus back to the
    // programme the menu was opened for.
    if (this.menuTrigger) {
      this.subscriptions.push(
        this.menuTrigger.menuClosed.subscribe(() => this.focusCell(this.activeRow, this.activeCol)),
      );
    }
    if (this.rowEls)
      this.subscriptions.push(this.rowEls.changes.subscribe(() => this.observeRows()));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.rowObserver?.disconnect();
    this.sentinelObserver?.disconnect();
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.queue = [];
  }

  // ------------------------------------------------------------ time window

  private computeWindow() {
    const now = Math.floor(Date.now() / 1000);
    const slot = TvGuideComponent.SLOT_SECONDS;
    this.windowStart = Math.floor((now - 3600) / slot) * slot;
    const count = Math.ceil((now + 6 * 3600 - this.windowStart) / slot);
    this.windowEnd = this.windowStart + count * slot;
    this.timelineWidth = count * TvGuideComponent.SLOT_WIDTH;
    this.slots = Array.from({ length: count }, (_, i) => {
      const timestamp = this.windowStart + i * slot;
      return { timestamp, label: this.formatTime(timestamp) };
    });
    this.updateNow(now);
  }

  private updateNow(now: number) {
    this.nowOffset = (now - this.windowStart) * TvGuideComponent.PX_PER_SECOND;
  }

  nowVisible(): boolean {
    return this.nowOffset >= 0 && this.nowOffset <= this.timelineWidth;
  }

  private tick() {
    const now = Date.now() / 1000;
    this.updateNow(now);
    for (const row of this.rows) {
      for (const block of row.blocks) block.state = this.stateOf(block.epg, now);
    }
    if (this.searchResults.length > 0) this.groupResults(now);
  }

  private stateOf(programme: Programme, now = Date.now() / 1000): ProgrammeState {
    if (programme.end_timestamp <= now) return "past";
    if (programme.start_timestamp > now) return "future";
    return "now";
  }

  formatTime(timestamp: number): string {
    if (!this.timeFormat) {
      try {
        this.timeFormat = new Intl.DateTimeFormat(uiLocale(this.translate), { timeStyle: "short" });
      } catch {
        this.timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
      }
    }
    return this.timeFormat.format(timestamp * 1000);
  }

  private timeRange(programme: Programme): string {
    return `${this.formatTime(programme.start_timestamp)} – ${this.formatTime(programme.end_timestamp)}`;
  }

  /// "Today", "Tomorrow", else weekday and date in the UI language.
  private dayLabel(date: Date): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    // Rounded: a day with a DST switch has 23 or 25 hours.
    const diff = Math.round((day.getTime() - today.getTime()) / (24 * 3600 * 1000));
    if (diff === 0) return this.translate.instant("GUIDE.TODAY");
    if (diff === 1) return this.translate.instant("GUIDE.TOMORROW");
    if (!this.dayFormat) {
      const options: Intl.DateTimeFormatOptions = {
        weekday: "long",
        day: "numeric",
        month: "long",
      };
      try {
        this.dayFormat = new Intl.DateTimeFormat(uiLocale(this.translate), options);
      } catch {
        this.dayFormat = new Intl.DateTimeFormat(undefined, options);
      }
    }
    return this.dayFormat.format(date);
  }

  // ------------------------------------------------------------------- rows

  private filters(page: number): Filters {
    return {
      query: "",
      source_ids: Array.from(this.memory.Sources.keys()),
      media_types: [MediaType.livestream],
      view_type: ViewMode.All,
      page,
      group_id: this.group?.id,
      use_keywords: false,
      sort: this.memory.Sort.value[0],
      show_locked: this.memory.ShowLocked,
    };
  }

  async load(more = false) {
    if (this.loading && more) return;
    const seq = ++this.loadSeq;
    const page = more ? this.page + 1 : 1;
    this.loading = true;
    try {
      const channels = await invoke<Channel[]>("search", { filters: this.filters(page) });
      if (seq !== this.loadSeq || this.destroyed) return;
      this.page = page;
      const rows = channels.map((channel) => this.toRow(channel));
      this.rows = more ? this.rows.concat(rows) : rows;
      this.reachedMax = channels.length < TvGuideComponent.PAGE_SIZE;
      this.loadFailed = false;
      // The embedded player's side list offers the guide's channels.
      this.memory.PlayerChannelList = this.rows.map((r) => r.channel);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.loadFailed = true;
      this.error.handleError(e);
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        this.loaded = true;
      }
    }
  }

  loadMore(explicit = false) {
    if (this.loading || this.reachedMax || !this.loaded) return;
    if (this.loadFailed && !explicit) return;
    this.load(true);
  }

  private toRow(channel: Channel): GuideRow {
    const row: GuideRow = { channel, state: "idle", blocks: [] };
    const cached = channel.id !== undefined ? this.cache.entries.get(channel.id) : undefined;
    if (cached) this.applyEpg(row, cached);
    return row;
  }

  private observeRows() {
    if (!this.rowObserver || !this.rowEls) return;
    for (const ref of this.rowEls) {
      const el = ref.nativeElement;
      if (this.observed.has(el)) continue;
      this.observed.add(el);
      this.rowObserver.observe(el);
    }
  }

  private onRowsIntersect(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset["row"]);
      const row = this.rows[index];
      if (!row) continue;
      if (entry.isIntersecting) this.request(row);
      else if (row.state === "queued") {
        // Scrolled past before its turn came: fetch it when it is back.
        this.queue = this.queue.filter((r) => r !== row);
        row.state = "idle";
      }
    }
  }

  /** Queues the EPG request of a row (no-op when loaded or already queued). */
  request(row: GuideRow) {
    if (row.state !== "idle") return;
    row.state = "queued";
    this.queue.push(row);
    this.pump();
  }

  private pump() {
    while (!this.destroyed && this.inFlight < TvGuideComponent.MAX_IN_FLIGHT) {
      const row = this.queue.shift();
      if (!row) return;
      this.fetch(row);
    }
  }

  private async fetch(row: GuideRow) {
    this.inFlight++;
    row.state = "loading";
    try {
      const epg = await invoke<EPG[]>("get_epg", { channel: row.channel });
      if (row.channel.id !== undefined) this.cache.entries.set(row.channel.id, epg);
      this.applyEpg(row, epg);
    } catch (e) {
      console.error(e);
      row.state = "error";
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  private applyEpg(row: GuideRow, epg: EPG[]) {
    const px = TvGuideComponent.PX_PER_SECOND;
    const now = Date.now() / 1000;
    row.blocks = epg
      .filter((e) => e.end_timestamp > this.windowStart && e.start_timestamp < this.windowEnd)
      .sort((a, b) => a.start_timestamp - b.start_timestamp)
      .map((e) => {
        const start = Math.max(e.start_timestamp, this.windowStart);
        const end = Math.min(e.end_timestamp, this.windowEnd);
        const time = this.timeRange(e);
        return {
          epg: e,
          offset: (start - this.windowStart) * px,
          width: Math.max(4, (end - start) * px),
          state: this.stateOf(e, now),
          label: `${e.title}, ${time}`,
          tooltip: [e.title, time, e.description].filter((x) => !!x).join("\n"),
        };
      });
    row.state = "done";
    // Keep the roving tab stop on an existing cell.
    if (this.rows[this.activeRow] === row && this.activeCol > row.blocks.length) {
      this.activeCol = row.blocks.length;
    }
  }

  trackRow(_: number, row: GuideRow) {
    return row.channel.id;
  }

  trackBlock(_: number, block: GuideBlock) {
    return block.epg.start_timestamp;
  }

  cellId(row: number, col: number): string {
    return `guide-cell-${row}-${col}`;
  }

  tabIndex(row: number, col: number): number {
    return row === this.activeRow && col === this.activeCol ? 0 : -1;
  }

  /// The country code shown as a pill in front of the name ("badge" mode).
  countryCode(name?: string): string | undefined {
    return this.memory.CountryPrefixMode === "badge" ? splitCountryPrefix(name).code : undefined;
  }

  // ----------------------------------------------------------------- search

  searchActive(): boolean {
    return this.searchQuery.trim().length >= TvGuideComponent.SEARCH_MIN_LENGTH;
  }

  onSearchChange(query: string) {
    this.searchQuery = query;
    const seq = ++this.searchSeq;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    const term = query.trim();
    if (term.length < TvGuideComponent.SEARCH_MIN_LENGTH) {
      this.searching = false;
      this.searched = false;
      this.searchResults = [];
      this.searchDays = [];
      return;
    }
    this.searching = true;
    this.searchTimer = setTimeout(
      () => this.runSearch(term, seq),
      TvGuideComponent.SEARCH_DEBOUNCE_MS,
    );
  }

  /** Escape empties the field; only an empty field lets it navigate back. */
  onSearchKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !this.searchQuery) return;
    event.preventDefault();
    event.stopPropagation();
    this.clearSearch();
  }

  clearSearch() {
    this.onSearchChange("");
  }

  private async runSearch(query: string, seq: number) {
    this.searchTimer = undefined;
    try {
      const hits = await invoke<ProgrammeHit[]>("search_programmes", {
        query,
        showLocked: this.memory.ShowLocked,
      });
      if (seq !== this.searchSeq || this.destroyed) return;
      this.searchResults = hits;
      this.groupResults();
    } catch (e) {
      if (seq !== this.searchSeq || this.destroyed) return;
      this.searchResults = [];
      this.searchDays = [];
      this.error.handleError(e);
    } finally {
      if (seq === this.searchSeq) {
        this.searching = false;
        this.searched = true;
      }
    }
  }

  /// Groups the hits (ordered by start) by local day; a programme that is
  /// already running counts as today even when it started yesterday.
  private groupResults(now = Date.now() / 1000) {
    const days = new Map<string, GuideSearchDay>();
    for (const hit of this.searchResults) {
      const date = new Date(Math.max(hit.start_timestamp, now) * 1000);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      let day = days.get(key);
      if (!day) {
        day = { key, label: this.dayLabel(date), hits: [] };
        days.set(key, day);
      }
      const duration = hit.end_timestamp - hit.start_timestamp;
      const aired = duration > 0 ? ((now - hit.start_timestamp) / duration) * 100 : 0;
      day.hits.push({
        hit,
        state: this.stateOf(hit, now),
        time: this.timeRange(hit),
        progress: Math.min(100, Math.max(0, aired)),
      });
    }
    this.searchDays = Array.from(days.values());
  }

  trackDay(_: number, day: GuideSearchDay) {
    return day.key;
  }

  /// One guide programme can be on several playlist channels.
  trackHit(_: number, item: GuideSearchHit) {
    return `${item.hit.channel.id}:${item.hit.epg_id}`;
  }

  // ---------------------------------------------------------------- actions

  async playChannel(channel: Channel) {
    try {
      await this.playback.play(channel);
      await this.playback.addToHistory(channel);
    } catch (e) {
      this.error.handleError(e);
    }
  }

  /** Enter / click on a programme block. */
  async activate(row: GuideRow, block: GuideBlock, event?: Event) {
    const state = this.stateOf(block.epg);
    if (state === "now") {
      await this.playChannel(row.channel);
    } else if (state === "past") {
      if (block.epg.timeshift_url) await this.timeshift(row, block.epg);
      else this.error.info(this.translate.instant("GUIDE.NO_CATCHUP"));
    } else {
      this.openFutureMenu(row, block, event);
    }
  }

  /** Catch-up, played the way the EPG modal does. */
  private async timeshift(row: GuideRow, epg: EPG) {
    const channel: Channel = {
      id: -1,
      url: epg.timeshift_url,
      name: epg.title,
      media_type: MediaType.movie,
      favorite: false,
      source_id: row.channel.source_id,
    };
    try {
      await invoke("play", { channel, record: false });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  private openFutureMenu(row: GuideRow, block: GuideBlock, event?: Event) {
    this.menuRow = row;
    this.menuBlock = block;
    const target = (event?.currentTarget ?? event?.target) as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    const mouse = event instanceof MouseEvent && event.detail > 0 ? event : undefined;
    this.menuPosition = mouse
      ? { x: mouse.clientX, y: mouse.clientY }
      : { x: rect ? rect.left + 8 : 0, y: rect ? rect.bottom : 0 };
    // Let the hidden trigger move to the new position before the menu opens.
    setTimeout(() => this.menuTrigger?.openMenu(), 0);
  }

  private scheduleKey(channelId: number | undefined, start: number) {
    return `${channelId}:${start}`;
  }

  scheduledId(row?: GuideRow, block?: GuideBlock): number | undefined {
    if (!row || !block) return undefined;
    return this.scheduledFor(row.channel, block.epg);
  }

  scheduledFor(channel: Channel, programme: Programme): number | undefined {
    return this.scheduled.get(this.scheduleKey(channel.id, programme.start_timestamp));
  }

  async loadScheduled() {
    try {
      const recordings = await invoke<ScheduledRecording[]>("get_scheduled_recordings");
      this.scheduled = new Map(
        recordings.map((r) => [this.scheduleKey(r.channel_id, r.start_timestamp), r.id]),
      );
    } catch (e) {
      console.error(e);
    }
  }

  /** Recording of the programme the menu was opened for. */
  async toggleRecording() {
    if (!this.menuRow || !this.menuBlock) return;
    await this.toggleSchedule(this.menuRow.channel, this.menuBlock.epg);
  }

  /** Schedules or cancels a recording (guide menu and search results). */
  async toggleSchedule(channel: Channel, programme: Programme) {
    if (this.scheduling || channel.id === undefined) return;
    this.scheduling = true;
    const id = this.scheduledFor(channel, programme);
    try {
      if (id === undefined) {
        await invoke("schedule_recording", {
          channelId: channel.id,
          title: programme.title,
          startTimestamp: programme.start_timestamp,
          endTimestamp: programme.end_timestamp,
        });
        this.error.success(this.translate.instant("TOAST.RECORDING_SCHEDULED"));
      } else {
        await invoke("cancel_scheduled_recording", { id });
        this.error.success(this.translate.instant("TOAST.RECORDING_CANCELLED"));
      }
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.scheduling = false;
    }
    await this.loadScheduled();
  }

  notificationOn(block?: GuideBlock): boolean {
    return !!block && this.reminderOn(block.epg);
  }

  reminderOn(programme: Programme): boolean {
    return this.memory.Watched_epgs.has(programme.epg_id);
  }

  /** Reminder for the programme the menu was opened for. */
  async toggleNotification() {
    if (!this.menuRow || !this.menuBlock) return;
    await this.toggleReminder(this.menuRow.channel, this.menuBlock.epg);
  }

  /** Reminder, the same commands as the EPG modal's bell (guide menu and
   *  search results). */
  async toggleReminder(channel: Channel, programme: Programme) {
    if (this.memory.LoadingNotification || !this.memory.trayEnabled) return;
    this.memory.LoadingNotification = true;
    try {
      if (!this.reminderOn(programme)) {
        const epg: EPGNotify = {
          channel_name: channel.name ?? "",
          epg_id: programme.epg_id,
          start_timestamp: programme.start_timestamp,
          title: programme.title,
        };
        await invoke("add_epg", { epg });
        this.error.success(this.translate.instant("TOAST.NOTIFICATION_ADDED"));
      } else {
        await invoke("remove_epg", { epgId: programme.epg_id });
        this.error.success(this.translate.instant("TOAST.NOTIFICATION_REMOVED"));
      }
      await this.memory.get_epg_ids();
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.memory.LoadingNotification = false;
    }
  }

  // ----------------------------------------------------------------- alerts

  async loadAlerts() {
    try {
      this.alerts = (await invoke<EpgAlert[]>("get_epg_alerts")) ?? [];
    } catch (e) {
      console.error(e);
    }
  }

  /// The saved search for the current query and action, shown as active.
  alertFor(action: EpgAlertAction): EpgAlert | undefined {
    return findEpgAlert(this.alerts, this.searchQuery, action);
  }

  /// Offered with XMLTV data only (nothing to match without it), but an
  /// existing alert stays visible so it can be removed.
  alertsOffered(): boolean {
    return (
      this.searchActive() &&
      (this.memory.HasXmltv || !!this.alertFor("remind") || !!this.alertFor("record"))
    );
  }

  /** Saves the current query as an alert; the backend applies it at once. */
  async addAlert(action: EpgAlertAction) {
    const query = this.searchQuery.trim();
    if (this.alertBusy || !this.searchActive() || this.alertFor(action)) return;
    if (action === "remind" && !this.memory.trayEnabled) return;
    this.alertBusy = true;
    try {
      await invoke<number>("add_epg_alert", { query, action });
      this.error.success(
        this.translate.instant(
          action === "remind" ? "GUIDE.ALERT_REMIND_ADDED" : "GUIDE.ALERT_RECORD_ADDED",
          { query },
        ),
      );
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.alertBusy = false;
    }
    // The result rows show the reminders and recordings it just created.
    await Promise.all([
      this.loadAlerts(),
      this.loadScheduled(),
      this.memory.get_epg_ids().catch((e) => console.error(e)),
    ]);
    // The button turned into the "active" chip: keep the focus on it.
    this.focusById(`guide-alert-${action}-remove`);
  }

  /** Stops future matches; reminders and recordings made so far stay. */
  async removeAlert(alert: EpgAlert) {
    if (this.alertBusy) return;
    this.alertBusy = true;
    try {
      await invoke("delete_epg_alert", { id: alert.id });
      this.error.success(this.translate.instant("GUIDE.ALERT_REMOVED", { query: alert.query }));
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.alertBusy = false;
    }
    await this.loadAlerts();
    this.focusById(`guide-alert-${alert.action}-add`);
  }

  private focusById(id: string) {
    setTimeout(() => document.getElementById(id)?.focus(), 0);
  }

  // --------------------------------------------------------------- keyboard

  onFocusCell(row: number, col: number) {
    this.activeRow = row;
    this.activeCol = col;
  }

  onKeyDown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
      return;
    if (this.rows.length === 0) return;
    // The home page's own arrow key navigation must not run as well.
    event.preventDefault();
    event.stopPropagation();
    const rtl = getComputedStyle(this.host.nativeElement).direction === "rtl";
    let row = Math.min(this.activeRow, this.rows.length - 1);
    let col = this.activeCol;
    const current = this.rows[row];
    col = Math.min(col, current.blocks.length);
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const forward = (event.key === "ArrowRight") !== rtl;
        col = Math.min(current.blocks.length, Math.max(0, col + (forward ? 1 : -1)));
        break;
      }
      case "Home":
        col = 0;
        break;
      case "End":
        col = current.blocks.length;
        break;
      case "ArrowUp":
      case "ArrowDown": {
        const target = row + (event.key === "ArrowDown" ? 1 : -1);
        if (target < 0) return;
        if (target >= this.rows.length) {
          this.loadMore();
          return;
        }
        col = this.matchingCol(current, col, this.rows[target]);
        row = target;
        break;
      }
    }
    this.focusCell(row, col);
  }

  /// The column in `target` whose programme overlaps the one focused in
  /// `from` (the channel name stays the channel name).
  private matchingCol(from: GuideRow, col: number, target: GuideRow): number {
    if (col === 0 || target.blocks.length === 0) return 0;
    const block = from.blocks[col - 1];
    if (!block) return 0;
    const mid = block.offset + block.width / 2;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    target.blocks.forEach((b, i) => {
      const distance =
        mid < b.offset ? b.offset - mid : mid > b.offset + b.width ? mid - b.offset - b.width : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i + 1;
      }
    });
    return best;
  }

  private focusCell(row: number, col: number) {
    this.activeRow = row;
    this.activeCol = col;
    // Wait for the tabindex change to render.
    setTimeout(() => {
      const el = document.getElementById(this.cellId(row, col));
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, 0);
  }
}
