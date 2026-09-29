import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from "@angular/core";
import { Router } from "@angular/router";
import { AllowIn, ShortcutInput } from "ng-keyboard-shortcuts";
import { Subscription, debounceTime, filter, fromEvent, map, skip } from "rxjs";
import { MemoryService } from "../memory.service";
import { NowPlayingService } from "../now-playing.service";
import { Channel } from "../models/channel";
import { ViewMode } from "../models/viewMode";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { FocusArea, FocusAreaPrefix } from "../models/focusArea";
import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { Source } from "../models/source";
import { Filters } from "../models/filters";
import { SourceType } from "../models/sourceType";
import { animate, state, style, transition, trigger } from "@angular/animations";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SortType } from "../models/sortType";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { SIDEBAR_COLLAPSED } from "../models/localStorage";
import { isInputFocused } from "../utils";
import { Node } from "../models/node";
import { NodeType } from "../models/nodeType";
import { Stack } from "../models/stack";
import { VIEW_FORMAT, ViewFormat } from "../models/viewFormat";
import { TranslateService } from "@ngx-translate/core";
import { ChannelTileComponent } from "../channel-tile/channel-tile.component";
import { ParentalService } from "../parental.service";
import { CountryCount } from "../models/epgExtras";
import { toCountryPrefixMode } from "../country-prefix";

/// What the main area shows: the channel library (all view modes, also
/// "continue watching"), the TV guide or the recordings. Frontend only; the
/// backend view_type is only used by `search`.
export type HomePanel = "library" | "guide" | "recordings";

/// Number of sidebar nav items (ids viewMode-0 .. viewMode-6).
const NAV_ITEM_COUNT = 7;

@Component({
  selector: "app-home",
  standalone: false,
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.css",
  animations: [
    trigger("fadeInOut", [
      transition(":enter", [
        style({ opacity: 0, height: 0, padding: "0", margin: "0" }),
        animate("250ms", style({ opacity: 1, height: "*", padding: "*", margin: "*" })),
      ]),
      transition(":leave", [
        style({ opacity: 1, height: "*", padding: "*", margin: "*" }),
        animate("250ms", style({ opacity: 0, height: 0, padding: "0", margin: "0" })),
      ]),
    ]),
    trigger("fade", [
      state(
        "visible",
        style({
          opacity: 1,
        }),
      ),
      state(
        "hidden",
        style({
          opacity: 0,
        }),
      ),
      transition("visible => hidden", [animate("250ms ease-out")]),
      transition("hidden => visible", [animate("250ms ease-in")]),
    ]),
  ],
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {
  channels: Channel[] = [];
  readonly viewModeEnum = ViewMode;
  readonly mediaTypeEnum = MediaType;
  @ViewChild("search") search!: ElementRef;
  @ViewChild("tileGrid") tileGrid?: ElementRef<HTMLElement>;
  @ViewChildren(ChannelTileComponent) tiles?: QueryList<ChannelTileComponent>;
  shortcuts: ShortcutInput[] = [];
  focus: number = 0;
  focusArea = FocusArea.Tiles;
  viewType = ViewMode.All;
  subscriptions: Subscription[] = [];
  filters?: Filters;
  chkLiveStream = true;
  chkMovie = true;
  chkSerie = true;
  reachedMax = false;
  /// Loading the next page failed: no more automatic loads (scrolling,
  /// keyboard) until the query changes or the user presses "Load more".
  loadMoreFailed = false;
  readonly PAGE_SIZE = 36;
  channelsVisible = true;
  prevSearchValue: String = "";
  loading = false;
  gridLoading = false;
  readonly skeletons = Array(9);
  nodeStack: Stack = new Stack();
  showScrollTop = false;
  viewFormat: ViewFormat = this.loadViewFormat();
  /// Whether any enabled source is an Xtream one; cached when the sources load
  /// instead of being recomputed on every change detection.
  hasXtream = false;
  private autoRefreshUnlisten?: UnlistenFn;
  private destroyed = false;
  /// Sequence number of the latest load(); older responses are dropped.
  private loadSeq = 0;
  /// A goBack() is still loading its level; ignore further back presses.
  private navigatingBack = false;
  private scrollListener?: () => void;
  sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED) === "true";
  panel: HomePanel = "library";
  /// History restricted to movies/episodes, which resume where they were left.
  continueWatching = false;
  /// The media filters of the other views, kept while "continue watching"
  /// replaces them with movies only.
  private savedMediaTypes?: MediaType[];
  /// Group the TV guide is restricted to (the one open when it was opened).
  guideGroup?: { id: number; name: string };
  /// Country prefixes of the shown sources' names, most common first.
  countries: CountryCount[] = [];
  /// Sequence number of the latest loadCountries(); older answers are dropped.
  private countriesSeq = 0;

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED, String(this.sidebarCollapsed));
  }

  private loadViewFormat(): ViewFormat {
    const stored = localStorage.getItem(VIEW_FORMAT);
    return stored === "list" ? stored : "grid";
  }

  setViewFormat(format: ViewFormat) {
    if (this.viewFormat === format) return;
    this.viewFormat = format;
    localStorage.setItem(VIEW_FORMAT, format);
  }

  isMode(viewMode: ViewMode): boolean {
    return (
      this.panel === "library" && !this.continueWatching && this.filters?.view_type === viewMode
    );
  }

  isContinueWatching(): boolean {
    return this.panel === "library" && this.continueWatching;
  }

  trackByChannel(index: number, channel: Channel) {
    return channel.id === undefined ? `i${index}` : `${channel.media_type}:${channel.id}`;
  }

  constructor(
    private router: Router,
    public memory: MemoryService,
    public toast: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    private ngZone: NgZone,
    private translate: TranslateService,
    private parental: ParentalService,
    private nowPlaying: NowPlayingService,
  ) {
    this.getSources();
    this.listenForAutoRefresh();
    this.nowPlaying.init();
  }

  ngOnInit(): void {
    // Scroll events fire at a high rate: handle them outside Angular and only
    // re-enter the zone when something bound actually changes.
    this.ngZone.runOutsideAngular(() => {
      this.scrollListener = () => this.onScroll();
      window.addEventListener("scroll", this.scrollListener, { passive: true });
    });
    this.buildShortcuts();
    // The help labels are translated: rebuild them once the language file is
    // loaded (it may still be loading when the home page opens) or switched.
    this.subscriptions.push(this.translate.onLangChange.subscribe(() => this.buildShortcuts()));
  }

  private listenForAutoRefresh() {
    listen<string[]>("sources-auto-refreshed", (event) => {
      this.ngZone.run(() => {
        this.error.info(
          this.translate.instant("TOAST.SOURCES_REFRESHED", { sources: event.payload.join(", ") }),
        );
        this.memory.Refresh.next(false);
      });
    })
      .then((unlisten) => {
        // Destroyed before the listener was registered: drop it right away.
        if (this.destroyed) unlisten();
        else this.autoRefreshUnlisten = unlisten;
      })
      .catch((e) => console.error(e));
  }

  getSources() {
    let get_settings = invoke("get_settings");
    let get_sources = invoke("get_sources");
    Promise.all([get_settings, get_sources])
      .then((data) => {
        let settings = data[0] as Settings;
        let sources = data[1] as Source[];
        if (settings.zoom)
          getCurrentWebview()
            .setZoom(Math.trunc(settings.zoom! * 100) / 10000)
            .catch((e) => console.error(e));
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.ShowChannelSource = settings.show_channel_source ?? true;
        this.memory.UseExternalPlayer = settings.use_external_player ?? false;
        this.memory.CountryPrefixMode = toCountryPrefixMode(settings.country_prefix);
        // Best effort: without it the lock button stays hidden.
        this.memory.refreshParental().catch((e) => console.error(e));
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map((s) => [s.id!, s]));
        this.hasXtream = this.anyXtream();
        if (sources.length == 0) this.reset();
        else {
          sources
            .filter((x) => x.source_type == SourceType.Custom)
            .map((x) => x.id!)
            .forEach((x) => this.memory.CustomSourceIds?.add(x));
          sources
            .filter((x) => x.source_type == SourceType.Xtream)
            .map((x) => x.id!)
            .forEach((x) => this.memory.XtreamSourceIds.add(x));
          if (
            this.memory.XtreamSourceIds.size > 0 &&
            !sessionStorage.getItem("epgCheckedOnStart")
          ) {
            sessionStorage.setItem("epgCheckedOnStart", "true");
            // Best-effort background check; nothing the user started.
            invoke("on_start_check_epg").catch((e) => console.error(e));
          }
          // Always publish the sort, also the provider default, so the sort
          // menu's check mark matches the list.
          const sort: SortType = settings.default_sort ?? SortType.provider;
          this.filters = {
            source_ids: Array.from(this.memory.Sources.keys()),
            view_type: settings.default_view ?? ViewMode.All,
            media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
            page: 1,
            use_keywords: false,
            sort: sort,
          };
          this.memory.Sort.next([sort, false]);
          this.chkSerie = this.hasXtream;
          if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
            sessionStorage.setItem("refreshedOnStart", "true");
            this.refreshOnStart().then((_) => _);
          }
          this.load().then((_) => _);
          this.loadCountries();
        }
      })
      .catch((e) => {
        this.error.handleError(e);
        this.reset();
      });
  }

  async refreshOnStart() {
    this.toast.info(this.translate.instant("TOAST.REFRESH_ON_START"));
    await this.memory.tryIPC(
      this.translate.instant("TOAST.REFRESH_ON_START_SUCCESS"),
      this.translate.instant("TOAST.REFRESH_ON_START_FAILED"),
      async () => {
        await invoke("refresh_all");
      },
    );
  }

  async reload() {
    await this.load();
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  async addEvents() {
    this.subscriptions.push(
      this.memory.HideChannels.subscribe((val) => {
        this.channelsVisible = val;
      }),
    );
    this.subscriptions.push(
      this.memory.SetFocus.subscribe((focus) => {
        this.focus = focus;
      }),
    );
    this.subscriptions.push(
      this.memory.SetNode.subscribe(async (dto) => {
        // A double click on a category/series must not push the same level
        // twice.
        const top = this.nodeStack.get();
        if (top && top.id === dto.id && top.type === dto.type) return;
        this.nodeStack.add(
          new Node(dto.id, dto.name, dto.type, this.filters?.query, this.filters?.view_type),
        );
        if (dto.type == NodeType.Category) this.filters!.group_id = dto.id;
        else if (dto.type == NodeType.Series) {
          this.filters!.series_id = dto.id;
          this.filters!.source_ids = [dto.sourceId!];
        } else if (dto.type == NodeType.Season) this.filters!.season = dto.id;

        this.clearSearch();
        await this.load();
        if (this.focusArea == FocusArea.Tiles) this.selectFirstChannelDelayed(100);
      }),
    );
    this.subscriptions.push(
      this.memory.Refresh.subscribe((scroll) => {
        this.load();
        // A refresh or an edited source can bring or drop country prefixes.
        this.loadCountries();
        if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
      }),
    );
    this.subscriptions.push(
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters!.sort = sort;
        await this.load();
      }),
    );
  }

  clearSearch() {
    this.search.nativeElement.value = "";
    this.prevSearchValue = "";
    this.filters!.query = "";
  }

  /**
   * Loads the next page. Automatic triggers (scrolling, keyboard navigation)
   * stop after a failure; `explicit` (the "Load more" button) retries.
   */
  async loadMore(explicit = false) {
    if (!this.filters || this.loading || this.reachedMax) return;
    if (this.loadMoreFailed && !explicit) return;
    await this.load(true);
  }

  async load(more = false) {
    if (!this.filters) return;
    // Every load gets a sequence number; a response that arrives after a newer
    // load started (e.g. the query changed) is dropped, so an old page 2 is
    // never appended to a new page 1.
    const seq = ++this.loadSeq;
    const page = more ? this.filters.page + 1 : 1;
    // The page is only committed once it loaded: a failed request must not
    // skip a page (or grow it forever) on the next attempt.
    const filters: Filters = {
      ...this.filters,
      page,
      show_locked: this.memory.ShowLocked,
      country: this.countryApplies() ? this.filters.country : undefined,
    };
    this.loading = true;
    if (!more) {
      this.gridLoading = true;
      this.loadMoreFailed = false;
    }
    try {
      let channels: Channel[] = await invoke("search", { filters });
      if (seq !== this.loadSeq) return;
      this.filters.page = page;
      if (!more) {
        this.channels = channels;
        this.channelsVisible = true;
        // prevent flicker of hiding opacity
        this.viewType = this.filters.view_type;
      } else {
        this.channels = this.channels.concat(channels);
      }
      // Mirror the directly-playable channels so the embedded player's side
      // list can switch channels without returning to the grid. The guide
      // publishes its own rows while it is shown.
      if (this.panel === "library") {
        this.memory.PlayerChannelList = this.channels.filter(
          (c) => c.media_type === MediaType.livestream || c.media_type === MediaType.movie,
        );
      }
      this.reachedMax = channels.length < this.PAGE_SIZE;
      this.loadMoreFailed = false;
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.error.handleError(e);
      if (more) {
        this.loadMoreFailed = true;
      } else {
        // A failed first page: the list shown belongs to the previous query,
        // so paging must not continue from that query's page count.
        this.channels = [];
        this.filters.page = 1;
        this.reachedMax = true;
        this.channelsVisible = true;
      }
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        this.gridLoading = false;
      }
    }
  }

  /** Runs outside the Angular zone (see ngOnInit). */
  private onScroll() {
    const scrollPosition =
      window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    const showScrollTop = scrollPosition > 300;
    if (showScrollTop !== this.showScrollTop) {
      this.ngZone.run(() => (this.showScrollTop = showScrollTop));
    }
    if (this.isNearScrollEnd()) {
      this.ngZone.run(() => this.loadMore());
    }
  }

  private isNearScrollEnd(): boolean {
    if (this.reachedMax || this.loading || this.loadMoreFailed || !this.filters) return false;
    if (this.panel !== "library") return false;
    if (this.memory.PlayerVisible) return false;
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const clientHeight = window.innerHeight || document.documentElement.clientHeight;
    return scrollTop + clientHeight >= scrollHeight * 0.75;
  }

  ngAfterViewInit(): void {
    this.addEvents().then((_) => _);
    this.subscriptions.push(
      fromEvent(this.search.nativeElement, "keyup")
        .pipe(
          filter((event: any) => event.key !== "Escape"),
          map((event: any) => {
            this.focus = 0;
            this.focusArea = FocusArea.Tiles;
            if (this.channelsVisible && event.target.value != this.prevSearchValue)
              this.channelsVisible = false;
            this.prevSearchValue = event.target.value;
            return event.target.value;
          }),
          debounceTime(300),
        )
        .subscribe(async (term: string) => {
          this.filters!.query = term;
          await this.load();
        }),
    );
  }

  /// True while keyboard input belongs to something above the home page: the
  /// embedded player or any modal (tracked in memory.ModalRef or not).
  keyboardBlocked(): boolean {
    return this.memory.PlayerVisible || this.modal.hasOpenModals();
  }

  private buildShortcuts() {
    const t = (key: string) => this.translate.instant(key);
    const guarded =
      (action: () => unknown) =>
      (_: unknown): void => {
        if (this.keyboardBlocked()) return;
        action();
      };
    // Alt/Ctrl + letter or digit. AltGr arrives as Ctrl+Alt, and the library
    // matches modifiers loosely, so on e.g. a German layout AltGr+Q ("@") or
    // AltGr+E ("€") typed into the search box would trigger these. They leave
    // preventDefault to this wrapper, so such keystrokes still type.
    const modified =
      (action: () => unknown) =>
      (output: { event: Event }): void => {
        const event = output.event as KeyboardEvent;
        if (event.getModifierState?.("AltGraph") || (event.ctrlKey && event.altKey)) return;
        event.preventDefault();
        guarded(action)(output);
      };
    this.shortcuts = [
      {
        key: ["ctrl + f", "ctrl + space", "cmd + f"],
        label: t("SHORTCUT.SEARCH"),
        description: t("SHORTCUT.GO_TO_SEARCH"),
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: guarded(() => this.focusSearch()),
      },
      // View switching on Alt+1..4 (the former Ctrl+A/S/D/R collided with
      // select all, save, bookmark and reload).
      {
        key: "alt + 1",
        label: t("SHORTCUT.SWITCHING_MODES"),
        description: t("SHORTCUT.SELECT_ALL"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => this.switchMode(ViewMode.All)),
      },
      {
        key: "alt + 2",
        label: t("SHORTCUT.SWITCHING_MODES"),
        description: t("SHORTCUT.SELECT_CATEGORIES"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => this.switchMode(ViewMode.Categories)),
      },
      {
        key: "alt + 3",
        label: t("SHORTCUT.SWITCHING_MODES"),
        description: t("SHORTCUT.SELECT_FAVORITES"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => this.switchMode(ViewMode.Favorites)),
      },
      {
        key: "alt + 4",
        label: t("SHORTCUT.SWITCHING_MODES"),
        description: t("SHORTCUT.SELECT_HISTORY"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => this.switchMode(ViewMode.History)),
      },
      // Media filters on Alt+Q/W/E (Ctrl+W closes windows); the
      // non-colliding Ctrl+Q / Ctrl+E keep working.
      {
        key: ["alt + q", "ctrl + q"],
        label: t("SHORTCUT.MEDIA_FILTERS"),
        description: t("SHORTCUT.TOGGLE_LIVESTREAMS"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => {
          this.chkLiveStream = !this.chkLiveStream;
          this.updateMediaTypes(MediaType.livestream);
        }),
      },
      {
        key: "alt + w",
        label: t("SHORTCUT.MEDIA_FILTERS"),
        description: t("SHORTCUT.TOGGLE_MOVIES"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => {
          this.chkMovie = !this.chkMovie;
          this.updateMediaTypes(MediaType.movie);
        }),
      },
      {
        key: ["alt + e", "ctrl + e"],
        label: t("SHORTCUT.MEDIA_FILTERS"),
        description: t("SHORTCUT.TOGGLE_SERIES"),
        preventDefault: false,
        allowIn: [AllowIn.Input],
        command: modified(() => {
          this.chkSerie = !this.chkSerie;
          this.updateMediaTypes(MediaType.serie);
        }),
      },
      {
        key: "f",
        label: t("SHORTCUT.TILE_ACTIONS"),
        description: t("SHORTCUT.TOGGLE_FAVORITE"),
        command: guarded(() => this.toggleFocusedFavorite()),
      },
      {
        // Listed for the help overlay only: the ContextMenu key and Shift+F10
        // are handled in onKeyDown (the library can't bind the ContextMenu key).
        key: "shift + f10",
        label: t("SHORTCUT.TILE_ACTIONS"),
        description: t("SHORTCUT.OPEN_CONTEXT_MENU"),
        command: () => {},
      },
      {
        key: "left",
        label: t("SHORTCUT.NAVIGATION"),
        description: t("SHORTCUT.GO_LEFT"),
        allowIn: [AllowIn.Input],
        command: guarded(() => this.nav("ArrowLeft")),
      },
      {
        key: "right",
        label: t("SHORTCUT.NAVIGATION"),
        description: t("SHORTCUT.GO_RIGHT"),
        allowIn: [AllowIn.Input],
        command: guarded(() => this.nav("ArrowRight")),
      },
      {
        key: "up",
        label: t("SHORTCUT.NAVIGATION"),
        description: t("SHORTCUT.GO_UP"),
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: guarded(() => this.nav("ArrowUp")),
      },
      {
        key: "down",
        label: t("SHORTCUT.NAVIGATION"),
        description: t("SHORTCUT.GO_DOWN"),
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: guarded(() => this.nav("ArrowDown")),
      },
    ];
  }

  updateMediaTypes(mediaType: MediaType) {
    // "Continue watching" always shows movies/episodes only; the pills are
    // hidden there and the shortcuts must not change it either.
    if (this.continueWatching || this.panel !== "library") return;
    let index = this.filters!.media_types.indexOf(mediaType);
    if (index == -1) this.filters!.media_types.push(mediaType);
    else this.filters!.media_types.splice(index, 1);
    this.load();
  }

  /**
   * Loads the country prefixes of the enabled sources (what the top level
   * shows; inside a series `filters.source_ids` is narrowed to one source,
   * where the filter does not apply). A selected country that is no longer
   * offered (or when there is nothing left to choose from) is dropped and the
   * list reloaded without it.
   */
  async loadCountries() {
    if (!this.filters) return;
    const seq = ++this.countriesSeq;
    const sourceIds = Array.from(this.memory.Sources.keys());
    let countries: CountryCount[] = [];
    try {
      countries =
        (await invoke<CountryCount[]>("get_countries", {
          sourceIds,
          // Codes that only occur in locked groups stay secret without the PIN.
          showLocked: this.memory.ShowLocked,
        })) ?? [];
    } catch (e) {
      // Best effort: without it the country filter stays hidden.
      console.error(e);
    }
    if (seq !== this.countriesSeq || !this.filters) return;
    this.countries = countries.length >= 2 ? countries : [];
    const selected = this.filters.country;
    if (selected && !this.countries.some((c) => c.code === selected)) {
      this.filters.country = undefined;
      if (this.countryApplies()) await this.load();
    }
  }

  /// Inside a category or series the names often carry no prefix: the
  /// filter only narrows the top level (channels or the category list).
  countryApplies(): boolean {
    return !this.filters?.group_id && !this.filters?.series_id;
  }

  countryFilterVisible(): boolean {
    return this.panel === "library" && this.countries.length >= 2 && this.countryApplies();
  }

  setCountry(code: string) {
    if (!this.filters) return;
    const country = code || undefined;
    if (country === this.filters.country) return;
    this.filters.country = country;
    this.load();
  }

  filtersVisible() {
    return !this.filters?.series_id && !this.continueWatching && this.panel === "library";
  }

  async switchMode(viewMode: ViewMode, continueWatching = false) {
    if (!this.filters) return;
    const sameMode =
      viewMode == this.filters.view_type && continueWatching === this.continueWatching;
    if (this.panel !== "library") {
      this.panel = "library";
      // Back to the view that was open before the guide/recordings: keep its
      // position (group, query), just reload it.
      if (sameMode) {
        await this.load();
        return;
      }
    } else if (sameMode) return;
    if (continueWatching !== this.continueWatching) {
      if (continueWatching) {
        this.savedMediaTypes = [...this.filters.media_types];
        this.filters.media_types = [MediaType.movie];
      } else if (this.savedMediaTypes) {
        this.filters.media_types = this.savedMediaTypes;
        this.savedMediaTypes = undefined;
      }
      this.continueWatching = continueWatching;
    }
    this.filters.series_id = undefined;
    this.filters.group_id = undefined;
    this.filters.view_type = viewMode;
    this.filters.season = undefined;
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.clearSearch();
    this.nodeStack.clear();
    await this.load();
  }

  searchFocused(): boolean {
    return document.activeElement?.id == "search";
  }

  focusSearch() {
    if (this.searchFocused()) {
      this.selectFirstChannel();
      return;
    } else {
      this.focus = 0;
      this.focusArea = FocusArea.Tiles;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    this.search.nativeElement.focus({
      preventScroll: true,
    });
  }

  /// Escape in a modal: close the tracked one, unless it is a running
  /// re-stream (closing that would orphan the stream).
  private closeTrackedModal() {
    const ref = this.memory.ModalRef;
    if (!ref) return;
    if (ref.componentInstance.name != "RestreamModalComponent" || !ref.componentInstance.started)
      ref.close("close");
  }

  async goBackHotkey() {
    if (this.memory.currentContextMenu?.menuOpen) {
      this.closeContextMenu();
    } else if (this.searchFocused()) {
      this.selectFirstChannel();
    } else if (this.filters?.query) {
      this.clearSearch();
      await this.load();
      this.selectFirstChannelDelayed(100);
    } else if (this.nodeStack.hasNodes()) {
      if (this.navigatingBack) return;
      await this.goBack();
      this.selectFirstChannelDelayed(100);
    } else {
      this.selectFirstChannel();
    }
  }

  selectFirstChannelDelayed(milliseconds: number) {
    setTimeout(() => this.selectFirstChannel(), milliseconds);
  }

  async goBack() {
    // Holding Backspace (or clicking the arrow repeatedly) must not pop two
    // levels at once or pop an empty stack.
    if (this.navigatingBack || !this.nodeStack.hasNodes() || !this.filters) return;
    this.navigatingBack = true;
    try {
      const node = this.nodeStack.pop();
      if (node.type == NodeType.Category) this.filters.group_id = undefined;
      else if (node.type == NodeType.Series) {
        this.filters.series_id = undefined;
        this.filters.source_ids = Array.from(this.memory.Sources.keys());
      } else if (node.type == NodeType.Season) {
        this.filters.season = undefined;
      }
      if (node.query) {
        this.search.nativeElement.value = node.query;
        this.filters.query = node.query;
      }
      if (node.fromViewType && this.filters.view_type !== node.fromViewType) {
        this.filters.view_type = node.fromViewType;
      }
      await this.load();
    } finally {
      this.navigatingBack = false;
    }
  }

  /** Shows the TV guide or the recordings instead of the channel library. */
  showPanel(panel: Exclude<HomePanel, "library">) {
    if (!this.filters || this.panel === panel) return;
    if (panel === "guide") {
      const group = this.filters.group_id;
      const node = this.nodeStack.findLast(NodeType.Category);
      this.guideGroup =
        group !== undefined ? { id: group, name: node?.name ?? String(group) } : undefined;
    }
    this.panel = panel;
    // The panels handle their own keys; a stale focus area must not act there.
    this.focusArea = FocusArea.ViewMode;
    this.showScrollTop = false;
    window.scrollTo({ top: 0, behavior: "instant" });
    // The player's side list mirrors the shown channels: the guide publishes
    // its own rows, the recordings have none.
    this.memory.PlayerChannelList = [];
  }

  /** Home toolbar lock: show the locked groups (after the PIN) or hide them. */
  async toggleLocked() {
    if (await this.parental.toggleShowLocked()) {
      await this.load();
      this.loadCountries();
    }
  }

  openSettings() {
    this.router.navigateByUrl("settings");
  }

  async nav(key: string) {
    if (this.keyboardBlocked() || this.searchFocused()) return;
    if (this.memory.currentContextMenu?.menuOpen) return;
    if (this.panel !== "library") {
      this.navSidebarOnly(key);
      return;
    }
    // Focus may have moved by Tab or mouse since the last arrow key.
    this.syncFocusFromDom();
    let tmpFocus = 0;
    switch (key) {
      case "ArrowUp":
        tmpFocus -= this.focusArea == FocusArea.Tiles ? this.gridColumns() : 1;
        break;
      case "ArrowDown":
        tmpFocus += this.focusArea == FocusArea.Tiles ? this.gridColumns() : 1;
        break;
      case "ArrowLeft":
        tmpFocus -= 1;
        break;
      case "ArrowRight":
        tmpFocus += 1;
        break;
    }
    let goOverSize = this.shortFiltersMode() ? 1 : 2;
    tmpFocus += this.focus;
    if (tmpFocus < 0) {
      this.changeFocusArea(false);
    } else if (tmpFocus > goOverSize && this.focusArea == FocusArea.Filters) {
      this.changeFocusArea(true);
    } else if (tmpFocus > NAV_ITEM_COUNT - 1 && this.focusArea == FocusArea.ViewMode) {
      this.changeFocusArea(true);
    } else if (
      this.focusArea == FocusArea.Tiles &&
      tmpFocus >= this.filters!.page * this.PAGE_SIZE &&
      !this.reachedMax &&
      !this.loadMoreFailed
    )
      await this.loadMore();
    else {
      if (tmpFocus >= this.channels.length && this.focusArea == FocusArea.Tiles)
        tmpFocus = (this.channels.length == 0 ? 1 : this.channels.length) - 1;
      this.focus = tmpFocus;
      setTimeout(() => {
        document.getElementById(`${FocusAreaPrefix[this.focusArea]}${this.focus}`)?.focus();
      }, 0);
    }
  }

  /// The guide and the recordings handle their own keys; arrow keys only move
  /// within the sidebar there.
  private navSidebarOnly(key: string) {
    const prefix = FocusAreaPrefix[FocusArea.ViewMode];
    const id = (document.activeElement as HTMLElement | null)?.id ?? "";
    if (!id.startsWith(prefix)) return;
    const index = Number(id.slice(prefix.length));
    if (!Number.isInteger(index)) return;
    const delta = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    const next = Math.min(NAV_ITEM_COUNT - 1, Math.max(0, index + delta));
    this.focusArea = FocusArea.ViewMode;
    this.focus = next;
    document.getElementById(`${prefix}${next}`)?.focus();
  }

  /// Picks up the focus area/index from the focused element's id.
  private syncFocusFromDom() {
    const id = (document.activeElement as HTMLElement | null)?.id ?? "";
    for (const area of [FocusArea.ViewMode, FocusArea.Filters, FocusArea.Tiles]) {
      const prefix = FocusAreaPrefix[area];
      if (!id.startsWith(prefix)) continue;
      const index = Number(id.slice(prefix.length));
      if (Number.isInteger(index)) {
        this.focusArea = area;
        this.focus = index;
      }
      return;
    }
  }

  /// Columns of the tile grid, measured from the DOM so it always matches the
  /// responsive CSS grid: the number of tiles sharing the first tile's row.
  gridColumns(): number {
    if (this.viewFormat === "list") return 1;
    const children = this.tileGrid?.nativeElement.children;
    if (!children || children.length === 0) return 1;
    const firstTop = (children[0] as HTMLElement).offsetTop;
    let count = 0;
    for (let i = 0; i < children.length; i++) {
      if ((children[i] as HTMLElement).offsetTop !== firstTop) break;
      count++;
    }
    return Math.max(1, count);
  }

  shortFiltersMode() {
    return this.filters?.source_ids.findIndex((x) => this.memory.XtreamSourceIds.has(x)) == -1;
  }

  anyXtream() {
    return (
      Array.from(this.memory.Sources.values()).findIndex(
        (x) => x.source_type == SourceType.Xtream,
      ) != -1
    );
  }

  changeFocusArea(down: boolean) {
    let increment = down ? 1 : -1;
    this.focusArea += increment;
    if (this.focusArea == FocusArea.Filters && !this.filtersVisible()) this.focusArea += increment;
    if (this.focusArea < 0) this.focusArea = 0;
    this.applyFocusArea(down);
  }

  applyFocusArea(down: boolean) {
    this.focus = down
      ? 0
      : this.focusArea == FocusArea.Filters
        ? this.shortFiltersMode()
          ? 1
          : 2
        : NAV_ITEM_COUNT - 1;
    let id = FocusAreaPrefix[this.focusArea] + this.focus;
    document.getElementById(id)?.focus();
  }

  /// The tile component whose element currently has keyboard focus.
  private focusedTile(): ChannelTileComponent | undefined {
    const id = (document.activeElement as HTMLElement | null)?.id ?? "";
    const prefix = FocusAreaPrefix[FocusArea.Tiles];
    if (!id.startsWith(prefix)) return undefined;
    const index = Number(id.slice(prefix.length));
    return this.tiles?.find((tile) => tile.id === index);
  }

  private toggleFocusedFavorite() {
    const tile = this.focusedTile();
    if (tile?.canFavorite()) tile.favorite();
  }

  //Temporary solution because the ng-keyboard-shortcuts library doesn't seem to support ESC
  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    // Already handled (mat-menu closing itself, the player, ...).
    if (event.defaultPrevented) return;
    // The player overlay owns the keyboard while it is shown.
    if (this.memory.PlayerVisible) return;
    const isBackKey =
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !isInputFocused());
    if (this.modal.hasOpenModals()) {
      // Escape belongs to the modal; it must not also navigate back here.
      if (isBackKey && event.key != "Backspace") this.closeTrackedModal();
      return;
    }
    if (isBackKey) {
      event.preventDefault();
      // Holding the key must not fire one navigation per key repeat.
      if (!event.repeat) this.goBackHotkey();
      return;
    }
    if (event.key == "ContextMenu" || (event.shiftKey && event.key == "F10")) {
      const tile = this.focusedTile();
      if (tile) {
        event.preventDefault();
        tile.openContextMenuFromKeyboard();
      }
      return;
    }
    if (event.key == "Enter" && this.focusArea == FocusArea.Filters && this.panel === "library")
      (document.activeElement as any).click();
  }

  selectFirstChannel() {
    this.focusArea = FocusArea.Tiles;
    this.focus = 0;
    (document.getElementById("first")?.firstChild as HTMLElement)?.focus();
  }

  closeContextMenu() {
    if (this.memory.currentContextMenu?.menuOpen) {
      this.memory.currentContextMenu?.closeMenu();
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    if (this.scrollListener) window.removeEventListener("scroll", this.scrollListener);
    this.subscriptions.forEach((x) => x.unsubscribe());
    this.autoRefreshUnlisten?.();
  }
}
