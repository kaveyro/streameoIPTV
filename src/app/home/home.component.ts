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
import { AllowIn, ShortcutInput, KeyboardShortcutsModule } from "ng-keyboard-shortcuts";
import { Subscription, debounceTime, filter, fromEvent, map, skip, take } from "rxjs";
import { MemoryService, RemovedTile } from "../memory.service";
import { NowPlayingService } from "../now-playing.service";
import { WatchProgressService } from "../watch-progress.service";
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
import { animate, style, transition, trigger } from "@angular/animations";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { ZoomService } from "../zoom.service";
import { SORT_TYPES, SortType } from "../models/sortType";
import { NgbModal, NgbTooltipModule } from "@ng-bootstrap/ng-bootstrap";
import { LIBRARY_SORT, SIDEBAR_COLLAPSED } from "../models/localStorage";
import { isInputFocused } from "../utils";
import { Node } from "../models/node";
import { NodeType } from "../models/nodeType";
import { Stack } from "../models/stack";
import { VIEW_FORMAT, ViewFormat } from "../models/viewFormat";
import { TranslateService, TranslatePipe } from "@ngx-translate/core";
import { ChannelTileComponent, setHidden } from "../channel-tile/channel-tile.component";
import { EditChannelModalComponent } from "../edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "../edit-group-modal/edit-group-modal.component";
import { ParentalService } from "../parental.service";
import { CountryCount } from "../models/epgExtras";
import { toCountryPrefixMode } from "../country-prefix";
import { CdkDragDrop, moveItemInArray, DragDropModule } from "@angular/cdk/drag-drop";
import { FavoriteList, FavoriteListsService } from "../favorite-lists/favorite-lists.service";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { SortButtonComponent } from "./sort-button/sort-button.component";
import { FavoriteListChipsComponent } from "../favorite-lists/favorite-list-chips/favorite-list-chips.component";
import { TvGuideComponent } from "../tv-guide/tv-guide.component";
import { RecordingsComponent } from "../recordings/recordings.component";
import { MatMenuModule } from "@angular/material/menu";
import { ConfirmService } from "../confirm.service";
import { BulkActionType } from "../models/bulkActionType";

/// What the main area shows: the channel library (all view modes, also
/// "continue watching"), the TV guide or the recordings. Frontend only; the
/// backend view_type is only used by `search`.
export type HomePanel = "library" | "guide" | "recordings";

/// Number of sidebar nav items (ids viewMode-0 .. viewMode-7).
const NAV_ITEM_COUNT = 8;

/// Automatic loading goes on while the end of the list is less than this
/// many viewport heights below the top of the viewport.
const FILL_VIEWPORTS = 1.3;

/// Going back loads at most this many pages again to restore the scroll
/// position (36 tiles each); further down, the list starts shorter.
const MAX_RESTORED_PAGES = 10;

@Component({
  selector: "app-home",
  imports: [
    CommonModule,
    FormsModule,
    TranslatePipe,
    NgbTooltipModule,
    DragDropModule,
    KeyboardShortcutsModule,
    ChannelTileComponent,
    SortButtonComponent,
    FavoriteListChipsComponent,
    TvGuideComponent,
    RecordingsComponent,
    MatMenuModule,
  ],
  templateUrl: "./home.component.html",
  styleUrls: [
    "./home.component.css",
    "./home-search.css",
    "./home-heading.css",
    "./home-states.css",
  ],
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
  ],
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {
  channels: Channel[] = [];
  readonly viewModeEnum = ViewMode;
  readonly mediaTypeEnum = MediaType;
  readonly bulkActionEnum = BulkActionType;
  @ViewChild("search") search!: ElementRef;
  @ViewChild("tileGrid") tileGrid?: ElementRef<HTMLElement>;
  /// Marks the end of the list: when it comes near the viewport, the next
  /// page loads (also when the first page fits and nothing scrolls).
  @ViewChild("sentinel") set sentinel(ref: ElementRef<HTMLElement> | undefined) {
    if (ref?.nativeElement === this.sentinelElement) return;
    if (this.sentinelElement) this.endObserver?.unobserve(this.sentinelElement);
    this.sentinelElement = ref?.nativeElement;
    if (this.sentinelElement) this.endObserver?.observe(this.sentinelElement);
  }
  private sentinelElement?: HTMLElement;
  private endObserver?: IntersectionObserver;
  @ViewChildren(ChannelTileComponent) tiles?: QueryList<ChannelTileComponent>;
  shortcuts: ShortcutInput[] = [];
  focus = 0;
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
  prevSearchValue = "";
  /// A typed search is waiting for its debounce or its results: the old
  /// results stay, dimmed, and the search box shows a spinner.
  searchPending = false;
  /// What the search box holds (for its clear button).
  searchText = "";
  loading = false;
  /// The first page of the current view failed to load: an error with a
  /// retry button is shown instead of the "nothing found" state.
  loadFailed = false;
  gridLoading = false;
  readonly skeletons = Array(9);
  nodeStack: Stack = new Stack();
  showScrollTop = false;
  viewFormat: ViewFormat = this.loadViewFormat();
  /// Whether any enabled source is an Xtream one; cached when the sources load
  /// instead of being recomputed on every change detection.
  hasXtream = false;
  /// Sources exist, but none is enabled: the list stays empty until one is.
  allSourcesDisabled = false;
  /// Tiles dropped in place (RemoveTile) since the last page loaded: the
  /// backend's pages moved up by as many, so the next "load more" fetches
  /// the last page again instead of skipping what moved onto it.
  private removedSinceLoad = 0;
  /// The settings' default sort (see storedSort).
  private defaultSort: SortType = SortType.provider;
  /// restorePosition() is loading the pages of a level: no automatic loads
  /// in between, they would supersede it.
  private restoring = false;
  private fillTimer?: ReturnType<typeof setTimeout>;
  private resizeListener?: () => void;
  /// The multi-selection (Ctrl/Cmd/Shift + click), by trackByChannel key.
  selection = new Map<string, Channel>();
  private autoRefreshUnlisten?: UnlistenFn;
  private destroyed = false;
  /// Sequence number of the latest load(); older responses are dropped.
  private loadSeq = 0;
  /// A goBack() is still loading its level; ignore further back presses.
  private navigatingBack = false;
  private scrollListener?: () => void;
  sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED) === "true";
  /// Below 768px the sidebar is a top bar without labels (home.component.css).
  private readonly narrowQuery = window.matchMedia("(max-width: 767.98px)");
  narrow = this.narrowQuery.matches;
  private readonly narrowListener = (event: MediaQueryListEvent) =>
    this.ngZone.run(() => (this.narrow = event.matches));
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
  /// The favorites lists, as chips above the favorites view.
  favoriteListItems: FavoriteList[] = [];
  /// Sort and favorites list of the shown channels (committed with them, like
  /// viewType), so drag & drop matches what is on screen.
  private shownSort?: SortType;
  shownFavoriteList?: number;

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
    return channel.id === undefined ? `i${index}` : HomeComponent.key(channel);
  }

  /// Channels and groups (the hidden view lists both) can share an id.
  private static key(channel: Channel): string {
    return `${channel.media_type}:${channel.id}`;
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
    private favoriteLists: FavoriteListsService,
    private watchProgress: WatchProgressService,
    private zoom: ZoomService,
    private confirm: ConfirmService,
  ) {
    this.getSources();
    this.listenForAutoRefresh();
    this.nowPlaying.init();
    this.watchProgress.init();
  }

  ngOnInit(): void {
    // Scroll events fire at a high rate: handle them outside Angular and only
    // re-enter the zone when something bound actually changes.
    this.ngZone.runOutsideAngular(() => {
      this.scrollListener = () => this.onScroll();
      window.addEventListener("scroll", this.scrollListener, { passive: true });
      // A taller window can show more than the pages loaded so far.
      this.resizeListener = () => {
        if (this.canAutoLoad()) this.ngZone.run(() => this.scheduleFillCheck());
      };
      window.addEventListener("resize", this.resizeListener, { passive: true });
      if (typeof IntersectionObserver !== "undefined") {
        this.endObserver = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting) && this.canAutoLoad()) {
              this.ngZone.run(() => this.scheduleFillCheck());
            }
          },
          { rootMargin: `0px 0px ${Math.round((FILL_VIEWPORTS - 1) * 100)}% 0px` },
        );
        if (this.sentinelElement) this.endObserver.observe(this.sentinelElement);
      }
    });
    this.narrowQuery.addEventListener("change", this.narrowListener);
    this.buildShortcuts();
    // The help labels are translated: rebuild them once the language file is
    // loaded (it may still be loading when the home page opens) or switched.
    this.subscriptions.push(this.translate.onLangChange.subscribe(() => this.buildShortcuts()));
    this.subscriptions.push(
      this.favoriteLists.lists
        .pipe(filter((lists): lists is FavoriteList[] => lists !== undefined))
        .subscribe((lists) => this.favoriteListsChanged(lists)),
    );
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

  getSources(): Promise<void> {
    this.loadFailed = false;
    const get_settings = invoke("get_settings");
    const get_sources = invoke("get_sources");
    return Promise.all([get_settings, get_sources])
      .then((data) => {
        const settings = data[0] as Settings;
        const sources = data[1] as Source[];
        // A shortcut's zoom that is not saved yet is newer than the stored one.
        if (settings.zoom && !this.zoom.savePending) this.zoom.apply(settings.zoom);
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.ShowChannelSource = settings.show_channel_source ?? true;
        this.memory.UseExternalPlayer = settings.use_external_player ?? false;
        this.memory.CountryPrefixMode = toCountryPrefixMode(settings.country_prefix);
        this.memory.AutoFallback = settings.auto_fallback ?? true;
        // Best effort: without it the lock button stays hidden.
        this.memory.refreshParental().catch((e) => console.error(e));
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map((s) => [s.id!, s]));
        this.allSourcesDisabled = sources.length > 0 && this.memory.Sources.size === 0;
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
          // menu's check mark matches the list. The last one chosen wins over
          // the settings' default, until that default is changed.
          this.defaultSort = settings.default_sort ?? SortType.provider;
          const sort: SortType = this.storedSort() ?? this.defaultSort;
          this.filters = {
            source_ids: Array.from(this.memory.Sources.keys()),
            view_type: settings.default_view ?? ViewMode.All,
            media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
            page: 1,
            use_keywords: false,
            sort: sort,
            favorite_list: this.favoriteLists.selected,
          };
          this.memory.Sort.next([sort, false]);
          this.chkSerie = this.hasXtream;
          if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
            sessionStorage.setItem("refreshedOnStart", "true");
            this.refreshOnStart().then((_) => _);
          }
          this.load().then((_) => _);
          this.loadCountries();
          // After the filters: a remembered list that is gone gets dropped.
          void this.favoriteLists.load();
        }
      })
      .catch((e) => {
        // A failed IPC call says nothing about the sources: offer a retry
        // (reload() runs this again) instead of sending the user to setup.
        this.error.handleError(e);
        this.loadFailed = true;
      });
  }

  async refreshOnStart() {
    this.toast.info(this.translate.instant("TOAST.REFRESH_ON_START"));
    // tryIPC resolves to true when the action failed.
    const failed = await this.memory.tryIPC(
      this.translate.instant("TOAST.REFRESH_ON_START_SUCCESS"),
      this.translate.instant("TOAST.REFRESH_ON_START_FAILED"),
      async () => {
        await invoke("refresh_all");
      },
    );
    // The list loaded in parallel shows the old data: load it again.
    if (!failed) this.memory.Refresh.next(false);
  }

  async reload() {
    // The start failed before the filters were set up: start over.
    if (!this.filters) await this.getSources();
    else await this.load();
  }

  /// The sort chosen last (localStorage may be unavailable or hold junk). It
  /// is stored with the settings' default it was chosen against: once that
  /// default changes, the new default applies again.
  private storedSort(): SortType | undefined {
    try {
      const stored = localStorage.getItem(LIBRARY_SORT);
      if (stored === null) return undefined;
      const [sort, base] = stored.split("|").map(Number) as [SortType, SortType];
      if (base !== this.defaultSort) return undefined;
      return SORT_TYPES.includes(sort) ? sort : undefined;
    } catch {
      return undefined;
    }
  }

  private storeSort(sort: SortType) {
    try {
      localStorage.setItem(LIBRARY_SORT, `${sort}|${this.defaultSort}`);
    } catch (e) {
      // Only the next start falls back to the default sort.
      console.error(e);
    }
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  async addEvents() {
    this.subscriptions.push(this.memory.RemoveTile.subscribe((tile) => this.removeTile(tile)));
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
        const node = new Node(
          dto.id,
          dto.name,
          dto.type,
          this.filters?.query,
          this.filters?.view_type,
          top,
        );
        // Kept for goBack(): how far the level being left was scrolled and
        // paged, and which tile the keyboard was on.
        node.page = this.filters?.page;
        node.tileIndex = this.focusedTile()?.id;
        this.nodeStack.add(node);
        this.clearSelection();
        if (dto.type == NodeType.Category) this.filters!.group_id = dto.id;
        else if (dto.type == NodeType.Series) {
          this.filters!.series_id = dto.id;
          this.filters!.source_ids = [dto.sourceId!];
        } else if (dto.type == NodeType.Season) this.filters!.season = dto.id;

        this.clearSearch();
        await this.load();
        // The new level starts at its top; the old position is restored on
        // the way back.
        window.scrollTo({ top: 0, behavior: "instant" });
        if (this.focusArea == FocusArea.Tiles) this.selectFirstChannelDelayed(100);
      }),
    );
    this.subscriptions.push(
      this.memory.Refresh.subscribe((scroll) => {
        // `scroll`: back to the top of a new first page (an edited channel or
        // category). Otherwise (a background refresh, a group (un)locked) the
        // list is refreshed where it is.
        if (scroll) {
          this.load();
          window.scrollTo({ top: 0, behavior: "instant" });
        } else {
          void this.refreshInPlace();
        }
        // A refresh or an edited source can bring or drop country prefixes.
        this.loadCountries();
      }),
    );
    this.subscriptions.push(
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters!.sort = sort;
        this.storeSort(sort);
        await this.load();
      }),
    );
  }

  /**
   * A tile left the list shown (RemoveTile): dropped without reloading, so
   * the scroll position and the loaded pages stay. The keyboard focus moves
   * on to the tile that takes its place.
   */
  removeTile(removed: RemovedTile) {
    if (!this.filters || this.panel !== "library") return;
    // Unfavorited: only gone where the favorites themselves are listed.
    if (
      removed.unfavorited &&
      (this.viewType !== ViewMode.Favorites ||
        this.filters.series_id !== undefined ||
        this.shownFavoriteList !== undefined)
    )
      return;
    const key = HomeComponent.key(removed.channel);
    const index = this.channels.findIndex(
      (c) => c.id !== undefined && HomeComponent.key(c) === key,
    );
    if (index === -1) return;
    const active = document.activeElement;
    const hadFocus =
      !active ||
      active === document.body ||
      active.id === `${FocusAreaPrefix[FocusArea.Tiles]}${index}`;
    this.channels = this.channels.filter((_, i) => i !== index);
    this.removedSinceLoad++;
    this.selection.delete(key);
    this.mirrorPlayerList();
    setTimeout(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (hadFocus && lost && this.channels.length > 0) {
        this.focusTile(Math.min(index, this.channels.length - 1));
      }
    }, 0);
    // The list may no longer fill the window.
    this.scheduleFillCheck();
  }

  /**
   * Loads the list again without leaving it: no skeletons, the pages loaded
   * so far are fetched again and shown at once, then the scroll position is
   * put back (a background refresh, a group locked or unlocked, ...).
   */
  async refreshInPlace() {
    if (!this.filters) return;
    // Nothing shown yet (or an error instead): a plain load is the same.
    if (this.gridLoading || this.loadFailed || this.panel !== "library") {
      await this.load();
      return;
    }
    const seq = ++this.loadSeq;
    const pages = Math.max(1, Math.min(this.filters.page, MAX_RESTORED_PAGES));
    const scrollY = window.scrollY;
    this.loading = true;
    try {
      let channels: Channel[] = [];
      let last: Channel[] = [];
      let page = 0;
      while (page < pages) {
        page++;
        last = await this.fetchPage(this.searchFilters(page));
        if (seq !== this.loadSeq) return;
        channels = channels.concat(last);
        if (last.length < this.PAGE_SIZE) break;
      }
      this.filters.page = page;
      this.channels = channels;
      this.reachedMax = last.length < this.PAGE_SIZE;
      this.removedSinceLoad = 0;
      this.loadMoreFailed = false;
      this.pruneSelection();
      this.mirrorPlayerList();
      // The tiles render after this change detection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (seq !== this.loadSeq || this.panel !== "library") return;
      window.scrollTo({ top: scrollY, behavior: "instant" });
    } catch (e) {
      // The list shown stays; only the refresh failed.
      if (seq === this.loadSeq) this.error.handleError(e);
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        this.scheduleFillCheck();
      }
    }
  }

  clearSearch() {
    this.setSearchValue("");
    this.prevSearchValue = "";
    this.filters!.query = "";
  }

  /// Writes the search box from code; `searchText` mirrors it for the clear
  /// button (the input itself is not bound).
  private setSearchValue(value: string) {
    this.search.nativeElement.value = value;
    this.searchText = value;
  }

  /** The search box's clear button: empties the query and reloads. */
  async clearSearchAndReload() {
    if (!this.filters) return;
    this.clearSearch();
    (this.search.nativeElement as HTMLInputElement).focus();
    await this.runSearch();
  }

  /// Loads the results of `filters.query`, keeping the old results (dimmed)
  /// until they are there.
  private async runSearch() {
    if (!this.filters) return;
    this.searchPending = true;
    const query = this.filters.query;
    await this.load(false, true);
    // A newer query is on its way: its own load clears the flag.
    if (this.filters.query === query && this.searchText === (query ?? "")) {
      this.searchPending = false;
    }
  }

  /// Enter in the search box: to the first result (searching right away when
  /// the debounce has not run yet).
  async onSearchEnter(event: Event) {
    if (!this.filters) return;
    event.preventDefault();
    const term = this.search.nativeElement.value as string;
    if (term !== (this.filters.query ?? "")) {
      this.filters.query = term;
      await this.runSearch();
    }
    this.enterResults();
  }

  /// Puts the focus on the first result; stays in the search box without one.
  private enterResults() {
    if (this.channels.length > 0) this.focusTile(0);
  }

  /// The search box's placeholder names where it searches: inside a category
  /// or series only there.
  searchScope(): string | undefined {
    return this.insideLevel() ? this.nodeStack.get()?.name : undefined;
  }

  /// Escape in a filled search box only empties it; with nothing to clear it
  /// goes on to the page's handler (onKeyDown), which leaves the box.
  onSearchEscape(event: Event) {
    if (!this.searchText || !this.filters) return;
    event.preventDefault();
    event.stopPropagation();
    void this.clearSearchAndReload();
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

  /// What `search` gets for one page of the current view.
  private searchFilters(page: number): Filters {
    return {
      ...this.filters!,
      page,
      show_locked: this.memory.ShowLocked,
      country: this.countryApplies() ? this.filters!.country : undefined,
    };
  }

  /// One page of results; nothing to search while every source is disabled.
  private async fetchPage(filters: Filters): Promise<Channel[]> {
    if (this.allSourcesDisabled) return [];
    return (await invoke<Channel[]>("search", { filters })) ?? [];
  }

  /**
   * Loads the first page (or with `more` the next one). `keepGrid`: the old
   * results stay on screen (dimmed by the caller) instead of skeletons, for a
   * new search term; skeletons are for a new view.
   */
  async load(more = false, keepGrid = false) {
    if (!this.filters) return;
    // More tiles dropped in place than one page holds: refetching the last
    // page would skip some, so reload the shown pages instead.
    if (more && this.removedSinceLoad >= this.PAGE_SIZE) {
      await this.refreshInPlace();
      return;
    }
    const removedAtStart = this.removedSinceLoad;
    // Every load gets a sequence number; a response that arrives after a newer
    // load started (e.g. the query changed) is dropped, so an old page 2 is
    // never appended to a new page 1.
    const seq = ++this.loadSeq;
    // After tiles were dropped in place the backend's pages moved up: fetch
    // the last page again (the known tiles on it are skipped below).
    const refetch = more && this.removedSinceLoad > 0;
    const page = more ? (refetch ? this.filters.page : this.filters.page + 1) : 1;
    // The page is only committed once it loaded: a failed request must not
    // skip a page (or grow it forever) on the next attempt.
    const filters = this.searchFilters(page);
    this.loading = true;
    if (!more) {
      if (!keepGrid) {
        this.gridLoading = true;
        // A new view replaces whatever search was on its way.
        this.searchPending = false;
      }
      this.loadMoreFailed = false;
    }
    try {
      const channels = await this.fetchPage(filters);
      if (seq !== this.loadSeq) return;
      this.filters.page = page;
      // Tiles dropped while this page loaded count for the next one.
      this.removedSinceLoad = Math.max(0, this.removedSinceLoad - removedAtStart);
      if (!more) {
        this.channels = channels;
        this.pruneSelection();
        // prevent flicker of hiding opacity
        this.viewType = this.filters.view_type;
        this.shownSort = filters.sort;
        this.shownFavoriteList =
          filters.view_type === ViewMode.Favorites && filters.series_id === undefined
            ? filters.favorite_list
            : undefined;
      } else if (refetch) {
        // The tiles of the refetched page that are shown already.
        const known = new Set(this.channels.map((c) => HomeComponent.key(c)));
        this.channels = this.channels.concat(
          channels.filter((c) => c.id === undefined || !known.has(HomeComponent.key(c))),
        );
      } else {
        this.channels = this.channels.concat(channels);
      }
      this.mirrorPlayerList();
      this.reachedMax = channels.length < this.PAGE_SIZE;
      this.loadMoreFailed = false;
      if (!more) this.loadFailed = false;
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
        this.loadFailed = true;
      }
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        this.gridLoading = false;
        // The first page may fit on screen: then nothing scrolls, and only
        // this check loads the next one.
        this.scheduleFillCheck();
      }
    }
  }

  /// Whether a page may load by itself (sentinel, resize, scrolling).
  private canAutoLoad(): boolean {
    return (
      !!this.filters &&
      !this.destroyed &&
      !this.reachedMax &&
      !this.loading &&
      !this.loadMoreFailed &&
      !this.restoring &&
      this.panel === "library" &&
      !this.memory.PlayerVisible
    );
  }

  /// Checks once the tiles rendered whether the list still ends within
  /// FILL_VIEWPORTS of the viewport, and loads the next page then (which
  /// checks again when it is in).
  private scheduleFillCheck() {
    if (this.fillTimer !== undefined || this.destroyed) return;
    this.fillTimer = setTimeout(() => {
      this.fillTimer = undefined;
      if (this.canAutoLoad() && this.sentinelNearViewport()) void this.loadMore();
    }, 0);
  }

  /** The end of the list is less than FILL_VIEWPORTS viewport heights down. */
  sentinelNearViewport(): boolean {
    const sentinel = this.sentinelElement;
    if (!sentinel || !sentinel.isConnected) return false;
    const viewport = window.innerHeight || document.documentElement.clientHeight;
    return sentinel.getBoundingClientRect().top <= viewport * FILL_VIEWPORTS;
  }

  /// Mirror the directly-playable channels so the embedded player's side
  /// list can switch channels without returning to the grid. The guide
  /// publishes its own rows while it is shown.
  private mirrorPlayerList() {
    if (this.panel !== "library") return;
    const following = this.memory.PlayerChannelList === this.memory.LibraryChannelList;
    this.memory.LibraryChannelList = this.channels.filter(
      (c) => c.media_type === MediaType.livestream || c.media_type === MediaType.movie,
    );
    if (following) this.memory.PlayerChannelList = this.memory.LibraryChannelList;
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
    if (!this.canAutoLoad()) return false;
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const clientHeight = window.innerHeight || document.documentElement.clientHeight;
    return scrollTop + clientHeight >= scrollHeight * 0.75;
  }

  ngAfterViewInit(): void {
    this.addEvents().then((_) => _);
    this.subscriptions.push(
      fromEvent<KeyboardEvent>(this.search.nativeElement, "keyup")
        .pipe(
          filter((event: KeyboardEvent) => event.key !== "Escape"),
          map((event: KeyboardEvent) => {
            const value = (event.target as HTMLInputElement).value;
            if (value != this.prevSearchValue) {
              this.focus = 0;
              this.focusArea = FocusArea.Tiles;
              // The old results stay, dimmed, until the new ones are in.
              this.searchPending = true;
            }
            this.prevSearchValue = value;
            return value;
          }),
          debounceTime(300),
        )
        .subscribe(async (term: string) => {
          // Cleared (button, Escape) while the term was still debouncing.
          if (term !== this.search.nativeElement.value || !this.filters) return;
          // Already searched (Enter), or typed and deleted again.
          if (term === (this.filters.query ?? "")) {
            if (!this.loading) this.searchPending = false;
            return;
          }
          this.filters.query = term;
          await this.runSearch();
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
        command: () => undefined,
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
    if (this.continueWatching || this.panel !== "library" || !this.filters) return;
    const index = this.filters.media_types.indexOf(mediaType);
    if (index != -1 && this.activePillCount() === 0) {
      // The last one was switched off (by shortcut; a click is stopped in
      // guardLastPill): nothing would be left to show.
      this.setPill(mediaType, true);
      this.toast.info(this.translate.instant("HOME.PILL.KEEP_ONE"));
      return;
    }
    if (index == -1) this.filters.media_types.push(mediaType);
    else this.filters.media_types.splice(index, 1);
    this.load();
  }

  /// Active media pills the user can see (series only exist with Xtream).
  private activePillCount(): number {
    return [this.chkLiveStream, this.chkMovie, this.hasXtream && this.chkSerie].filter(Boolean)
      .length;
  }

  /// The pills the user can see, with their labels.
  private pills(): { label: string; active: boolean }[] {
    const pills = [
      { label: "HOME.PILL.LIVESTREAMS", active: this.chkLiveStream },
      {
        label: this.hasXtream ? "HOME.PILL.MOVIES_VODS" : "HOME.PILL.MOVIES_VODS_SERIES",
        active: this.chkMovie,
      },
    ];
    if (this.hasXtream) pills.push({ label: "HOME.PILL.SERIES", active: this.chkSerie });
    return pills;
  }

  /**
   * The filters narrowing the list (for the empty state): the media types
   * when not all are on, and the country. Translated labels.
   */
  activeFilters(): string[] {
    if (!this.filters || !this.filtersVisible()) return [];
    const labels: string[] = [];
    const pills = this.pills();
    if (pills.some((p) => !p.active)) {
      labels.push(...pills.filter((p) => p.active).map((p) => this.translate.instant(p.label)));
    }
    if (this.countryApplies() && this.filters.country) {
      labels.push(this.translate.instant("EMPTY.FILTER_COUNTRY", { code: this.filters.country }));
    }
    return labels;
  }

  /** "Clear filters" in the empty state: all media types, all countries. */
  async clearFilters() {
    if (!this.filters) return;
    this.chkLiveStream = true;
    this.chkMovie = true;
    this.chkSerie = this.hasXtream;
    this.filters.media_types = [MediaType.livestream, MediaType.movie, MediaType.serie];
    this.filters.country = undefined;
    await this.load();
  }

  private setPill(mediaType: MediaType, active: boolean) {
    if (mediaType === MediaType.livestream) this.chkLiveStream = active;
    else if (mediaType === MediaType.movie) this.chkMovie = active;
    else if (mediaType === MediaType.serie) this.chkSerie = active;
  }

  /// The only active pill: switching it off would leave an empty list.
  isLastActivePill(active: boolean): boolean {
    return active && this.activePillCount() === 1;
  }

  /** Click on a pill's checkbox: the last active one stays on. */
  guardLastPill(event: Event, active: boolean) {
    if (!this.isLastActivePill(active)) return;
    // Keeps the box checked; no change event, so no reload either.
    event.preventDefault();
    this.toast.info(this.translate.instant("HOME.PILL.KEEP_ONE"));
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
  /// filter only narrows the top level (channels or the category list). The
  /// hidden view lists everything hidden.
  countryApplies(): boolean {
    return (
      !this.filters?.group_id &&
      !this.filters?.series_id &&
      this.filters?.view_type !== ViewMode.Hidden
    );
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

  /// The list chips: the favorites view at its top level (not inside a series).
  favoriteChipsVisible(): boolean {
    return this.isMode(ViewMode.Favorites) && this.filters?.series_id === undefined;
  }

  /** A chip was chosen: the favorites (undefined) or one of the lists. */
  async selectFavoriteList(id?: number) {
    if (!this.filters) return;
    this.favoriteLists.selected = id;
    if (this.filters.favorite_list === id) return;
    this.filters.favorite_list = id;
    // Kept for the next visit when another view is shown.
    if (this.filters.view_type !== ViewMode.Favorites || this.filters.series_id !== undefined)
      return;
    window.scrollTo({ top: 0, behavior: "instant" });
    await this.load();
  }

  async createFavoriteList() {
    const id = await this.favoriteLists.promptCreate();
    if (id !== undefined) await this.selectFavoriteList(id);
  }

  /// The lists were (re)loaded, e.g. after a rename or delete in the chips:
  /// a shown list that is gone switches back to the favorites.
  private favoriteListsChanged(lists: FavoriteList[]) {
    this.favoriteListItems = lists;
    const selected = this.filters?.favorite_list;
    if (selected !== undefined && !lists.some((l) => l.id === selected)) {
      void this.selectFavoriteList(undefined);
    }
  }

  /// The shown list is in the own order and can be rearranged (drag & drop,
  /// "move forward/back" in the tile menu).
  customOrderActive(): boolean {
    return (
      this.panel === "library" &&
      !this.continueWatching &&
      this.viewType === ViewMode.Favorites &&
      this.shownSort === SortType.custom &&
      this.filters?.series_id === undefined
    );
  }

  onTileDropped(event: CdkDragDrop<Channel[]>) {
    void this.reorder(event.previousIndex, event.currentIndex);
  }

  /** Keyboard alternative to drag & drop: one place forward (-1) or back (+1). */
  async moveChannel(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0) return;
    if (to >= this.channels.length) {
      // The tile after the last loaded one is on the next page.
      if (this.reachedMax) return;
      await this.loadMore(true);
      if (to >= this.channels.length) return;
    }
    if (await this.reorder(index, to)) {
      // Keep the keyboard on the moved tile.
      setTimeout(() => document.getElementById(`tile-${to}`)?.focus(), 0);
    }
  }

  /**
   * Moves a tile in the own order: shown right away, then saved in front of
   * the tile that now follows it (at the end when none does). With a search
   * or media filter only a part of the list is shown; "in front of the next
   * shown tile" keeps the saved order in line with the screen then, too.
   * Resolves to true once saved.
   */
  private async reorder(from: number, to: number): Promise<boolean> {
    if (!this.customOrderActive() || this.loading || from === to) return false;
    const moved = this.channels[from];
    if (moved?.id === undefined) return false;
    const listId = this.shownFavoriteList ?? null;
    const channels = [...this.channels];
    moveItemInArray(channels, from, to);
    this.channels = channels;
    // Moved behind the last loaded tile: its successor is on the next page,
    // and the next page does not change by the move (it stays in the loaded part).
    if (to === channels.length - 1 && !this.reachedMax) await this.loadMore(true);
    const before = this.channels[to + 1];
    if (!before && !this.reachedMax) {
      // The next page did not load: "at the end" would be wrong.
      await this.load();
      return false;
    }
    try {
      await invoke("move_favorite", {
        listId,
        channelId: moved.id,
        beforeId: before?.id ?? null,
      });
      this.mirrorPlayerList();
      return true;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("FAV_LISTS.MOVE_FAILED"));
      // Back to the saved order.
      await this.load();
      return false;
    }
  }

  filtersVisible() {
    return !this.filters?.series_id && !this.continueWatching && this.panel === "library";
  }

  /// The history (also "continue watching") is always ordered by last
  /// watched; only a series' season list follows the sort there. The hidden
  /// view is ordered by name.
  sortApplies(): boolean {
    if (this.filters?.view_type === ViewMode.Hidden) return false;
    if (this.filters?.view_type !== ViewMode.History) return true;
    return this.filters.series_id !== undefined && this.filters.season === undefined;
  }

  /// The sidebar shows its icons only (collapsed, or the narrow top bar):
  /// the nav items get tooltips then.
  labelsHidden(): boolean {
    return this.sidebarCollapsed || this.narrow;
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
    } else if (sameMode && !this.nodeStack.hasNodes() && !this.filters.query) {
      return;
    }
    // Also the view already shown (its nav item or shortcut again), when
    // inside a category/series or searching: back to its top level.
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
    this.searchPending = false;
    this.nodeStack.clear();
    this.clearSelection();
    await this.load();
    if (sameMode) window.scrollTo({ top: 0, behavior: "instant" });
  }

  /// Index of the sidebar item of what is shown (viewMode-N).
  activeNavIndex(): number {
    if (this.panel === "guide") return 5;
    if (this.panel === "recordings") return 6;
    if (this.continueWatching) return 4;
    switch (this.filters?.view_type) {
      case ViewMode.Categories:
        return 1;
      case ViewMode.Favorites:
        return 2;
      case ViewMode.History:
        return 3;
      case ViewMode.Hidden:
        return 7;
      default:
        return 0;
    }
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
    // The edit dialogs hold unsaved input: they close by their buttons only.
    const instance = ref.componentInstance;
    if (
      instance instanceof EditChannelModalComponent ||
      instance instanceof EditGroupModalComponent
    )
      return;
    if (instance.name != "RestreamModalComponent" || !instance.started) ref.close("close");
  }

  async goBackHotkey() {
    if (this.selection.size > 0) {
      this.clearSelection();
    } else if (this.memory.currentContextMenu?.menuOpen) {
      this.closeContextMenu();
    } else if (this.searchFocused()) {
      this.selectFirstChannel();
    } else if (this.filters?.query) {
      this.clearSearch();
      await this.load();
      this.selectFirstChannelDelayed(100);
    } else if (this.nodeStack.hasNodes()) {
      if (this.navigatingBack) return;
      if (!(await this.goBack())) this.selectFirstChannelDelayed(100);
    } else {
      this.selectFirstChannel();
    }
  }

  selectFirstChannelDelayed(milliseconds: number) {
    setTimeout(() => this.selectFirstChannel(), milliseconds);
  }

  /**
   * `levels` levels up (one by default; more from the breadcrumb), back to
   * where the level reached was scrolled. Resolves to true when the keyboard
   * focus went back to the tile the level was left from.
   */
  async goBack(levels = 1): Promise<boolean> {
    // Holding Backspace (or clicking the arrow repeatedly) must not pop two
    // levels at once or pop an empty stack.
    if (this.navigatingBack || !this.nodeStack.hasNodes() || !this.filters || levels < 1)
      return false;
    this.navigatingBack = true;
    try {
      // The outermost node popped describes the level reached (its query,
      // scroll position and pages).
      let node = this.nodeStack.pop();
      this.leaveLevel(node);
      for (let i = 1; i < levels && this.nodeStack.hasNodes(); i++) {
        node = this.nodeStack.pop();
        this.leaveLevel(node);
      }
      if (node.query) {
        this.setSearchValue(node.query);
        this.prevSearchValue = node.query;
        this.filters.query = node.query;
      }
      if (node.fromViewType && this.filters.view_type !== node.fromViewType) {
        this.filters.view_type = node.fromViewType;
      }
      await this.load();
      return await this.restorePosition(node);
    } finally {
      this.navigatingBack = false;
    }
  }

  /// Drops the filter a popped node had narrowed the list by.
  private leaveLevel(node: Node) {
    if (!this.filters) return;
    if (node.type == NodeType.Category) this.filters.group_id = undefined;
    else if (node.type == NodeType.Series) {
      this.filters.series_id = undefined;
      this.filters.source_ids = Array.from(this.memory.Sources.keys());
    } else if (node.type == NodeType.Season) {
      this.filters.season = undefined;
    }
  }

  /** Breadcrumb: back to the level `depth` levels deep (0: the view itself). */
  async goToLevel(depth: number): Promise<boolean> {
    const levels = this.nodeStack.get()?.path.length ?? 0;
    return this.goBack(levels - depth);
  }

  /// Inside a category or series: the heading shows the way back to the view.
  insideLevel(): boolean {
    return (
      this.nodeStack.hasNodes() &&
      ((this.filters?.view_type === ViewMode.Categories && !!this.filters?.group_id) ||
        !!this.filters?.series_id)
    );
  }

  /// Translation key of the library view's name (the sidebar's label).
  viewLabelKey(): string {
    if (this.continueWatching) return "HOME.NAV.CONTINUE_WATCHING";
    switch (this.filters?.view_type) {
      case ViewMode.Categories:
        return "HOME.NAV.CATEGORIES";
      case ViewMode.Favorites:
        return "HOME.NAV.FAVORITES";
      case ViewMode.History:
        return "HOME.NAV.HISTORY";
      case ViewMode.Hidden:
        return "HOME.NAV.HIDDEN";
      default:
        return "HOME.NAV.ALL_CHANNELS";
    }
  }

  /**
   * Back on the level a node was opened from: loads as many pages as it had,
   * scrolls to where it was and, when the focus got lost with the old tiles,
   * puts it on the tile that was opened. Resolves to true in that case.
   */
  private async restorePosition(node: Node): Promise<boolean> {
    this.restoring = true;
    try {
      return await this.restorePages(node);
    } finally {
      this.restoring = false;
      this.scheduleFillCheck();
    }
  }

  private async restorePages(node: Node): Promise<boolean> {
    let seq = this.loadSeq;
    const pages = Math.min(node.page ?? 1, MAX_RESTORED_PAGES);
    while (this.filters && this.filters.page < pages && !this.reachedMax && !this.loadMoreFailed) {
      await this.load(true);
      // Superseded (the user moved on meanwhile): leave the position alone.
      if (this.loadSeq !== seq + 1) return false;
      seq = this.loadSeq;
    }
    // The tiles render after this change detection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.loadSeq !== seq || this.panel !== "library") return false;
    window.scrollTo({ top: node.scrollPosition, behavior: "instant" });
    const active = document.activeElement;
    if (node.tileIndex === undefined || (active && active !== document.body)) return false;
    const tile = document.getElementById(`${FocusAreaPrefix[FocusArea.Tiles]}${node.tileIndex}`);
    if (!tile) return false;
    tile.focus({ preventScroll: true });
    this.focusArea = FocusArea.Tiles;
    this.focus = node.tileIndex;
    return true;
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
  }

  /** "Clear history" in the history's toolbar, after a confirmation. */
  async clearHistory() {
    const confirmed = await this.confirm.confirm({
      title: "CONFIRM.CLEAR_HISTORY_TITLE",
      messages: ["CONFIRM.CLEAR_HISTORY_BODY"],
      confirmLabel: "SETTINGS.DATA.CLEAR_BTN",
    });
    if (!confirmed) return;
    // tryIPC resolves to true when the action failed.
    const failed = await this.memory.tryIPC(
      this.translate.instant("TOAST.HISTORY_CLEARED"),
      this.translate.instant("TOAST.HISTORY_CLEAR_FAILED"),
      () => invoke("clear_history"),
    );
    if (!failed) await this.load();
  }

  // ---------------------------- Multi-selection ---------------------------

  isSelected(channel: Channel): boolean {
    return channel.id !== undefined && this.selection.has(HomeComponent.key(channel));
  }

  /** Ctrl/Cmd/Shift + click on a tile: in or out of the selection. */
  toggleSelection(channel: Channel) {
    if (channel.id === undefined || channel.id < 0) return;
    const key = HomeComponent.key(channel);
    if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.set(key, channel);
    // A new Map, so the bindings see the change.
    this.selection = new Map(this.selection);
  }

  clearSelection() {
    if (this.selection.size > 0) this.selection = new Map();
  }

  /// Drops selected tiles that are no longer listed.
  private pruneSelection() {
    if (this.selection.size === 0) return;
    const shown = new Set(this.channels.map((c) => HomeComponent.key(c)));
    const kept = [...this.selection].filter(([key]) => shown.has(key));
    if (kept.length !== this.selection.size) this.selection = new Map(kept);
  }

  /// Selected tiles that can be favorited (groups and seasons cannot).
  private selectedFavoritable(): Channel[] {
    return [...this.selection.values()].filter(
      (c) => c.media_type !== MediaType.group && c.media_type !== MediaType.season && !c.favorite,
    );
  }

  canFavoriteSelection(): boolean {
    return this.viewType !== ViewMode.Hidden && this.selectedFavoritable().length > 0;
  }

  /** Action bar: adds the selected channels to the favorites. */
  async favoriteSelection() {
    const channels = this.selectedFavoritable();
    if (channels.length === 0) return;
    let done = 0;
    for (const channel of channels) {
      try {
        await invoke("favorite_channel", { channelId: channel.id });
        done++;
      } catch (e) {
        console.error(e);
      }
    }
    this.reportBulk(done, channels.length, "TOAST.ITEMS_FAVORITED");
    this.clearSelection();
    await this.refreshInPlace();
  }

  /** Action bar: hides the selection (shows it again in the hidden view). */
  async hideSelection() {
    const channels = [...this.selection.values()];
    if (channels.length === 0) return;
    const hidden = this.viewType !== ViewMode.Hidden;
    const changed: Channel[] = [];
    for (const channel of channels) {
      try {
        await invoke(channel.media_type === MediaType.group ? "hide_group" : "hide_channel", {
          id: channel.id,
          hidden,
        });
        changed.push(channel);
      } catch (e) {
        console.error(e);
      }
    }
    this.clearSelection();
    const toast = this.reportBulk(
      changed.length,
      channels.length,
      hidden ? "TOAST.ITEMS_HIDDEN_UNDO" : "TOAST.ITEMS_UNHIDDEN",
    );
    // Tapping "… hidden" brings them back.
    if (toast && hidden) {
      toast.onTap.pipe(take(1)).subscribe(async () => {
        for (const channel of changed) {
          await setHidden(channel, false, this.error, this.translate);
        }
        this.memory.Refresh.next(false);
      });
    }
    await this.refreshInPlace();
  }

  /// Success toast for `done` of `total` items (an error toast when some
  /// failed); returns the success toast.
  private reportBulk(done: number, total: number, key: string) {
    if (done < total) {
      this.error.handleError(
        `${total - done} of ${total} failed`,
        this.translate.instant("TOAST.BULK_FAILED"),
      );
    }
    if (done === 0) return undefined;
    return this.toast.success(this.translate.instant(key, { count: done }));
  }

  // ------------------------- Actions on all results -----------------------

  /// The menu with "favorite/hide all results": for a search with results
  /// (not in a series' season list, which bulk_update leaves alone).
  resultActionsVisible(): boolean {
    return (
      this.panel === "library" &&
      !!this.filters?.query &&
      this.channels.length > 0 &&
      !(this.filters.series_id !== undefined && this.filters.season === undefined) &&
      // The bulk update knows neither the country filter nor favorite lists:
      // it would change more than the list shows.
      !(this.countryApplies() && this.filters.country) &&
      this.shownFavoriteList === undefined
    );
  }

  /// Favorites need channels: not the category list, not the hidden view.
  canFavoriteAllResults(): boolean {
    if (this.viewType === ViewMode.Hidden) return false;
    return !(this.viewType === ViewMode.Categories && this.filters?.group_id === undefined);
  }

  /** "Favorite/Hide/Unhide all results": bulk_update after a confirmation. */
  async applyToAllResults(action: BulkActionType) {
    if (!this.filters?.query) return;
    const count = this.reachedMax ? String(this.channels.length) : `${this.channels.length}+`;
    const [title, body, confirmLabel] =
      action === BulkActionType.Favorite
        ? ["CONFIRM.BULK_FAVORITE_TITLE", "CONFIRM.BULK_FAVORITE_BODY", "MENU.FAVORITE"]
        : action === BulkActionType.Unhide
          ? ["CONFIRM.BULK_UNHIDE_TITLE", "CONFIRM.BULK_UNHIDE_BODY", "MENU.UNHIDE"]
          : ["CONFIRM.BULK_HIDE_TITLE", "CONFIRM.BULK_HIDE_BODY", "HOME.SELECTION.HIDE"];
    const confirmed = await this.confirm.confirm({
      title,
      messages: [body],
      confirmLabel,
      params: { count, query: this.filters.query },
      danger: false,
    });
    if (!confirmed) return;
    const failed = await this.memory.tryIPC(
      this.translate.instant("TOAST.RESULTS_UPDATED"),
      this.translate.instant("TOAST.BULK_FAILED"),
      () => invoke("bulk_update", { filters: this.searchFilters(1), action }),
    );
    if (!failed) await this.refreshInPlace();
  }

  /** Home toolbar lock: show the locked groups (after the PIN) or hide them. */
  async toggleLocked() {
    if (await this.parental.toggleShowLocked()) {
      await this.load();
      this.loadCountries();
      this.favoriteLists.load();
    }
  }

  openSettings() {
    this.router.navigateByUrl("settings");
  }

  /**
   * Arrow keys follow the layout: the sidebar is a column (a row in the
   * narrow top bar), above the content the search box and the media pills,
   * then the tile grid.
   */
  async nav(key: string) {
    if (this.keyboardBlocked()) return;
    if (this.memory.currentContextMenu?.menuOpen) return;
    if (this.searchFocused()) {
      // Left/Right move the caret.
      if (key === "ArrowDown") this.enterResults();
      else if (key === "ArrowUp") this.focusNav(this.activeNavIndex());
      return;
    }
    if (this.panel !== "library") {
      this.navSidebarOnly(key);
      return;
    }
    // Focus may have moved by Tab or mouse since the last arrow key.
    this.syncFocusFromDom();
    if (this.focusArea === FocusArea.ViewMode) this.navSidebar(key);
    else if (this.focusArea === FocusArea.Filters) this.navFilters(key);
    else await this.navTiles(key);
  }

  /// The sidebar's keys: [previous, next, into the content].
  private sidebarKeys(): [string, string, string] {
    return this.narrow
      ? ["ArrowLeft", "ArrowRight", "ArrowDown"]
      : ["ArrowUp", "ArrowDown", "ArrowRight"];
  }

  private navSidebar(key: string) {
    const [previous, next, into] = this.sidebarKeys();
    if (key === previous) this.focusNav(this.focus - 1);
    else if (key === next) this.focusNav(this.focus + 1);
    else if (key === into) this.enterContent();
  }

  /// From the sidebar into the library: the first tile, else the pills, else
  /// the search box.
  private enterContent() {
    if (this.channels.length > 0) this.focusTile(0);
    else if (this.filtersVisible()) this.focusFilter(0);
    else this.search.nativeElement.focus();
  }

  private navFilters(key: string) {
    const last = this.shortFiltersMode() ? 1 : 2;
    switch (key) {
      case "ArrowLeft":
        if (this.focus > 0) this.focusFilter(this.focus - 1);
        else if (!this.narrow) this.focusNav(this.activeNavIndex());
        break;
      case "ArrowRight":
        this.focusFilter(Math.min(last, this.focus + 1));
        break;
      case "ArrowUp":
        this.search.nativeElement.focus();
        break;
      case "ArrowDown":
        if (this.channels.length > 0) this.focusTile(0);
        break;
    }
  }

  private async navTiles(key: string) {
    const columns = this.gridColumns();
    const index = this.focus;
    switch (key) {
      case "ArrowUp":
        if (index - columns >= 0) this.focusTile(index - columns);
        // From the first row up to the toolbar.
        else if (this.filtersVisible()) this.focusFilter(0);
        else this.search.nativeElement.focus();
        return;
      case "ArrowLeft":
        // From the first column (vertical sidebar) into the sidebar.
        if (!this.narrow && index % columns === 0) this.focusNav(this.activeNavIndex());
        else if (index > 0) this.focusTile(index - 1);
        return;
      case "ArrowDown":
        await this.moveToTile(index + columns, true);
        return;
      case "ArrowRight":
        await this.moveToTile(index + 1, false);
        return;
    }
  }

  /// Moves on to tile `target`, loading the next page first when it is not
  /// loaded yet. `clamp`: past the end, the last tile (ArrowDown).
  private async moveToTile(target: number, clamp: boolean) {
    if (target >= this.channels.length && !this.reachedMax && !this.loadMoreFailed) {
      await this.loadMore();
    }
    if (target < this.channels.length) this.focusTile(target);
    else if (clamp && this.channels.length > 0) this.focusTile(this.channels.length - 1);
  }

  private focusTile(index: number) {
    this.focusArea = FocusArea.Tiles;
    this.focus = index;
    // The tile may only render with this change detection (a page loaded).
    setTimeout(
      () => document.getElementById(`${FocusAreaPrefix[FocusArea.Tiles]}${index}`)?.focus(),
      0,
    );
  }

  private focusFilter(index: number) {
    this.focusArea = FocusArea.Filters;
    this.focus = index;
    document.getElementById(`${FocusAreaPrefix[FocusArea.Filters]}${index}`)?.focus();
  }

  private focusNav(index: number) {
    const next = Math.min(NAV_ITEM_COUNT - 1, Math.max(0, index));
    this.focusArea = FocusArea.ViewMode;
    this.focus = next;
    document.getElementById(`${FocusAreaPrefix[FocusArea.ViewMode]}${next}`)?.focus();
  }

  /// The guide and the recordings handle their own keys; arrow keys only move
  /// within the sidebar there.
  private navSidebarOnly(key: string) {
    const prefix = FocusAreaPrefix[FocusArea.ViewMode];
    const id = (document.activeElement as HTMLElement | null)?.id ?? "";
    if (!id.startsWith(prefix)) return;
    const index = Number(id.slice(prefix.length));
    if (!Number.isInteger(index)) return;
    const [previous, next] = this.sidebarKeys();
    if (key === previous) this.focusNav(index - 1);
    else if (key === next) this.focusNav(index + 1);
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
    // Escape first clears a multi-selection (Backspace keeps going back).
    if (event.key == "Escape" && this.selection.size > 0) {
      event.preventDefault();
      this.clearSelection();
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
    // The media pills are checkboxes, which only toggle on Space by
    // themselves. Decided by the focused element, not by focusArea (only
    // arrow keys update that): tiles and buttons activate on Enter already.
    const active = document.activeElement;
    if (
      event.key == "Enter" &&
      !event.repeat &&
      this.panel === "library" &&
      active instanceof HTMLInputElement &&
      active.type === "checkbox" &&
      active.id.startsWith(FocusAreaPrefix[FocusArea.Filters])
    )
      active.click();
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
    if (this.resizeListener) window.removeEventListener("resize", this.resizeListener);
    this.endObserver?.disconnect();
    if (this.fillTimer !== undefined) clearTimeout(this.fillTimer);
    this.narrowQuery.removeEventListener("change", this.narrowListener);
    this.subscriptions.forEach((x) => x.unsubscribe());
    this.autoRefreshUnlisten?.();
  }
}
