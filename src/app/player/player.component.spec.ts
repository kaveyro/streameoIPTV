import { ComponentFixture, TestBed } from "@angular/core/testing";

import { PlayerComponent, playbackErrorKey, sameChannel } from "./player.component";
import { MemoryService } from "../memory.service";
import { ErrorService } from "../error.service";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("PlayerComponent", () => {
  let component: PlayerComponent;
  let fixture: ComponentFixture<PlayerComponent>;
  let calls: IpcCall[];
  let memory: MemoryService;

  const live = (id: number, name: string): Channel => ({
    id,
    name,
    url: `http://example.test/${id}.ts`,
    media_type: MediaType.livestream,
    favorite: false,
    source_id: 1,
  });
  const channels = [live(1, "One"), live(2, "Two"), live(3, "Three")];

  beforeEach(async () => {
    calls = mockTauri();
    await TestBed.configureTestingModule({
      declarations: [PlayerComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    }).compileComponents();
    memory = TestBed.inject(MemoryService);
    memory.PlayerChannelList = channels;
    // The fallback to other feeds would look up alternatives first.
    memory.AutoFallback = false;
    fixture = TestBed.createComponent(PlayerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  async function openFirst() {
    await component.open(channels[0]);
    await settle();
    fixture.detectChanges();
    // mpv started the file and shows it.
    component.onPlayerStatus("connecting");
    component.onPlayerStatus("playing");
  }

  const plays = () => callsOf(calls, "player_play").map((c) => (c.args["channel"] as Channel).id);
  const osdTexts = () => callsOf(calls, "player_osd").map((c) => c.args["message"] as string);
  const statusTexts = () => callsOf(calls, "player_status").map((c) => c.args["text"]);

  it("explains known mpv errors and leaves unknown ones as they are", () => {
    expect(playbackErrorKey("loading failed")).toBe("PLAYER.ERR_LOADING");
    expect(playbackErrorKey("unrecognized file format")).toBe("PLAYER.ERR_FORMAT");
    expect(playbackErrorKey("no audio or video data played")).toBe("PLAYER.ERR_NO_DATA");
    expect(playbackErrorKey("audio output initialization failed")).toBe("PLAYER.ERR_AUDIO_OUTPUT");
    expect(playbackErrorKey("video output initialization failed")).toBe("PLAYER.ERR_VIDEO_OUTPUT");
    expect(playbackErrorKey("not supported")).toBe("PLAYER.ERR_UNSUPPORTED");
    expect(playbackErrorKey("HTTP error 403 Forbidden")).toBe("PLAYER.ERR_NETWORK");
    expect(playbackErrorKey("something odd")).toBeUndefined();
  });

  it("tells pseudo channels apart by their URL", () => {
    const a: Channel = { id: -1, url: "http://example.test/a", name: "A" };
    const b: Channel = { id: -1, url: "http://example.test/b", name: "B" };
    expect(sameChannel(a, { ...a })).toBeTrue();
    expect(sameChannel(a, b)).toBeFalse();
    expect(sameChannel(channels[0], { ...channels[0], url: "other" })).toBeTrue();
  });

  it("reports an error over the video only, with the explained text", async () => {
    await openFirst();
    const toast = spyOn(TestBed.inject(ErrorService), "handleError");
    component.onPlayerError("loading failed");
    expect(osdTexts()).toContain("TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING");
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows mpv's own text for an unknown error", async () => {
    await openFirst();
    component.onPlayerError("something odd");
    expect(osdTexts()).toContain("TOAST.PLAYER_ERROR: something odd");
  });

  describe("status text", () => {
    beforeEach(async () => {
      await openFirst();
      jasmine.clock().install();
    });

    afterEach(() => jasmine.clock().uninstall());

    it("shows 'connecting' only when opening takes a while, and removes it", () => {
      component.onPlayerStatus("connecting");
      jasmine.clock().tick(PlayerComponent.CONNECTING_STATUS_MS - 1);
      expect(statusTexts()).toEqual([]);
      jasmine.clock().tick(2);
      expect(statusTexts()).toEqual(["PLAYER.CONNECTING"]);
      component.onPlayerStatus("playing");
      expect(statusTexts()).toEqual(["PLAYER.CONNECTING", null]);
    });

    it("never shows 'buffering' for a short stall", () => {
      component.onPlayerStatus("buffering");
      jasmine.clock().tick(PlayerComponent.BUFFERING_STATUS_MS - 100);
      component.onPlayerStatus("playing");
      jasmine.clock().tick(PlayerComponent.BUFFERING_STATUS_MS);
      expect(statusTexts()).toEqual([]);
    });

    it("removes the status when the stream fails", () => {
      component.onPlayerStatus("buffering");
      jasmine.clock().tick(PlayerComponent.BUFFERING_STATUS_MS + 1);
      expect(statusTexts()).toEqual(["PLAYER.BUFFERING"]);
      component.onPlayerError("loading failed");
      expect(statusTexts()).toEqual(["PLAYER.BUFFERING", null]);
    });
  });

  it("takes a typed channel number on mpv's Enter key", async () => {
    await openFirst();
    component.handlePlayerKey("commit");
    await settle();
    expect(plays()).toEqual([1]);
    component.handlePlayerKey("digit-3");
    component.handlePlayerKey("commit");
    await settle();
    expect(plays()).toEqual([1, 3]);
    expect(component.zapDigits).toBe("");
  });

  it("ignores an error of the stream being replaced", async () => {
    await openFirst();
    const switching = component.switch(channels[1]);
    // The old stream's error arrives while the new play is on its way.
    component.onPlayerError("loading failed");
    await switching;
    component.onPlayerStatus("connecting");
    component.onPlayerStatus("playing");
    await new Promise((resolve) => setTimeout(resolve, PlayerComponent.STALE_ERROR_GRACE_MS + 50));
    expect(osdTexts().some((t) => t.startsWith("TOAST.PLAYER_ERROR"))).toBeFalse();
    // Not marked as failed: picking it again does not restart it.
    await component.switch(channels[1]);
    expect(plays()).toEqual([1, 2]);
  });

  it("counts an error without a new file start after a grace time", async () => {
    await openFirst();
    await component.switch(channels[1]);
    jasmine.clock().install();
    try {
      // A rejected loadfile: no file start follows.
      component.onPlayerError("loading failed");
      jasmine.clock().tick(PlayerComponent.STALE_ERROR_GRACE_MS - 1);
      expect(osdTexts()).not.toContain("TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING");
      jasmine.clock().tick(2);
      expect(osdTexts()).toContain("TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING");
    } finally {
      jasmine.clock().uninstall();
    }
    // Failed: picking it again retries.
    await component.switch(channels[1]);
    expect(plays()).toEqual([1, 2, 2]);
  });

  it("moves from the filter field into the results instead of zapping", async () => {
    await openFirst();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>(".player-list-search");
    expect(input).not.toBeNull();
    input?.focus();
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await settle();
    expect(plays()).toEqual([1]);
    expect(document.activeElement?.classList.contains("player-list-item")).toBeTrue();
  });

  it("rebuilds mpv after playback when a spawn setting changed meanwhile", async () => {
    await openFirst();
    memory.PlayerRebuildPending = true;
    await component.back();
    expect(memory.PlayerRebuildPending).toBeFalse();
    expect(callsOf(calls, "player_destroy").length).toBe(1);
    await component.open(channels[1]);
    await settle();
    expect(callsOf(calls, "player_init").length).toBe(2);
  });

  it("keeps catch-up and recordings out of the history", async () => {
    await openFirst();
    await component.switch({ id: -1, url: "http://example.test/archive", name: "Past" });
    await component.switch(channels[2]);
    expect(callsOf(calls, "add_last_watched").map((c) => c.args["id"])).toEqual([3]);
  });
});
