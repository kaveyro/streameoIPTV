import { ComponentFixture, TestBed } from "@angular/core/testing";

import { ChannelTileComponent } from "./channel-tile.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { PlaybackService } from "../playback.service";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { ViewMode } from "../models/viewMode";
import { EPG } from "../models/epg";
import { CountryNamePipe } from "../pipes/country-name.pipe";
import { NowPlayingService } from "../now-playing.service";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("ChannelTileComponent", () => {
  let component: ChannelTileComponent;
  let fixture: ComponentFixture<ChannelTileComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  async function create(
    channel: Channel,
    viewMode = ViewMode.All,
    handlers: Record<string, unknown> = {},
    setup: () => void = () => {},
  ) {
    calls = mockTauri(handlers);
    await TestBed.configureTestingModule({
      declarations: [ChannelTileComponent, CountryNamePipe],
      imports: TEST_IMPORTS,
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

  afterEach(() => resetTauri());

  const movie: Channel = { id: 1, name: "Movie", media_type: MediaType.movie, favorite: false };
  const group: Channel = { id: 9, name: "Kids", media_type: MediaType.group, favorite: false };

  it("should create", async () => {
    await create(movie);
    expect(component).toBeTruthy();
    expect(element.querySelector(".channel-title")?.textContent).toContain("Movie");
  });

  it("shows the resume badge for movies in the history only", async () => {
    await create(movie, ViewMode.History);
    expect(element.querySelector(".resume-badge")?.textContent).toContain("TILE.RESUME");
    component.viewMode = ViewMode.All;
    fixture.detectChanges();
    expect(element.querySelector(".resume-badge")).toBeNull();
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
    expect(play).toHaveBeenCalledOnceWith(movie);
    expect(callsOf(calls, "add_last_watched").map((c) => c.args)).toEqual([{ id: 1 }]);
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
});
