import { TestBed } from "@angular/core/testing";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { emit } from "@tauri-apps/api/event";
import { RestreamService, restreamUrlFor } from "./restream.service";
import { RestreamModalComponent } from "./restream-modal/restream-modal.component";
import { PlaybackService } from "./playback.service";
import { ErrorService } from "./error.service";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import {
  IpcCall,
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../testing/test-helpers";

describe("RestreamService", () => {
  const channel: Channel = { id: 7, name: "News", media_type: MediaType.livestream };
  let calls: IpcCall[];
  let service: RestreamService;
  /// Resolves the pending start_restream (the restream ended).
  let endRestream: (error?: string) => void;

  async function setup(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({
      start_restream: () =>
        new Promise<void>((resolve, reject) => {
          endRestream = (error) => (error ? reject(error) : resolve());
        }),
      restream_url: ({ port }: Record<string, unknown>) =>
        `http://127.0.0.1:${port}/abc/stream.m3u8`,
      ...handlers,
    });
    TestBed.configureTestingModule({
      declarations: [RestreamModalComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    });
    service = TestBed.inject(RestreamService);
    // The event listeners register asynchronously.
    await settle();
  }

  afterEach(() => resetTauri());

  it("goes from starting to running once ffmpeg delivers, and back to idle", async () => {
    await setup();
    expect(service.active).toBeFalse();
    const run = service.start(channel, 3000);
    expect(service.state).toBe("starting");
    expect(service.channel).toBe(channel);
    await settle();
    expect(callsOf(calls, "start_restream")[0].args).toEqual({ channel, port: 3000 });
    await emit("restream_started", true);
    await settle();
    expect(service.state).toBe("running");
    await emit("restream_stopped", { reason: "stopped" });
    endRestream();
    await run;
    expect(service.state).toBe("idle");
    expect(service.channel).toBeUndefined();
  });

  it("stops the running restream", async () => {
    await setup();
    void service.start(channel, 3000);
    await emit("restream_started", true);
    await settle();
    await service.stop();
    expect(service.state).toBe("stopping");
    expect(callsOf(calls, "stop_restream").length).toBe(1);
  });

  it("reports an unexpected end with its reason, once", async () => {
    await setup();
    const error = spyOn(TestBed.inject(ErrorService), "handleError");
    const run = service.start(channel, 3000);
    await emit("restream_started", true);
    await settle();
    await emit("restream_stopped", { reason: "ffmpeg_exited" });
    await settle();
    expect(service.state).toBe("idle");
    endRestream("ffmpeg exited");
    await run;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("ffmpeg_exited", "RESTREAM.STOPPED_FFMPEG");
  });

  it("says nothing when the user stopped it", async () => {
    await setup();
    const error = spyOn(TestBed.inject(ErrorService), "handleError");
    const run = service.start(channel, 3000);
    await emit("restream_started", true);
    await settle();
    await service.stop();
    await emit("restream_stopped", { reason: "stopped" });
    endRestream();
    await run;
    expect(error).not.toHaveBeenCalled();
  });

  it("plays the restream in the embedded player, as others receive it", async () => {
    await setup();
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    void service.start(channel, 3001);
    await emit("restream_started", true);
    await settle();
    await service.watch();
    expect(callsOf(calls, "restream_url")[0].args).toEqual({ port: 3001 });
    expect(play).toHaveBeenCalledWith(
      {
        id: -1,
        name: "News (Restream)",
        url: "http://127.0.0.1:3001/abc/stream.m3u8",
        media_type: MediaType.livestream,
        favorite: false,
      },
      [],
    );
  });

  it("opens one closable dialog, showing the running restream", async () => {
    await setup();
    const modal = TestBed.inject(NgbModal);
    const open = spyOn(modal, "open").and.callThrough();
    void service.start(channel, 3000);
    const ref = service.open({ id: 8, name: "Other" });
    expect(open.calls.mostRecent().args[1]).toEqual({ size: "xl" });
    expect(ref.componentInstance.channel).toBe(channel);
    expect(service.open()).toBe(ref);
    modal.dismissAll();
  });

  it("builds the address for another host from the local URL", () => {
    const local = "http://127.0.0.1:3000/abc/stream.m3u8";
    expect(restreamUrlFor(local, "192.168.1.2")).toBe("http://192.168.1.2:3000/abc/stream.m3u8");
    expect(restreamUrlFor(local, "fe80::1")).toBe("http://[fe80::1]:3000/abc/stream.m3u8");
    expect(restreamUrlFor("", "192.168.1.2")).toBeUndefined();
  });
});
