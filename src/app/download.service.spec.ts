import { TestBed } from "@angular/core/testing";
import { provideTranslateService } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";

import { emit } from "@tauri-apps/api/event";
import { DOWNLOAD_HISTORY, DownloadService } from "./download.service";
import { DownloadStatus } from "./models/download";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { PlaybackService } from "./playback.service";
import { IpcCall, callsOf, mockTauri, resetTauri, settle } from "../testing/test-helpers";

describe("DownloadService", () => {
  let service: DownloadService;
  let calls: IpcCall[];
  /// Answer of the backend's download command (the saved file's path).
  let downloadResult: () => unknown;

  function setup() {
    TestBed.configureTestingModule({
      imports: [ToastrModule.forRoot()],
      providers: [provideTranslateService()],
    });
    service = TestBed.inject(DownloadService);
  }

  beforeEach(() => {
    localStorage.removeItem(DOWNLOAD_HISTORY);
    downloadResult = () => "C:/Downloads/a.mp4";
    // The service registers a Tauri progress listener for every queued
    // download; outside the Tauri webview the IPC bridge has to be mocked.
    calls = mockTauri({ download: () => downloadResult() });
    setup();
  });

  afterEach(() => {
    resetTauri();
    localStorage.removeItem(DOWNLOAD_HISTORY);
  });

  it("shows bytes and a transfer rate, also without a known size", async () => {
    let finish!: (path: string) => void;
    downloadResult = () => new Promise<string>((resolve) => (finish = resolve));
    const download = await service.enqueue("1", { id: 1, name: "a" } as Channel);
    await settle();
    expect(download.status).toBe(DownloadStatus.Active);
    await emit("download-bytes-1", { downloaded: 1000, total: null });
    expect(download.downloaded).toBe(1000);
    expect(download.total).toBeNull();
    expect(download.speed).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await emit("download-bytes-1", { downloaded: 3000, total: null });
    expect(download.downloaded).toBe(3000);
    expect(download.speed).toBeGreaterThan(0);
    finish("C:/Downloads/a.mp4");
    await settle();
    expect(download.status).toBe(DownloadStatus.Completed);
    expect(download.filePath).toBe("C:/Downloads/a.mp4");
    expect(download.speed).toBeUndefined();
  });

  it("starts fresh, but a retry continues the partial file", async () => {
    downloadResult = () => Promise.reject("connection reset");
    const channel = { id: 1, name: "a" } as Channel;
    await service.enqueue("1", channel, "D:/a.mp4");
    await settle();
    expect(callsOf(calls, "download")[0].args).toEqual(
      jasmine.objectContaining({ downloadId: "1", path: "D:/a.mp4", resume: false }),
    );
    const failed = service.History[0];
    expect(failed.status).toBe(DownloadStatus.Failed);
    expect(failed.error).toBe("connection reset");
    downloadResult = () => "D:/a.mp4";
    await service.retry(failed);
    await settle();
    expect(callsOf(calls, "download")[1].args).toEqual(
      jasmine.objectContaining({ downloadId: "1", path: "D:/a.mp4", resume: true }),
    );
    expect(service.History[0].status).toBe(DownloadStatus.Completed);
  });

  it("shows a finished file in its folder and plays it", async () => {
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    await service.enqueue("1", { id: 1, name: "Film" } as Channel);
    await settle();
    const done = service.History[0];
    await service.reveal(done);
    expect(callsOf(calls, "reveal_path")[0].args).toEqual({ path: "C:/Downloads/a.mp4" });
    await service.play(done);
    expect(play).toHaveBeenCalledWith(
      {
        id: -1,
        name: "Film",
        url: "C:/Downloads/a.mp4",
        media_type: MediaType.movie,
        favorite: false,
      },
      [],
    );
  });

  it("keeps the finished downloads across restarts", async () => {
    await service.enqueue("1", { id: 1, name: "Film" } as Channel);
    await settle();
    const stored = JSON.parse(localStorage.getItem(DOWNLOAD_HISTORY) ?? "[]");
    expect(stored.length).toBe(1);
    expect(stored[0]).toEqual(
      jasmine.objectContaining({ id: "1", status: "completed", filePath: "C:/Downloads/a.mp4" }),
    );
    // A new app start restores them.
    TestBed.resetTestingModule();
    setup();
    expect(service.History.length).toBe(1);
    expect(service.History[0].channel.name).toBe("Film");
    expect(service.History[0].filePath).toBe("C:/Downloads/a.mp4");
    expect(service.History[0].progress).toBe(100);
    service.clearHistory();
    expect(JSON.parse(localStorage.getItem(DOWNLOAD_HISTORY) ?? "null")).toEqual([]);
  });

  it("starts with an empty history when the stored one is unreadable", () => {
    localStorage.setItem(DOWNLOAD_HISTORY, "{not json");
    TestBed.resetTestingModule();
    setup();
    expect(service.History).toEqual([]);
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("keeps queued downloads in order and only starts one at a time by default", async () => {
    service.Paused = true;
    await service.enqueue("1", { id: 1, name: "a", favorite: false } as Channel);
    await service.enqueue("2", { id: 2, name: "b", favorite: false } as Channel);
    expect(Array.from(service.Downloads.keys())).toEqual(["1", "2"]);
    expect(service.MaxConcurrent).toBe(1);
    expect(service.queuedCount()).toBe(2);
    expect(service.activeCount()).toBe(0);
  });

  it("concurrent enqueues of the same id share one download", async () => {
    service.Paused = true;
    const channel = { id: 1, name: "a", favorite: false } as Channel;
    const [first, second] = await Promise.all([
      service.enqueue("1", channel),
      service.enqueue("1", channel),
    ]);
    expect(first).toBe(second);
    expect(service.Downloads.size).toBe(1);
  });

  it("reorders queued downloads", async () => {
    service.Paused = true;
    await service.enqueue("1", { id: 1, name: "a", favorite: false } as Channel);
    await service.enqueue("2", { id: 2, name: "b", favorite: false } as Channel);
    service.moveUp("2");
    expect(Array.from(service.Downloads.keys())).toEqual(["2", "1"]);
    expect(service.canMoveUp("2")).toBeFalse();
  });

  it("cancelling a queued download moves it to the history", async () => {
    service.Paused = true;
    const download = await service.enqueue("1", { id: 1, name: "a", favorite: false } as Channel);
    await service.abortDownload("1");
    expect(service.Downloads.size).toBe(0);
    expect(service.History[0]).toBe(download);
    expect(download.status).toBe(DownloadStatus.Cancelled);
  });
});
