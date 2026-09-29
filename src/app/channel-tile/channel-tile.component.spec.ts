import { ComponentFixture, TestBed } from "@angular/core/testing";

import { ChannelTileComponent } from "./channel-tile.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { PlaybackService } from "../playback.service";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { ViewMode } from "../models/viewMode";
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

  async function create(channel: Channel, viewMode = ViewMode.All) {
    calls = mockTauri();
    await TestBed.configureTestingModule({
      declarations: [ChannelTileComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(ChannelTileComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.channel = channel;
    component.id = 0;
    component.viewMode = viewMode;
    fixture.detectChanges();
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
});
