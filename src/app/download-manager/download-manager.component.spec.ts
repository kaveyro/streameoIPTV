import { ComponentFixture, TestBed } from "@angular/core/testing";
import { TranslatePipe, provideTranslateService } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";
import { Subject } from "rxjs";

import { DownloadManagerComponent } from "./download-manager.component";
import { DownloadService } from "../download.service";
import { Download, DownloadStatus } from "../models/download";
import { mockTauri, resetTauri } from "../../testing/test-helpers";

describe("DownloadManagerComponent", () => {
  let component: DownloadManagerComponent;
  let fixture: ComponentFixture<DownloadManagerComponent>;
  let element: HTMLElement;
  let service: DownloadService;

  function download(overrides: Partial<Download>): Download {
    return {
      id: "1",
      channel: { id: 1, name: "Movie" },
      progress: 0,
      complete: new Subject(),
      progressUpdate: new Subject(),
      status: DownloadStatus.Active,
      ...overrides,
    };
  }

  beforeEach(async () => {
    localStorage.removeItem("downloadHistory");
    mockTauri();
    await TestBed.configureTestingModule({
      declarations: [DownloadManagerComponent],
      imports: [TranslatePipe, ToastrModule.forRoot()],
      providers: [provideTranslateService()],
    }).compileComponents();

    service = TestBed.inject(DownloadService);
    fixture = TestBed.createComponent(DownloadManagerComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
  });

  afterEach(() => {
    resetTauri();
    localStorage.removeItem("downloadHistory");
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("runs the bar instead of standing at 0 % while the size is unknown", () => {
    service.Downloads.set("1", download({ downloaded: 5 * 1024 * 1024, total: null, speed: 1024 }));
    fixture.detectChanges();
    const bar = element.querySelector<HTMLElement>(".progress-bar")!;
    expect(bar.classList).toContain("progress-bar-animated");
    expect(bar.style.width).toBe("100%");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(element.querySelector(".download-name")?.textContent).not.toContain("%");
    const text = element.querySelector(".transfer-text")?.textContent ?? "";
    expect(text).toContain("5");
    expect(text).toContain("DOWNLOAD.SPEED");
  });

  it("shows bytes of the total and the percentage when the size is known", () => {
    service.Downloads.set(
      "1",
      download({ progress: 40, downloaded: 400, total: 1000, speed: 100 }),
    );
    fixture.detectChanges();
    const bar = element.querySelector<HTMLElement>(".progress-bar")!;
    expect(bar.classList).not.toContain("progress-bar-animated");
    expect(bar.style.width).toBe("40%");
    expect(element.textContent).toContain("40%");
    expect(element.querySelector(".transfer-text")?.textContent).toContain("DOWNLOAD.BYTES_OF");
  });

  it("shows the error inline and offers play and folder for finished files", () => {
    service.History = [
      download({ id: "a", status: DownloadStatus.Failed, error: "HTTP 403" }),
      download({ id: "b", status: DownloadStatus.Completed, filePath: "C:/Movies/Movie.mp4" }),
    ];
    fixture.detectChanges();
    const items = element.querySelectorAll(".history-item");
    expect(items[0].querySelector(".history-error")?.textContent).toContain("HTTP 403");
    expect(items[0].querySelector("[aria-label='DOWNLOAD.RETRY']")).not.toBeNull();
    const reveal = spyOn(service, "reveal").and.resolveTo();
    const play = spyOn(service, "play").and.resolveTo();
    items[1].querySelector<HTMLButtonElement>("[aria-label='DOWNLOAD.SHOW_IN_FOLDER']")!.click();
    items[1].querySelector<HTMLButtonElement>("[title='DOWNLOAD.PLAY']")!.click();
    expect(reveal).toHaveBeenCalledWith(service.History[1]);
    expect(play).toHaveBeenCalledWith(service.History[1]);
  });
});
