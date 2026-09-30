import { NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";

import { HomeComponent } from "./home.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { SourceType } from "../models/sourceType";
import { ViewMode } from "../models/viewMode";
import { SortType } from "../models/sortType";
import { Channel } from "../models/channel";
import { CdkDragDrop } from "@angular/cdk/drag-drop";
import { FavoriteListsService } from "../favorite-lists/favorite-lists.service";
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
      declarations: [HomeComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
      // Shallow: tiles, sort button, guide and recordings have their own specs.
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
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
    fixture.detectChanges();
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
    fixture.detectChanges();
    expect(component.guideGroup?.id).toBe(5);
    expect(element.querySelector("app-tv-guide")).not.toBeNull();

    await component.switchMode(ViewMode.Categories);
    expect(component.panel).toBe("library");
    expect(lastSearch().group_id).toBe(5);
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
