import { TestBed } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";

import { DownloadService } from "./download.service";
import { DownloadStatus } from "./models/download";

describe("DownloadService", () => {
  let service: DownloadService;
  let tauriInternals: any;

  beforeEach(() => {
    // The service registers a Tauri progress listener for every queued
    // download; outside the Tauri webview that global has to be stubbed.
    tauriInternals = (window as any).__TAURI_INTERNALS__;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: () => Promise.resolve(1),
    };
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot(), ToastrModule.forRoot()],
    });
    service = TestBed.inject(DownloadService);
  });

  afterEach(() => {
    (window as any).__TAURI_INTERNALS__ = tauriInternals;
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("keeps queued downloads in order and only starts one at a time by default", async () => {
    service.Paused = true;
    await service.enqueue("1", { id: 1, name: "a", favorite: false } as any);
    await service.enqueue("2", { id: 2, name: "b", favorite: false } as any);
    expect(Array.from(service.Downloads.keys())).toEqual(["1", "2"]);
    expect(service.MaxConcurrent).toBe(1);
    expect(service.queuedCount()).toBe(2);
    expect(service.activeCount()).toBe(0);
  });

  it("concurrent enqueues of the same id share one download", async () => {
    service.Paused = true;
    const channel = { id: 1, name: "a", favorite: false } as any;
    const [first, second] = await Promise.all([
      service.enqueue("1", channel),
      service.enqueue("1", channel),
    ]);
    expect(first).toBe(second);
    expect(service.Downloads.size).toBe(1);
  });

  it("reorders queued downloads", async () => {
    service.Paused = true;
    await service.enqueue("1", { id: 1, name: "a", favorite: false } as any);
    await service.enqueue("2", { id: 2, name: "b", favorite: false } as any);
    service.moveUp("2");
    expect(Array.from(service.Downloads.keys())).toEqual(["2", "1"]);
    expect(service.canMoveUp("2")).toBeFalse();
  });

  it("cancelling a queued download moves it to the history", async () => {
    service.Paused = true;
    const download = await service.enqueue("1", { id: 1, name: "a", favorite: false } as any);
    await service.abortDownload("1");
    expect(service.Downloads.size).toBe(0);
    expect(service.History[0]).toBe(download);
    expect(download.status).toBe(DownloadStatus.Cancelled);
  });
});
