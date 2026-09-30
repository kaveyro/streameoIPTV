import { TestBed } from "@angular/core/testing";
import { provideTranslateService } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";

import { DownloadService } from "./download.service";
import { DownloadStatus } from "./models/download";
import { Channel } from "./models/channel";
import { mockTauri, resetTauri } from "../testing/test-helpers";

describe("DownloadService", () => {
  let service: DownloadService;
  beforeEach(() => {
    // The service registers a Tauri progress listener for every queued
    // download; outside the Tauri webview the IPC bridge has to be mocked.
    mockTauri();
    TestBed.configureTestingModule({
      imports: [ToastrModule.forRoot()],
      providers: [provideTranslateService()],
    });
    service = TestBed.inject(DownloadService);
  });

  afterEach(() => resetTauri());

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
