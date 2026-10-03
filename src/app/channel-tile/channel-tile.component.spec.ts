import { ComponentFixture, TestBed } from "@angular/core/testing";

import { ChannelTileComponent } from "./channel-tile.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { PlaybackService } from "../playback.service";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { ViewMode } from "../models/viewMode";
import { EPG } from "../models/epg";
import { NowPlayingService } from "../now-playing.service";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { Subject } from "rxjs";
import { FavoriteListsService } from "../favorite-lists/favorite-lists.service";
import { WatchProgressService } from "../watch-progress.service";
import { ToastrService } from "ngx-toastr";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

/// Stands in for IntersectionObserver: by default a tile counts as visible
/// as soon as it is observed; `show()` changes that by hand.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  static showOnObserve = true;
  elements: Element[] = [];
  disconnected = false;

  constructor(
    private callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element) {
    this.elements.push(element);
    if (FakeIntersectionObserver.showOnObserve) this.show(true);
  }

  unobserve() {
    // Nothing to release in the fake.
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  disconnect() {
    this.disconnected = true;
  }

  show(visible: boolean) {
    const entries = this.elements.map(
      (target) => ({ isIntersecting: visible, target }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

describe("ChannelTileComponent", () => {
  let component: ChannelTileComponent;
  let fixture: ComponentFixture<ChannelTileComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  async function create(
    channel: Channel,
    viewMode = ViewMode.All,
    handlers: Record<string, unknown> = {},
    setup: () => void = () => undefined,
  ) {
    calls = mockTauri(handlers);
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, ChannelTileComponent],
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(ChannelTileComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.channel = channel;
    component.id = 0;
    component.viewMode = viewMode;
    setup();
    // Inputs set directly do not run ngOnChanges on their own.
    component.ngOnChanges({ channel: { currentValue: channel } as never });
    fixture.detectChanges();
  }

  function tile(): HTMLElement {
    return element.querySelector("#tile-0") as HTMLElement;
  }

  /// A live channel with a tvg-id, so it is eligible for the now/next line.
  const live: Channel = {
    id: 3,
    name: "TR: Kanal D",
    media_type: MediaType.livestream,
    source_id: 1,
    favorite: false,
    epg_channel_id: "KanalD.tr",
  };

  function programme(title: string, startOffsetMin: number, endOffsetMin: number): EPG {
    const now = Math.floor(Date.now() / 1000);
    return {
      epg_id: title,
      title,
      description: "",
      start_time: "",
      start_timestamp: now + startOffsetMin * 60,
      end_time: "",
      end_timestamp: now + endOffsetMin * 60,
      has_archive: false,
      now_playing: false,
    };
  }

  let originalObserver: typeof IntersectionObserver;

  beforeEach(() => {
    originalObserver = window.IntersectionObserver;
    FakeIntersectionObserver.instances = [];
    FakeIntersectionObserver.showOnObserve = true;
    (window as unknown as Record<string, unknown>)["IntersectionObserver"] =
      FakeIntersectionObserver;
  });

  afterEach(() => {
    resetTauri();
    window.IntersectionObserver = originalObserver;
  });

  const movie: Channel = { id: 1, name: "Movie", media_type: MediaType.movie, favorite: false };
  const group: Channel = { id: 9, name: "Kids", media_type: MediaType.group, favorite: false };

  it("should create", async () => {
    await create(movie);
    expect(component).toBeTruthy();
    expect(element.querySelector(".channel-title")?.textContent).toContain("Movie");
  });

  describe("watch progress", () => {
    const started: Channel = {
      ...movie,
      source_id: 1,
      url: "http://host/movie/1.mkv",
      watch_position: 1350,
      watch_duration: 5400,
    };

    it("shows the resume badge and the progress of a movie left midway", async () => {
      await create(started);
      expect(element.querySelector(".resume-badge")?.textContent).toContain("TILE.RESUME");
      const fill = element.querySelector<HTMLElement>(".watch-track .now-playing-fill");
      expect(fill?.style.width).toBe("25%");
      expect(tile().getAttribute("aria-label")).toContain("TILE.WATCH_PROGRESS");
    });

    it("shows nothing for a movie never started", async () => {
      await create(movie, ViewMode.History);
      expect(element.querySelector(".resume-badge")).toBeNull();
      expect(element.querySelector(".watch-track")).toBeNull();
      expect(element.querySelector(".watched-icon")).toBeNull();
    });

    it("marks a movie watched to the end", async () => {
      await create({ ...started, watch_position: undefined, watch_finished: true });
      expect(element.querySelector(".watched-icon")).not.toBeNull();
      expect(element.querySelector(".resume-badge")).toBeNull();
      expect(element.querySelector(".watch-track")).toBeNull();
    });

    it("follows the progress the player saves", async () => {
      await create({ ...started });
      const service = TestBed.inject(WatchProgressService);
      // Another movie: no change.
      service.changed.next({
        source_id: 1,
        url: "http://host/movie/2.mkv",
        position: 60,
        finished: false,
      });
      fixture.detectChanges();
      expect(
        element.querySelector<HTMLElement>(".watch-track .now-playing-fill")?.style.width,
      ).toBe("25%");
      service.changed.next({
        source_id: 1,
        url: started.url!,
        position: 2700,
        duration: 5400,
        finished: false,
      });
      fixture.detectChanges();
      expect(
        element.querySelector<HTMLElement>(".watch-track .now-playing-fill")?.style.width,
      ).toBe("50%");
      service.changed.next({
        source_id: 1,
        url: started.url!,
        position: null,
        duration: 5400,
        finished: true,
      });
      fixture.detectChanges();
      expect(element.querySelector(".watch-track")).toBeNull();
      expect(element.querySelector(".watched-icon")).not.toBeNull();
    });

    it("plays from the start after forgetting the resume point", async () => {
      await create({ ...started }, ViewMode.All, { clear_watch_progress: null });
      const playback = TestBed.inject(PlaybackService);
      const play = spyOn(playback, "play").and.callFake(async () => {
        // The resume point is gone before playback starts.
        expect(callsOf(calls, "clear_watch_progress").length).toBe(1);
      });
      await component.playFromStart();
      expect(callsOf(calls, "clear_watch_progress")[0].args).toEqual({
        sourceId: 1,
        url: started.url,
      });
      expect(play).toHaveBeenCalledTimes(1);
      fixture.detectChanges();
      expect(element.querySelector(".resume-badge")).toBeNull();
    });

    it("marks a watched movie as unwatched", async () => {
      await create({ ...started, watch_position: undefined, watch_finished: true }, ViewMode.All, {
        clear_watch_progress: null,
      });
      await component.markUnwatched();
      fixture.detectChanges();
      expect(callsOf(calls, "clear_watch_progress").length).toBe(1);
      expect(element.querySelector(".watched-icon")).toBeNull();
    });
  });

  it("does not show the resume badge for live channels", async () => {
    await create({ ...movie, media_type: MediaType.livestream }, ViewMode.History);
    expect(element.querySelector(".resume-badge")).toBeNull();
  });

  it("marks a locked group with a lock icon", async () => {
    await create(group, ViewMode.Categories);
    expect(element.querySelector(".lock-icon")).toBeNull();
    TestBed.inject(MemoryService).LockedGroupIds.add(9);
    fixture.detectChanges();
    expect(component.isLockedGroup()).toBeTrue();
    expect(element.querySelector(".lock-icon")).not.toBeNull();
  });

  it("reloads after locking or unlocking a group", async () => {
    await create(group, ViewMode.Categories);
    const memory = TestBed.inject(MemoryService);
    const refresh = spyOn(memory.Refresh, "next");
    spyOn(TestBed.inject(ParentalService), "toggleGroupLock").and.resolveTo(true);
    await component.toggleGroupLock();
    expect(refresh).toHaveBeenCalledWith(false);
  });

  it("plays through the shared playback path and adds the channel to the history", async () => {
    await create(movie);
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    await component.click();
    await settle();
    // With the library's list, so a catch-up played before does not leave
    // the player without channels to zap to.
    const library = TestBed.inject(MemoryService).LibraryChannelList;
    expect(play).toHaveBeenCalledOnceWith(movie, library);
    expect(callsOf(calls, "add_last_watched").map((c) => c.args)).toEqual([{ id: 1 }]);
  });

  it("keeps a channel that failed to play out of the history", async () => {
    await create(movie);
    spyOn(TestBed.inject(PlaybackService), "play").and.rejectWith("no stream");
    await component.click();
    await settle();
    expect(callsOf(calls, "add_last_watched").length).toBe(0);
    expect(component.starting).toBeFalse();
  });

  describe("keyboard activation", () => {
    function key(type: string, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
      const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
      tile().dispatchEvent(event);
      return event;
    }

    it("starts once per Enter or Space press", async () => {
      await create(movie);
      const click = spyOn(component, "click").and.resolveTo();
      key("keydown", "Enter");
      key("keydown", "Enter", { repeat: true });
      key("keyup", "Enter");
      expect(click).toHaveBeenCalledTimes(1);
      const space = key("keydown", " ");
      // Space must not scroll the page.
      expect(space.defaultPrevented).toBeTrue();
      expect(click).toHaveBeenCalledTimes(2);
    });

    it("does not start when Enter on a menu item hands the focus back", async () => {
      await create(live, ViewMode.All, { get_epg: [] });
      component.openContextMenuFromKeyboard();
      await settle();
      fixture.detectChanges();
      const click = spyOn(component, "click").and.resolveTo();
      // Enter activates the item on keydown; the menu closes and the focus
      // returns to the tile before the key comes up.
      const favorite = Array.from(
        document.querySelectorAll<HTMLElement>(".mat-mdc-menu-panel .mat-mdc-menu-item"),
      ).find((item) => item.textContent?.trim() === "MENU.FAVORITE");
      favorite!.focus();
      favorite!.click();
      await settle();
      expect(document.activeElement).toBe(tile());
      key("keyup", "Enter");
      expect(click).not.toHaveBeenCalled();
    });
  });

  describe("name tooltip", () => {
    it("is only on when the name is cut off", async () => {
      await create({ ...movie, name: "A very long channel name ".repeat(20) });
      tile().dispatchEvent(new MouseEvent("mouseenter"));
      expect(component.nameTruncated).toBeTrue();
    });

    it("stays off for a name that fits", async () => {
      await create(movie);
      tile().dispatchEvent(new MouseEvent("mouseenter"));
      expect(component.nameTruncated).toBeFalse();
    });

    it("does not describe the tile by its name a second time", async () => {
      await create(movie);
      tile().setAttribute("aria-describedby", "ngb-tooltip-1");
      component.onTooltipShown();
      expect(tile().hasAttribute("aria-describedby")).toBeFalse();
    });
  });

  it("opens a group instead of playing it", async () => {
    await create(group, ViewMode.Categories);
    const play = spyOn(TestBed.inject(PlaybackService), "play");
    const node = spyOn(TestBed.inject(MemoryService).SetNode, "next");
    await component.click();
    expect(play).not.toHaveBeenCalled();
    expect(node).toHaveBeenCalled();
  });

  it("shows the full name by default", async () => {
    await create(live, ViewMode.All, { get_epg: [] });
    expect(element.querySelector(".channel-title")?.textContent?.trim()).toBe("TR: Kanal D");
    expect(element.querySelector(".country-badge")).toBeNull();
  });

  it("drops the country prefix in the 'hide' mode", async () => {
    await create(live, ViewMode.All, { get_epg: [] }, () => {
      TestBed.inject(MemoryService).CountryPrefixMode = "hide";
    });
    expect(element.querySelector(".channel-title")?.textContent?.trim()).toBe("Kanal D");
    expect(element.querySelector(".country-badge")).toBeNull();
    expect(tile().getAttribute("aria-label")).toBe("TR: Kanal D");
  });

  it("shows the country code as a badge in the 'badge' mode", async () => {
    await create(live, ViewMode.All, { get_epg: [] }, () => {
      TestBed.inject(MemoryService).CountryPrefixMode = "badge";
    });
    expect(element.querySelector(".country-badge")?.textContent?.trim()).toBe("TR");
    expect(element.querySelector(".channel-title")?.textContent).toContain("Kanal D");
    expect(element.querySelector(".channel-title")?.textContent).not.toContain("TR:");
    expect(tile().getAttribute("aria-label")).toBe("TR: Kanal D");
  });

  it("shows the current and the next programme of a live channel", async () => {
    await create(live, ViewMode.All, {
      get_epg: [programme("Haberler", -30, 30), programme("Film", 30, 120)],
    });
    await settle();
    fixture.detectChanges();
    expect(element.querySelector(".now-title")?.textContent).toContain("Haberler");
    expect(element.querySelector(".now-time")?.textContent).toContain("–");
    expect(component.nowPlayingProgress).toBeCloseTo(50, 0);
    const next = element.querySelector(".next-line")?.textContent ?? "";
    expect(next).toContain("PLAYER.NEXT");
    expect(next).toContain("Film");
    expect(tile().getAttribute("aria-label")).toContain("Haberler");
  });

  it("keeps a live channel without EPG compact", async () => {
    await create(live, ViewMode.All, { get_epg: [] });
    await settle();
    fixture.detectChanges();
    expect(element.querySelector(".now-playing")).toBeNull();
    expect(tile().classList).not.toContain("has-now-playing");
  });

  it("offers the EPG assignment for live channels when an XMLTV guide exists", async () => {
    await create(live, ViewMode.All, { get_epg: [] });
    const memory = TestBed.inject(MemoryService);
    memory.HasXmltv = false;
    expect(component.canMapEpg()).toBeFalse();
    memory.HasXmltv = true;
    expect(component.canMapEpg()).toBeTrue();
    component.channel = movie;
    expect(component.canMapEpg()).toBeFalse();
  });

  it("reloads the now-playing line after the EPG was assigned", async () => {
    await create(live, ViewMode.All, { get_epg: [] });
    await settle();
    const getNowPlaying = spyOn(TestBed.inject(NowPlayingService), "getNowPlaying").and.resolveTo(
      undefined,
    );
    const instance: Record<string, unknown> = {};
    const open = spyOn(TestBed.inject(NgbModal), "open").and.returnValue({
      componentInstance: instance,
      result: Promise.resolve(true),
    } as unknown as NgbModalRef);
    component.openEpgMapping();
    expect(open).toHaveBeenCalled();
    expect(instance["channel"]).toBe(live);
    await settle();
    expect(getNowPlaying).toHaveBeenCalledOnceWith(live);
    expect(TestBed.inject(MemoryService).ModalRef).toBeUndefined();
  });

  it("shows the channel number in front of the name", async () => {
    await create({ ...live, number: 101 }, ViewMode.All, { get_epg: [] });
    expect(element.querySelector(".channel-number")?.textContent?.trim()).toBe("101");
    expect(tile().getAttribute("aria-label")).toBe("101 TR: Kanal D");
  });

  it("has no number without one", async () => {
    await create(live, ViewMode.All, { get_epg: [] });
    expect(element.querySelector(".channel-number")).toBeNull();
  });

  describe("now/next line", () => {
    it("loads only once the tile comes near the viewport", async () => {
      FakeIntersectionObserver.showOnObserve = false;
      await create(live, ViewMode.All, { get_epg: [programme("Haberler", -30, 30)] });
      await settle();
      expect(callsOf(calls, "get_epg").length).toBe(0);
      const observer = FakeIntersectionObserver.instances[0];
      expect(observer.options?.rootMargin).toBe("200px");
      expect(observer.elements).toEqual([element]);

      observer.show(true);
      await settle();
      fixture.detectChanges();
      expect(callsOf(calls, "get_epg").length).toBe(1);
      expect(element.querySelector(".now-title")?.textContent).toContain("Haberler");
    });

    it("disconnects the observer when the tile goes away", async () => {
      await create(live, ViewMode.All, { get_epg: [] });
      const observer = FakeIntersectionObserver.instances[0];
      fixture.destroy();
      expect(observer.disconnected).toBeTrue();
    });

    it("loads right away without IntersectionObserver", async () => {
      (window as unknown as Record<string, unknown>)["IntersectionObserver"] = undefined;
      await create(live, ViewMode.All, { get_epg: [programme("Haberler", -30, 30)] });
      await settle();
      expect(callsOf(calls, "get_epg").length).toBe(1);
    });

    it("moves the progress on with the shared minute tick", async () => {
      const tick = new Subject<number>();
      await create(live, ViewMode.All, { get_epg: [programme("Haberler", -30, 30)] }, () => {
        (TestBed.inject(NowPlayingService) as unknown as Record<string, unknown>)["minuteTick"] =
          tick;
      });
      await settle();
      expect(component.nowPlayingProgress).toBeCloseTo(50, 0);
      // Half an hour later: the bar is full, the programme has not ended yet.
      component.nowPlaying!.start_timestamp -= 1790;
      component.nowPlaying!.end_timestamp -= 1790;
      tick.next(1);
      expect(component.nowPlayingProgress).toBeGreaterThan(99);
      expect(callsOf(calls, "get_epg").length).toBe(1);
    });

    it("loads the next programme once the current one ended", async () => {
      const tick = new Subject<number>();
      await create(live, ViewMode.All, { get_epg: [programme("Haberler", -30, 30)] }, () => {
        (TestBed.inject(NowPlayingService) as unknown as Record<string, unknown>)["minuteTick"] =
          tick;
      });
      await settle();
      const getNowPlaying = spyOn(TestBed.inject(NowPlayingService), "getNowPlaying").and.resolveTo(
        undefined,
      );
      component.nowPlaying!.end_timestamp = Math.floor(Date.now() / 1000) - 1;
      tick.next(1);
      expect(getNowPlaying).toHaveBeenCalledOnceWith(live);
    });

    it("ignores ticks while the tile is off screen", async () => {
      const tick = new Subject<number>();
      await create(live, ViewMode.All, { get_epg: [programme("Haberler", -30, 30)] }, () => {
        (TestBed.inject(NowPlayingService) as unknown as Record<string, unknown>)["minuteTick"] =
          tick;
      });
      await settle();
      FakeIntersectionObserver.instances[0].show(false);
      const getNowPlaying = spyOn(TestBed.inject(NowPlayingService), "getNowPlaying").and.resolveTo(
        undefined,
      );
      component.nowPlaying!.end_timestamp = Math.floor(Date.now() / 1000) - 1;
      tick.next(1);
      expect(getNowPlaying).not.toHaveBeenCalled();
      // Back in view: the ended programme is replaced.
      FakeIntersectionObserver.instances[0].show(true);
      expect(getNowPlaying).toHaveBeenCalledOnceWith(live);
    });
  });

  it("copies the resolved stream URL, not the stored one", async () => {
    await create({ ...live, url: "http://host/live/{username}/{password}/3.ts" }, ViewMode.All, {
      get_epg: [],
      resolve_channel_url: "http://host/live/user/pass/3.ts",
    });
    await component.copyURL();
    expect(callsOf(calls, "resolve_channel_url").length).toBe(1);
    const write = calls.find((c) => c.cmd.includes("clipboard"));
    expect(JSON.stringify(write?.args)).toContain("http://host/live/user/pass/3.ts");
  });

  describe("favorites lists", () => {
    const sport = { id: 4, name: "Sport", position: 1, count: 1 };
    const news = { id: 5, name: "News", position: 2, count: 0 };

    async function openMenu(handlers: Record<string, unknown> = {}, viewMode = ViewMode.All) {
      await create(live, viewMode, {
        get_epg: [],
        get_favorite_lists: [sport, news],
        get_channel_favorite_lists: [4],
        ...handlers,
      });
      await TestBed.inject(FavoriteListsService).load();
      spyOn(component.matMenuTrigger, "openMenu");
      component.openContextMenuFromKeyboard();
      await settle();
    }

    it("loads the check marks when the menu opens", async () => {
      await openMenu();
      expect(callsOf(calls, "get_channel_favorite_lists").map((c) => c.args)).toEqual([
        { channel: live },
      ]);
      expect(component.isInList(sport)).toBeTrue();
      expect(component.isInList(news)).toBeFalse();
    });

    it("toggles the channel in a list", async () => {
      await openMenu();
      await component.toggleList(news);
      expect(callsOf(calls, "add_to_favorite_list").map((c) => c.args)).toEqual([
        { listId: 5, channel: live },
      ]);
      expect(component.isInList(news)).toBeTrue();
      await component.toggleList(sport);
      expect(callsOf(calls, "remove_from_favorite_list").map((c) => c.args)).toEqual([
        { listId: 4, channel: live },
      ]);
      expect(component.isInList(sport)).toBeFalse();
    });

    it("keeps the check mark when the backend refuses", async () => {
      await openMenu({
        add_to_favorite_list: () => {
          throw "nope";
        },
      });
      await component.toggleList(news);
      expect(component.isInList(news)).toBeFalse();
    });

    it("creates a list and puts the channel into it", async () => {
      await openMenu({ create_favorite_list: 5 });
      spyOn(TestBed.inject(NgbModal), "open").and.returnValue({
        componentInstance: {},
        result: Promise.resolve("News"),
      } as unknown as NgbModalRef);
      await component.addToNewList();
      expect(callsOf(calls, "create_favorite_list").map((c) => c.args)).toEqual([{ name: "News" }]);
      expect(callsOf(calls, "add_to_favorite_list").map((c) => c.args)).toEqual([
        { listId: 5, channel: live },
      ]);
    });

    it("removes the channel from the shown list and reloads", async () => {
      await openMenu({}, ViewMode.Favorites);
      component.favoriteList = 4;
      const refresh = spyOn(TestBed.inject(MemoryService).Refresh, "next");
      await component.removeFromList();
      expect(callsOf(calls, "remove_from_favorite_list").map((c) => c.args)).toEqual([
        { listId: 4, channel: live },
      ]);
      expect(refresh).toHaveBeenCalledWith(false);
    });
  });

  describe("context menu", () => {
    const serie: Channel = {
      id: 7,
      name: "Show",
      media_type: MediaType.serie,
      source_id: 1,
      url: "123",
      favorite: false,
    };

    /// Opens the menu (as by the ContextMenu key) and returns its items.
    async function openMenu(
      channel: Channel,
      viewMode = ViewMode.All,
      setup: () => void = () => undefined,
    ): Promise<HTMLElement[]> {
      await create(channel, viewMode, { get_epg: [] }, setup);
      component.openContextMenuFromKeyboard();
      await settle();
      fixture.detectChanges();
      return items();
    }

    function items(): HTMLElement[] {
      return Array.from(
        document.querySelectorAll<HTMLElement>(".mat-mdc-menu-panel .mat-mdc-menu-item"),
      );
    }

    function labels(): string[] {
      return items().map((item) => item.textContent?.trim() ?? "");
    }

    it("leaves out the actions that do not apply instead of hiding them", async () => {
      await openMenu(live);
      // Hidden items would still take the keyboard focus: they must not exist.
      expect(labels()).toContain("MENU.RECORD");
      expect(labels()).toContain("MENU.COPY_URL");
      expect(labels()).not.toContain("MENU.REMOVE");
      expect(labels()).not.toContain("MENU.DOWNLOAD");
      expect(labels()).not.toContain("MENU.DELETE");
      expect(labels()).not.toContain("MENU.LOCK_GROUP");
      expect(items().every((item) => !item.hidden)).toBeTrue();
    });

    it("separates the groups with dividers", async () => {
      await openMenu(live);
      expect(document.querySelectorAll(".mat-mdc-menu-panel mat-divider").length).toBeGreaterThan(
        0,
      );
    });

    it("offers no URL to copy for a series", async () => {
      await openMenu(serie);
      expect(labels()).not.toContain("MENU.COPY_URL");
      expect(labels()).toContain("MENU.FAVORITE");
    });

    it("offers no group lock without a parental PIN", async () => {
      await openMenu(group, ViewMode.Categories);
      expect(labels()).not.toContain("MENU.LOCK_GROUP");
    });

    it("offers the group lock once a parental PIN is set", async () => {
      await openMenu(group, ViewMode.Categories, () => {
        TestBed.inject(MemoryService).HasParentalPin = true;
      });
      expect(labels()).toContain("MENU.LOCK_GROUP");
    });

    it("marks deleting a custom channel as dangerous", async () => {
      await openMenu(live, ViewMode.All, () => {
        TestBed.inject(MemoryService).CustomSourceIds.add(1);
      });
      const remove = items().find((item) => item.textContent?.trim() === "MENU.DELETE");
      expect(remove?.classList).toContain("menu-item-danger");
    });

    it("gives the focus back to the tile when the menu closes", async () => {
      await openMenu(live);
      expect(document.activeElement).not.toBe(tile());
      component.matMenuTrigger.closeMenu();
      expect(document.activeElement).toBe(tile());
    });
  });

  describe("unfavoriting", () => {
    const favorite: Channel = { ...live, favorite: true };

    it("fades the tile in the favorites view", async () => {
      await create({ ...favorite }, ViewMode.Favorites, { get_epg: [], unfavorite_channel: null });
      await component.favorite();
      expect(component.fade).toBeTrue();
    });

    it("keeps the tile in a favorites list, which is kept apart", async () => {
      await create({ ...favorite }, ViewMode.Favorites, {
        get_epg: [],
        unfavorite_channel: null,
        get_favorite_lists: [{ id: 4, name: "Sport", position: 1, count: 1 }],
      });
      await TestBed.inject(FavoriteListsService).load();
      component.favoriteList = 4;
      const toast = spyOn(TestBed.inject(ToastrService), "success");
      await component.favorite();
      expect(component.fade).toBeFalse();
      expect(component.channel?.favorite).toBeFalse();
      expect(toast).toHaveBeenCalledWith("TOAST.FAVORITE_REMOVED_STAYS_IN_LIST");
    });
  });

  it("asks the home page to move the tile", async () => {
    await create(live, ViewMode.Favorites, { get_epg: [] });
    const moves: number[] = [];
    component.move.subscribe((delta) => moves.push(delta));
    component.moveBy(-1);
    component.moveBy(1);
    expect(moves).toEqual([-1, 1]);
  });
});
