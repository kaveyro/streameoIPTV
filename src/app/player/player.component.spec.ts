import {
  ComponentFixture,
  TestBed,
  discardPeriodicTasks,
  fakeAsync,
  flush,
  flushMicrotasks,
  tick,
} from "@angular/core/testing";
import { emit } from "@tauri-apps/api/event";

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

  it("keeps an error over the video, with the explained text and what to do", async () => {
    await openFirst();
    const toast = spyOn(TestBed.inject(ErrorService), "handleError");
    component.onPlayerError("loading failed");
    expect(statusTexts()).toEqual([
      "TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING\nPLAYER.ERROR_RETRY_HINT",
    ]);
    // Not also as a passing message, and no toast hidden behind the video.
    expect(osdTexts().some((t) => t.startsWith("TOAST.PLAYER_ERROR"))).toBeFalse();
    expect(toast).not.toHaveBeenCalled();
    // mpv retrying the stream: the error stays, without "Connecting…".
    component.onPlayerStatus("connecting");
    component.onPlayerError("loading failed");
    await new Promise((resolve) => setTimeout(resolve, PlayerComponent.CONNECTING_STATUS_MS + 50));
    expect(statusTexts().length).toBe(1);
    // It plays after all: the error goes.
    component.onPlayerStatus("playing");
    expect(statusTexts()).toEqual([jasmine.any(String), null]);
  });

  it("offers the previous channel in the error when there is one", async () => {
    await openFirst();
    await component.switch(channels[1]);
    component.onPlayerStatus("connecting");
    component.onPlayerError("something odd");
    expect(statusTexts()).toContain(
      "TOAST.PLAYER_ERROR: something odd\nPLAYER.ERROR_RETRY_HINT · PLAYER.ERROR_LAST_HINT",
    );
  });

  it("retries the failed channel on Enter, from mpv and from the page", async () => {
    await openFirst();
    // Nothing failed: Enter does nothing.
    component.handlePlayerKey("commit");
    await settle();
    expect(plays()).toEqual([1]);
    component.onPlayerError("loading failed");
    component.handlePlayerKey("commit");
    await settle();
    expect(plays()).toEqual([1, 1]);
    // The retry removed the error.
    expect(statusTexts()[statusTexts().length - 1]).toBeNull();
    component.onPlayerStatus("connecting");
    component.onPlayerError("loading failed");
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await settle();
    expect(plays()).toEqual([1, 1, 1]);
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

    it("replaces the status with the error when the stream fails", () => {
      component.onPlayerStatus("buffering");
      jasmine.clock().tick(PlayerComponent.BUFFERING_STATUS_MS + 1);
      expect(statusTexts()).toEqual(["PLAYER.BUFFERING"]);
      component.onPlayerError("loading failed");
      expect(statusTexts()).toEqual([
        "PLAYER.BUFFERING",
        "TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING\nPLAYER.ERROR_RETRY_HINT",
      ]);
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
    // Highlighted at once, opened once the keys rest.
    expect(component.current?.id).toBe(3);
    expect(component.zapDigits).toBe("");
    await new Promise((resolve) => setTimeout(resolve, PlayerComponent.ZAP_DEBOUNCE_MS + 50));
    expect(plays()).toEqual([1, 3]);
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
    expect(statusTexts().some((t) => String(t).startsWith("TOAST.PLAYER_ERROR"))).toBeFalse();
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
      expect(statusTexts()).toEqual([]);
      jasmine.clock().tick(2);
      expect(statusTexts()).toEqual([
        "TOAST.PLAYER_ERROR: PLAYER.ERR_LOADING\nPLAYER.ERROR_RETRY_HINT · PLAYER.ERROR_LAST_HINT",
      ]);
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

  /** Opens the player inside fakeAsync (mocked IPC answers are microtasks). */
  function openFirstSync() {
    component.open(channels[0]);
    flushMicrotasks();
    tick();
    fixture.detectChanges();
    component.onPlayerStatus("connecting");
    component.onPlayerStatus("playing");
  }

  /** mpv starts the stream of the latest switch and shows pictures. */
  function streamStarts() {
    component.onPlayerStatus("connecting");
    component.onPlayerStatus("playing");
  }

  const history = () => callsOf(calls, "add_last_watched").map((c) => c.args["id"]);

  it("keeps catch-up and recordings out of the history", fakeAsync(() => {
    openFirstSync();
    component.switch({ id: -1, url: "http://example.test/archive", name: "Past" });
    flushMicrotasks();
    streamStarts();
    tick(PlayerComponent.HISTORY_DELAY_MS + 10);
    component.switch(channels[2]);
    flushMicrotasks();
    streamStarts();
    tick(PlayerComponent.HISTORY_DELAY_MS + 10);
    expect(history()).toEqual([3]);
    discardPeriodicTasks();
  }));

  it("writes the history only once a channel played a few seconds", fakeAsync(() => {
    openFirstSync();
    component.switch(channels[1]);
    flushMicrotasks();
    // Not before it shows pictures.
    tick(PlayerComponent.HISTORY_DELAY_MS + 10);
    expect(history()).toEqual([]);
    streamStarts();
    tick(PlayerComponent.HISTORY_DELAY_MS - 100);
    // Left before: never counted.
    component.switch(channels[2]);
    flushMicrotasks();
    tick(200);
    expect(history()).toEqual([]);
    streamStarts();
    tick(PlayerComponent.HISTORY_DELAY_MS + 10);
    expect(history()).toEqual([3]);
    discardPeriodicTasks();
  }));

  describe("zapping", () => {
    const many = [1, 2, 3, 4, 5, 6].map((id) => live(id, `Ch ${id}`));
    const banners = () =>
      callsOf(calls, "player_osd_banner").map((c) => (c.args["banner"] as { title: string }).title);

    it("opens one stream for quick steps, highlighting each at once", fakeAsync(() => {
      memory.PlayerChannelList = many;
      openFirstSync();
      component.next();
      component.handlePlayerKey("next");
      tick(100);
      component.next();
      // The highlight and the banner follow every step.
      expect(component.current?.id).toBe(4);
      expect(banners().slice(-3)).toEqual(["Ch 2", "Ch 3", "Ch 4"]);
      flushMicrotasks();
      expect(plays()).toEqual([1]);
      tick(PlayerComponent.ZAP_DEBOUNCE_MS - 50);
      expect(plays()).toEqual([1]);
      tick(60);
      flushMicrotasks();
      expect(plays()).toEqual([1, 4]);
      // The steps in between are no "last channel".
      expect(component.previous?.id).toBe(1);
      flush();
      discardPeriodicTasks();
    }));

    it("opens nothing when the steps lead back to the channel on screen", fakeAsync(() => {
      memory.PlayerChannelList = many;
      openFirstSync();
      component.next();
      component.prev();
      tick(PlayerComponent.ZAP_DEBOUNCE_MS + 50);
      flushMicrotasks();
      expect(plays()).toEqual([1]);
      expect(component.current?.id).toBe(1);
      flush();
      discardPeriodicTasks();
    }));

    it("plays a pick from the list at once, also the one zapped to", fakeAsync(() => {
      memory.PlayerChannelList = many;
      openFirstSync();
      component.next();
      component.switch(many[1]);
      flushMicrotasks();
      expect(plays()).toEqual([1, 2]);
      tick(PlayerComponent.ZAP_DEBOUNCE_MS + 50);
      flushMicrotasks();
      expect(plays()).toEqual([1, 2]);
      flush();
      discardPeriodicTasks();
    }));
  });

  describe("keys in the WebView", () => {
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(event);
      return event;
    };
    const commands = () => callsOf(calls, "player_command").map((c) => c.args["command"]);

    it("zaps once for a held key", async () => {
      await openFirst();
      const held = press("PageDown", { repeat: true });
      expect(held.defaultPrevented).toBeTrue();
      expect(component.current?.id).toBe(1);
      press("ArrowDown", { repeat: true });
      expect(component.current?.id).toBe(1);
      press("PageDown");
      expect(component.current?.id).toBe(2);
    });

    it("seeks a minute with Up/Down in a movie instead of zapping", async () => {
      memory.PlayerChannelList = [];
      const movie: Channel = { ...live(9, "Film"), media_type: MediaType.movie };
      await component.open(movie);
      await settle();
      press("ArrowUp");
      press("ArrowDown", { repeat: true });
      expect(commands()).toEqual(["seek_forward", "seek_back"]);
      expect(component.current?.id).toBe(9);
      await settle();
      expect(plays()).toEqual([9]);
    });

    it("changes the volume with + and -", async () => {
      await openFirst();
      press("+");
      press("-", { code: "NumpadSubtract" });
      press("+", { repeat: true });
      expect(commands()).toEqual(["volume_up", "volume_down", "volume_up"]);
      // Typed into the filter field, not taken as volume.
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        ".player-list-search",
      );
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true }));
      expect(commands().length).toBe(3);
    });
  });

  describe("side list numbers", () => {
    const numbered = (id: number, name: string, number: number, source_id = 1): Channel => ({
      ...live(id, name),
      number,
      source_id,
    });
    const names = () =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".player-list-item")).map(
        (item) => item.querySelector(".pli-num")?.textContent?.trim(),
      );

    it("shows the places of an unnumbered list and finds them with the filter", async () => {
      await openFirst();
      fixture.detectChanges();
      expect(names()).toEqual(["1", "2", "3"]);
      component.filterText = "2";
      expect(component.visibleChannels.map((c) => c.id)).toEqual([2]);
      component.filterText = "thr";
      expect(component.visibleChannels.map((c) => c.id)).toEqual([3]);
    });

    it("shows provider numbers and prefers the current source for a typed one", async () => {
      const list = [
        numbered(1, "One", 1, 1),
        numbered(2, "Two", 2, 1),
        numbered(12, "Twelve", 12, 1),
        numbered(21, "Other one", 1, 2),
        numbered(22, "Other two", 2, 2),
      ];
      memory.PlayerChannelList = list;
      await component.open(list[3]);
      await settle();
      fixture.detectChanges();
      expect(names()).toEqual(["1", "2", "12", "1", "2"]);
      component.filterText = "1";
      expect(component.visibleChannels.map((c) => c.id)).toEqual([1, 12, 21]);
      component.filterText = "";
      component.handlePlayerKey("digit-2");
      component.handlePlayerKey("commit");
      await settle();
      expect(component.current?.id).toBe(22);
    });
  });

  it("brings the live list back after catch-up", async () => {
    await openFirst();
    await component.switch(channels[1]);
    // Catch-up comes with an empty list (nothing to zap to).
    memory.PlayerChannelList = [];
    await component.open({
      id: -1,
      url: "http://example.test/archive",
      name: "Two · Past (Sat 3 Oct, 20:00)",
      media_type: MediaType.movie,
    });
    await settle();
    expect(component.channels).toEqual([]);
    component.handlePlayerKey("last");
    await settle();
    expect(component.current?.id).toBe(2);
    expect(component.channels).toBe(channels);
  });

  it("warns over the video when a recording needs the connection", async () => {
    await settle();
    await openFirst();
    await emit("recording-source-busy", { title: "Match" });
    await settle();
    expect(osdTexts()).toContain("PLAYER.RECORDING_SOURCE_BUSY");
  });
});
