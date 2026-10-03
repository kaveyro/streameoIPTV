import { NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";

import { HomeComponent } from "./home.component";
import { ChannelTileComponent } from "../channel-tile/channel-tile.component";
import { SortButtonComponent } from "./sort-button/sort-button.component";
import { FavoriteListChipsComponent } from "../favorite-lists/favorite-list-chips/favorite-list-chips.component";
import { TvGuideComponent } from "../tv-guide/tv-guide.component";
import { RecordingsComponent } from "../recordings/recordings.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { SourceType } from "../models/sourceType";
import { ViewMode } from "../models/viewMode";
import { NodeType } from "../models/nodeType";
import { SortType } from "../models/sortType";
import { Channel } from "../models/channel";
import { CdkDragDrop } from "@angular/cdk/drag-drop";
import { FavoriteListsService } from "../favorite-lists/favorite-lists.service";
import { FocusArea } from "../models/focusArea";
import { Router } from "@angular/router";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("HomeComponent", () => {
  let component: HomeComponent;
  let fixture: ComponentFixture<HomeComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const source = { id: 1, name: "Main", source_type: SourceType.M3ULink, enabled: true };

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({ get_sources: [source], ...handlers });
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, HomeComponent],
      providers: TEST_PROVIDERS,
    })
      // Shallow: tiles, sort button, guide and recordings have their own specs.
      .overrideComponent(HomeComponent, {
        remove: {
          imports: [
            ChannelTileComponent,
            SortButtonComponent,
            FavoriteListChipsComponent,
            TvGuideComponent,
            RecordingsComponent,
          ],
        },
        add: { schemas: [NO_ERRORS_SCHEMA] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  /// The guide and recordings panels are @defer blocks: their content
  /// renders once the (lazy) dependencies have loaded.
  async function renderDeferred() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function lastSearch(): Filters {
    const searches = callsOf(calls, "search");
    return searches[searches.length - 1].args["filters"] as Filters;
  }

  afterEach(() => {
    resetTauri();
    sessionStorage.removeItem("favoriteListSelected");
  });

  it("should create and load the library", async () => {
    await create();
    expect(component).toBeTruthy();
    expect(callsOf(calls, "search").length).toBe(1);
  });

  it("sends the session's parental flag with every search", async () => {
    await create();
    expect(lastSearch().show_locked).toBeFalse();
    TestBed.inject(MemoryService).ShowLocked = true;
    await component.reload();
    expect(lastSearch().show_locked).toBeTrue();
  });

  it("shows the lock button only when a PIN exists", async () => {
    await create({ has_parental_pin: true });
    const lock = element.querySelector('button[aria-label="PARENTAL.SHOW_LOCKED"]');
    expect(lock).not.toBeNull();
    const toggle = spyOn(TestBed.inject(ParentalService), "toggleShowLocked").and.resolveTo(true);
    (lock as HTMLButtonElement).click();
    await settle();
    expect(toggle).toHaveBeenCalled();
    expect(callsOf(calls, "search").length).toBe(2);
  });

  it("has no lock button without a PIN", async () => {
    await create({ has_parental_pin: false });
    expect(element.querySelector('button[aria-label="PARENTAL.SHOW_LOCKED"]')).toBeNull();
  });

  it("'continue watching' is the history restricted to movies and episodes", async () => {
    await create();
    await component.switchMode(ViewMode.History, true);
    expect(lastSearch().view_type).toBe(ViewMode.History);
    expect(lastSearch().media_types).toEqual([MediaType.movie]);
    expect(component.isContinueWatching()).toBeTrue();
    expect(component.isMode(ViewMode.History)).toBeFalse();
    expect(component.filtersVisible()).toBeFalse();
    fixture.detectChanges();
    expect(element.querySelector("#viewMode-4")?.classList).toContain("active");

    // The plain history keeps all media types.
    await component.switchMode(ViewMode.History);
    expect(lastSearch().media_types).toEqual([
      MediaType.livestream,
      MediaType.movie,
      MediaType.serie,
    ]);
    expect(component.isMode(ViewMode.History)).toBeTrue();
  });

  it("the media shortcuts do not change 'continue watching'", async () => {
    await create();
    await component.switchMode(ViewMode.History, true);
    const searches = callsOf(calls, "search").length;
    component.updateMediaTypes(MediaType.livestream);
    expect(callsOf(calls, "search").length).toBe(searches);
    expect(component.filters?.media_types).toEqual([MediaType.movie]);
  });

  it("shows the recordings without searching", async () => {
    await create();
    const searches = callsOf(calls, "search").length;
    (element.querySelector("#viewMode-6") as HTMLButtonElement).click();
    await renderDeferred();
    expect(component.panel).toBe("recordings");
    expect(element.querySelector("app-recordings")).not.toBeNull();
    expect(element.querySelector("app-channel-tile")).toBeNull();
    expect(callsOf(calls, "search").length).toBe(searches);
    expect(element.querySelector("#viewMode-6")?.getAttribute("aria-current")).toBe("page");
  });

  it("opens the guide for the current group and returns to it", async () => {
    await create();
    await component.switchMode(ViewMode.Categories);
    component.filters!.group_id = 5;
    component.showPanel("guide");
    await renderDeferred();
    expect(component.guideGroup?.id).toBe(5);
    expect(element.querySelector("app-tv-guide")).not.toBeNull();

    await component.switchMode(ViewMode.Categories);
    expect(component.panel).toBe("library");
    expect(lastSearch().group_id).toBe(5);
    // The @defer trigger fires once; the guide itself is still removed.
    fixture.detectChanges();
    expect(element.querySelector("app-tv-guide")).toBeNull();
  });

  it("takes the stream fallback setting from the settings", async () => {
    await create({ get_settings: { auto_fallback: false } });
    expect(TestBed.inject(MemoryService).AutoFallback).toBeFalse();
  });

  it("keeps the stream fallback on when it was never set", async () => {
    await create();
    expect(TestBed.inject(MemoryService).AutoFallback).toBeTrue();
  });

  it("takes the country prefix display mode from the settings", async () => {
    await create({ get_settings: { country_prefix: "badge" } });
    expect(TestBed.inject(MemoryService).CountryPrefixMode).toBe("badge");
  });

  describe("navigation levels", () => {
    const tiles = (count: number): Channel[] =>
      Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        name: `Channel ${i + 1}`,
        media_type: MediaType.livestream,
        source_id: 1,
        favorite: false,
      }));

    it("names the view in a heading at the top level", async () => {
      await create();
      expect(element.querySelector("h1")?.textContent?.trim()).toBe("HOME.NAV.ALL_CHANNELS");
      expect(element.querySelector("nav.crumbs")).toBeNull();
      await component.switchMode(ViewMode.History, true);
      fixture.detectChanges();
      expect(element.querySelector("h1")?.textContent?.trim()).toBe("HOME.NAV.CONTINUE_WATCHING");
    });

    it("shows the whole path of the opened levels as a breadcrumb", async () => {
      await create();
      const memory = TestBed.inject(MemoryService);
      memory.SetNode.next({ id: 5, name: "Show", type: NodeType.Series, sourceId: 1 });
      await settle();
      memory.SetNode.next({ id: 2, name: "Season 2", type: NodeType.Season });
      await settle();
      fixture.detectChanges();
      expect(component.nodeStack.get()?.pathLabel()).toBe("Show › Season 2");
      const nav = element.querySelector("nav.crumbs");
      expect(nav?.getAttribute("aria-label")).toBe("HOME.BREADCRUMB");
      const crumbs = Array.from(nav!.querySelectorAll("button.crumb")).map((b) =>
        b.textContent?.trim(),
      );
      expect(crumbs).toEqual(["HOME.NAV.ALL_CHANNELS", "Show"]);
      const current = nav!.querySelector('[aria-current="page"]');
      expect(current?.tagName).toBe("H1");
      expect(current?.textContent?.trim()).toBe("Season 2");
      expect(element.querySelectorAll("h1").length).toBe(1);
      expect(element.querySelector("button.go-back-btn")?.getAttribute("aria-label")).toBe(
        "COMMON.GO_BACK",
      );
    });

    it("pops back to the level of a breadcrumb segment", async () => {
      await create({ search: tiles(36) });
      await component.switchMode(ViewMode.Categories);
      const memory = TestBed.inject(MemoryService);
      memory.SetNode.next({ id: 9, name: "Kids", type: NodeType.Category });
      await settle();
      memory.SetNode.next({ id: 5, name: "Show", type: NodeType.Series, sourceId: 1 });
      await settle();
      memory.SetNode.next({ id: 2, name: "Season 2", type: NodeType.Season });
      await settle();
      fixture.detectChanges();
      const scroll = spyOn(window, "scrollTo");
      const crumbs = element.querySelectorAll<HTMLButtonElement>("nav.crumbs button.crumb");
      // "Categories › Kids › Show › Season 2": back to "Kids" in one step.
      crumbs[1].click();
      await settle();
      fixture.detectChanges();
      expect(component.nodeStack.get()?.name).toBe("Kids");
      expect(lastSearch().group_id).toBe(9);
      expect(lastSearch().series_id).toBeUndefined();
      expect(lastSearch().season).toBeUndefined();
      expect(scroll).toHaveBeenCalled();
      expect(element.querySelector('nav.crumbs [aria-current="page"]')?.textContent?.trim()).toBe(
        "Kids",
      );

      // The view itself: no levels left.
      element.querySelector<HTMLButtonElement>("nav.crumbs button.crumb")!.click();
      await settle();
      fixture.detectChanges();
      expect(component.nodeStack.hasNodes()).toBeFalse();
      expect(lastSearch().group_id).toBeUndefined();
      expect(element.querySelector("nav.crumbs")).toBeNull();
      expect(element.querySelector("h1")?.textContent?.trim()).toBe("HOME.NAV.CATEGORIES");
    });

    it("loads the pages of the level again and scrolls back on the way back", async () => {
      await create({ search: tiles(36) });
      await component.switchMode(ViewMode.Categories);
      await component.loadMore(true);
      expect(component.filters?.page).toBe(2);
      const memory = TestBed.inject(MemoryService);
      memory.SetNode.next({ id: 9, name: "Kids", type: NodeType.Category });
      await settle();
      expect(lastSearch().group_id).toBe(9);
      const scroll = spyOn(window, "scrollTo");
      const searches = callsOf(calls, "search").length;
      await component.goBack();
      // Page 1 and 2 of the categories again.
      expect(callsOf(calls, "search").length).toBe(searches + 2);
      expect(lastSearch().group_id).toBeUndefined();
      expect(lastSearch().page).toBe(2);
      expect(component.channels.length).toBe(72);
      expect(scroll).toHaveBeenCalled();
    });
  });

  describe("load errors", () => {
    it("shows an error with a retry instead of the empty state", async () => {
      let fail = true;
      await create({
        search: () => {
          if (fail) throw "offline";
          return [];
        },
      });
      expect(component.loadFailed).toBeTrue();
      expect(element.querySelector(".empty-state")?.textContent).toContain("EMPTY.LOAD_FAILED");
      expect(element.textContent).not.toContain("EMPTY.NO_CHANNELS_FOUND");

      fail = false;
      const retry = element.querySelector(".empty-state button") as HTMLButtonElement;
      expect(retry.textContent).toContain("EMPTY.RETRY");
      retry.click();
      await settle();
      fixture.detectChanges();
      expect(component.loadFailed).toBeFalse();
      expect(element.querySelector(".empty-state")?.textContent).toContain(
        "EMPTY.NO_CHANNELS_FOUND",
      );
    });

    it("offers a retry instead of the setup when the start fails", async () => {
      let fail = true;
      await create({
        get_settings: () => {
          if (fail) throw "ipc down";
          return {};
        },
      });
      expect(TestBed.inject(Router).url).not.toBe("/setup");
      expect(component.loadFailed).toBeTrue();
      expect(callsOf(calls, "search").length).toBe(0);

      fail = false;
      const retry = element.querySelector(".empty-state button") as HTMLButtonElement;
      expect(retry.textContent).toContain("EMPTY.RETRY");
      retry.click();
      await settle();
      fixture.detectChanges();
      expect(component.loadFailed).toBeFalse();
      expect(callsOf(calls, "search").length).toBe(1);
      expect(TestBed.inject(Router).url).not.toBe("/setup");
    });

    it("still goes to the setup without any source", async () => {
      await create({ get_sources: [] });
      expect(TestBed.inject(Router).url).toBe("/setup");
    });
  });

  describe("refresh on start", () => {
    afterEach(() => sessionStorage.removeItem("refreshedOnStart"));

    it("reloads the list once the sources are refreshed", async () => {
      sessionStorage.removeItem("refreshedOnStart");
      let finishRefresh!: () => void;
      await create({
        get_settings: { refresh_on_start: true },
        refresh_all: () => new Promise<void>((resolve) => (finishRefresh = resolve)),
      });
      expect(callsOf(calls, "search").length).toBe(1);
      finishRefresh();
      await settle();
      expect(callsOf(calls, "search").length).toBe(2);
    });

    it("keeps the list when the refresh failed", async () => {
      sessionStorage.removeItem("refreshedOnStart");
      await create({
        get_settings: { refresh_on_start: true },
        refresh_all: () => {
          throw "offline";
        },
      });
      await settle();
      expect(callsOf(calls, "refresh_all").length).toBe(1);
      expect(callsOf(calls, "search").length).toBe(1);
    });
  });

  describe("Enter key", () => {
    function enter() {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    }

    it("toggles a focused media pill once", async () => {
      await create();
      const live = element.querySelector("#filter-0") as HTMLInputElement;
      const click = spyOn(live, "click").and.callThrough();
      live.focus();
      enter();
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("leaves a focused button to its own activation, whatever the focus area", async () => {
      await create();
      // Arrow keys last put the focus area on the filters; Tab moved on since.
      component.focusArea = FocusArea.Filters;
      const reload = element.querySelector("button.reload-btn") as HTMLButtonElement;
      const click = spyOn(reload, "click");
      reload.focus();
      enter();
      expect(click).not.toHaveBeenCalled();
    });
  });

  describe("media type pills", () => {
    it("keeps the last active one on (shortcut path)", async () => {
      await create();
      component.chkLiveStream = false;
      component.updateMediaTypes(MediaType.livestream);
      await settle();
      const searches = callsOf(calls, "search").length;
      component.chkMovie = false;
      component.updateMediaTypes(MediaType.movie);
      await settle();
      expect(component.chkMovie).toBeTrue();
      expect(component.filters?.media_types).toContain(MediaType.movie);
      expect(callsOf(calls, "search").length).toBe(searches);
    });

    it("does not let a click switch off the last active one", async () => {
      await create();
      component.chkLiveStream = false;
      component.updateMediaTypes(MediaType.livestream);
      await settle();
      fixture.detectChanges();
      await fixture.whenStable();
      const searches = callsOf(calls, "search").length;
      const movies = element.querySelector("#filter-1") as HTMLInputElement;
      movies.click();
      await settle();
      expect(movies.checked).toBeTrue();
      expect(component.chkMovie).toBeTrue();
      expect(callsOf(calls, "search").length).toBe(searches);
    });
  });

  it("hides the sort button where the order is fixed", async () => {
    await create();
    expect(element.querySelector("app-sort-button")).not.toBeNull();
    await component.switchMode(ViewMode.History);
    fixture.detectChanges();
    expect(element.querySelector("app-sort-button")).toBeNull();
    await component.switchMode(ViewMode.History, true);
    fixture.detectChanges();
    expect(element.querySelector("app-sort-button")).toBeNull();
    await component.switchMode(ViewMode.All);
    fixture.detectChanges();
    expect(element.querySelector("app-sort-button")).not.toBeNull();
  });

  describe("search box", () => {
    function input(): HTMLInputElement {
      return element.querySelector("#search") as HTMLInputElement;
    }

    function type(value: string) {
      input().value = value;
      input().dispatchEvent(new Event("input"));
      fixture.detectChanges();
    }

    it("has a label and a clear button while text is in it", async () => {
      await create();
      expect(input().getAttribute("aria-label")).toBe("HOME.SEARCH_LABEL");
      expect(input().getAttribute("style")).toBeNull();
      expect(element.querySelector(".search-clear")).toBeNull();
      type("news");
      const clear = element.querySelector(".search-clear") as HTMLButtonElement;
      expect(clear.getAttribute("aria-label")).toBe("HOME.CLEAR_SEARCH");
      clear.click();
      await settle();
      fixture.detectChanges();
      expect(input().value).toBe("");
      expect(lastSearch().query).toBe("");
      expect(element.querySelector(".search-clear")).toBeNull();
    });

    it("empties the box on Escape without leaving it", async () => {
      await create();
      type("news");
      input().focus();
      const searches = callsOf(calls, "search").length;
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      input().dispatchEvent(escape);
      await settle();
      expect(escape.defaultPrevented).toBeTrue();
      expect(input().value).toBe("");
      expect(component.filters?.query).toBe("");
      expect(callsOf(calls, "search").length).toBe(searches + 1);
      expect(document.activeElement).toBe(input());
    });
  });

  it("gives the icon-only toolbar actions real buttons", async () => {
    await create();
    const reload = element.querySelector("button.reload-btn") as HTMLButtonElement;
    expect(reload.getAttribute("aria-label")).toBe("HOME.RELOAD_VIEW");
    const searches = callsOf(calls, "search").length;
    reload.click();
    await settle();
    expect(callsOf(calls, "search").length).toBe(searches + 1);
  });

  describe("country filter", () => {
    const countries = [
      { code: "TR", count: 299 },
      { code: "DE", count: 120 },
    ];

    function select(): HTMLSelectElement | null {
      return element.querySelector("select.country-select");
    }

    it("loads the countries of the shown sources", async () => {
      await create({ get_countries: countries });
      expect(callsOf(calls, "get_countries").map((c) => c.args)).toEqual([
        { sourceIds: [1], showLocked: false },
      ]);
      const options = Array.from(select()!.options).map((o) => o.textContent?.trim());
      expect(options).toEqual(["HOME.ALL_COUNTRIES", "TR · 299", "DE · 120"]);
      expect(select()!.getAttribute("aria-label")).toBe("HOME.COUNTRY_FILTER");
    });

    it("is hidden with fewer than two countries", async () => {
      await create({ get_countries: [{ code: "TR", count: 5 }] });
      expect(select()).toBeNull();
    });

    it("reloads the list for the chosen country, from the first page", async () => {
      await create({ get_countries: countries });
      component.filters!.page = 3;
      const s = select()!;
      s.value = s.options[1].value;
      s.dispatchEvent(new Event("change"));
      await settle();
      expect(lastSearch().country).toBe("TR");
      expect(lastSearch().page).toBe(1);

      component.setCountry("");
      await settle();
      expect(lastSearch().country).toBeUndefined();
    });

    it("does not apply inside a category and is hidden there", async () => {
      await create({ get_countries: countries });
      component.setCountry("TR");
      await settle();
      component.filters!.group_id = 5;
      await component.reload();
      fixture.detectChanges();
      expect(lastSearch().country).toBeUndefined();
      expect(select()).toBeNull();
      // Kept for the level above.
      expect(component.filters!.country).toBe("TR");
    });

    it("drops a chosen country that is no longer offered", async () => {
      let offered = countries;
      await create({ get_countries: () => offered });
      component.setCountry("DE");
      await settle();
      offered = [
        { code: "TR", count: 299 },
        { code: "UK", count: 12 },
      ];
      const searches = callsOf(calls, "search").length;
      await component.loadCountries();
      await settle();
      expect(component.filters!.country).toBeUndefined();
      expect(callsOf(calls, "search").length).toBe(searches + 1);
      expect(lastSearch().country).toBeUndefined();
    });
  });

  describe("favorites lists", () => {
    const sport = { id: 4, name: "Sport", position: 1, count: 2 };

    it("shows the list chips in the favorites view only", async () => {
      await create({ get_favorite_lists: [sport] });
      expect(element.querySelector("app-favorite-list-chips")).toBeNull();
      await component.switchMode(ViewMode.Favorites);
      fixture.detectChanges();
      expect(element.querySelector("app-favorite-list-chips")).not.toBeNull();
      expect(component.favoriteListItems).toEqual([sport]);
    });

    it("loads the chosen list from the first page and remembers it", async () => {
      await create({ get_favorite_lists: [sport] });
      await component.switchMode(ViewMode.Favorites);
      component.filters!.page = 3;
      await component.selectFavoriteList(4);
      expect(lastSearch().favorite_list).toBe(4);
      expect(lastSearch().page).toBe(1);
      expect(TestBed.inject(FavoriteListsService).selected).toBe(4);
      expect(component.shownFavoriteList).toBe(4);

      await component.selectFavoriteList(undefined);
      expect(lastSearch().favorite_list).toBeUndefined();
      expect(component.shownFavoriteList).toBeUndefined();
    });

    it("starts with the list remembered for the session", async () => {
      sessionStorage.setItem("favoriteListSelected", "4");
      await create({
        get_favorite_lists: [sport],
        get_settings: { default_view: ViewMode.Favorites },
      });
      expect(lastSearch().favorite_list).toBe(4);
      expect(lastSearch().view_type).toBe(ViewMode.Favorites);
    });

    it("drops a remembered list that no longer exists", async () => {
      sessionStorage.setItem("favoriteListSelected", "9");
      await create({
        get_favorite_lists: [sport],
        get_settings: { default_view: ViewMode.Favorites },
      });
      await settle();
      expect(component.filters!.favorite_list).toBeUndefined();
      expect(lastSearch().favorite_list).toBeUndefined();
      expect(TestBed.inject(FavoriteListsService).selected).toBeUndefined();
    });

    it("selects a new list right away", async () => {
      await create({ get_favorite_lists: [sport] });
      await component.switchMode(ViewMode.Favorites);
      spyOn(TestBed.inject(FavoriteListsService), "promptCreate").and.resolveTo(4);
      await component.createFavoriteList();
      expect(lastSearch().favorite_list).toBe(4);
    });
  });

  describe("own order", () => {
    const channel = (id: number): Channel => ({
      id,
      name: `Channel ${id}`,
      media_type: MediaType.livestream,
      source_id: 1,
      favorite: true,
    });
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => channel(from + i));

    /// Opens the favorites in the own order; `pages` answers the searches.
    async function favoritesInOwnOrder(
      pages: (filters: Filters) => Channel[],
      handlers: Record<string, unknown> = {},
    ) {
      await create({
        search: (args: Record<string, unknown>) => pages(args["filters"] as Filters),
        ...handlers,
      });
      await component.switchMode(ViewMode.Favorites);
      TestBed.inject(MemoryService).Sort.next([SortType.custom, true]);
      await settle();
      fixture.detectChanges();
    }

    function drop(previousIndex: number, currentIndex: number) {
      component.onTileDropped({ previousIndex, currentIndex } as CdkDragDrop<Channel[]>);
    }

    function moves() {
      return callsOf(calls, "move_favorite").map((c) => c.args);
    }

    it("is only on for the favorites in the own order", async () => {
      await create({ search: page(1, 3) });
      expect(component.customOrderActive()).toBeFalse();
      await component.switchMode(ViewMode.Favorites);
      expect(component.customOrderActive()).toBeFalse();
      TestBed.inject(MemoryService).Sort.next([SortType.custom, true]);
      await settle();
      expect(component.customOrderActive()).toBeTrue();
      await component.switchMode(ViewMode.All);
      expect(component.customOrderActive()).toBeFalse();
    });

    it("saves a dropped tile in front of the tile now after it", async () => {
      await favoritesInOwnOrder(() => page(1, 3));
      drop(2, 0);
      await settle();
      expect(component.channels.map((c) => c.id)).toEqual([3, 1, 2]);
      expect(moves()).toEqual([{ listId: null, channelId: 3, beforeId: 1 }]);
    });

    it("saves a tile dropped at the end with no successor", async () => {
      await favoritesInOwnOrder(() => page(1, 3));
      drop(0, 2);
      await settle();
      expect(component.channels.map((c) => c.id)).toEqual([2, 3, 1]);
      expect(moves()).toEqual([{ listId: null, channelId: 1, beforeId: null }]);
    });

    it("moves within the shown favorites list", async () => {
      await favoritesInOwnOrder(() => page(1, 3), {
        get_favorite_lists: [{ id: 4, name: "Sport", position: 1, count: 3 }],
      });
      await component.selectFavoriteList(4);
      drop(0, 1);
      await settle();
      expect(moves()).toEqual([{ listId: 4, channelId: 1, beforeId: 3 }]);
    });

    it("does nothing outside the own order", async () => {
      await create({ search: page(1, 3) });
      await component.switchMode(ViewMode.Favorites);
      drop(0, 2);
      await settle();
      expect(moves()).toEqual([]);
      expect(component.channels.map((c) => c.id)).toEqual([1, 2, 3]);
    });

    it("moves by keyboard one place forward or back", async () => {
      await favoritesInOwnOrder(() => page(1, 3));
      await component.moveChannel(1, -1);
      expect(component.channels.map((c) => c.id)).toEqual([2, 1, 3]);
      await component.moveChannel(1, 1);
      expect(component.channels.map((c) => c.id)).toEqual([2, 3, 1]);
      expect(moves()).toEqual([
        { listId: null, channelId: 2, beforeId: 1 },
        { listId: null, channelId: 1, beforeId: null },
      ]);
      // Nothing before the first or after the last one.
      await component.moveChannel(0, -1);
      await component.moveChannel(2, 1);
      expect(moves().length).toBe(2);
    });

    it("loads the next page to find the successor of the last loaded tile", async () => {
      const size = 36; // HomeComponent.PAGE_SIZE
      await favoritesInOwnOrder((filters) =>
        filters.page === 1 ? page(1, size) : page(size + 1, 2),
      );
      expect(component.reachedMax).toBeFalse();
      await component.moveChannel(size - 1, 1);
      expect(component.channels.length).toBe(size + 2);
      expect(component.channels[size].id).toBe(size);
      expect(moves()).toEqual([{ listId: null, channelId: size, beforeId: size + 2 }]);
    });

    it("goes back to the saved order when saving failed", async () => {
      await favoritesInOwnOrder(() => page(1, 3), {
        move_favorite: () => {
          throw "nope";
        },
      });
      const searches = callsOf(calls, "search").length;
      drop(0, 2);
      await settle();
      expect(callsOf(calls, "search").length).toBe(searches + 1);
      expect(component.channels.map((c) => c.id)).toEqual([1, 2, 3]);
    });
  });
});
