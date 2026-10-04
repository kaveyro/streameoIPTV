import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import {
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  IpcCall,
  activeModalStub,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../../testing/test-helpers";

import { EpgModalItemComponent } from "./epg-modal-item.component";
import { PlaybackService } from "../../playback.service";
import { ConfirmService } from "../../confirm.service";
import { MemoryService } from "../../memory.service";
import { TranslateService } from "@ngx-translate/core";
import { firstValueFrom } from "rxjs";

describe("EpgModalItemComponent", () => {
  let component: EpgModalItemComponent;
  let fixture: ComponentFixture<EpgModalItemComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;
  let calls: IpcCall[];

  let conflicts: unknown = null;

  beforeEach(async () => {
    conflicts = null;
    calls = mockTauri({ recording_conflicts: () => conflicts });
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [EpgModalItemComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(EpgModalItemComponent);
    component = fixture.componentInstance;
    component.name = "News";
    component.channelId = 5;
    component.epg = {
      epg_id: "e1",
      title: "Evening news",
      description: "Headlines",
      start_time: "20:00",
      start_timestamp: Math.floor(Date.now() / 1000) + 3600,
      end_time: "20:30",
      end_timestamp: Math.floor(Date.now() / 1000) + 5400,
      has_archive: false,
      now_playing: false,
    };
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("offers scheduling a recording for a future programme", () => {
    expect(component.isFuture()).toBeTrue();
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll("button"),
    ).map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("EPG.SCHEDULE_RECORDING");
  });

  describe("the programme on now", () => {
    const labels = () =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll("button")).map((b) =>
        b.getAttribute("aria-label"),
      );

    const now = Math.floor(Date.now() / 1000);

    beforeEach(() => {
      const epg = component.epg;
      if (!epg) throw new Error("no programme");
      component.epg = { ...epg, start_timestamp: now - 600, end_timestamp: now + 1200 };
      component.epg.now_playing = true;
      fixture.detectChanges();
    });

    it("is recorded from now on, and that recording can be stopped", async () => {
      expect(component.isNow()).toBeTrue();
      expect(labels()).toContain("GUIDE.RECORD_FROM_NOW");
      expect(labels()).not.toContain("EPG.SCHEDULE_RECORDING");
      const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        ".epg-record-now",
      );
      button?.click();
      await settle();
      expect(callsOf(calls, "schedule_recording").map((c) => c.args)).toEqual([
        {
          channelId: 5,
          title: "Evening news",
          startTimestamp: now - 600,
          endTimestamp: now + 1200,
        },
      ]);
      component.scheduledRecordingId = 42;
      fixture.detectChanges();
      expect(labels()).toContain("EPG.STOP_RECORDING");
      expect(labels()).not.toContain("GUIDE.RECORD_FROM_NOW");
      await component.cancelScheduledRecording();
      expect(callsOf(calls, "cancel_scheduled_recording").map((c) => c.args)).toEqual([{ id: 42 }]);
    });

    it("asks first when the source has no stream left", async () => {
      conflicts = { overlapping: 1, max_streams: 1, source_name: "Main" };
      const confirm = spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(false);
      await component.scheduleRecording();
      expect(confirm).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({
          params: { source: "Main", max: 1, count: 1 },
          danger: false,
        }),
      );
      expect(callsOf(calls, "schedule_recording").length).toBe(0);
      expect(component.loadingSchedule).toBeFalse();
      // Within the limit: no question.
      conflicts = { overlapping: 0, max_streams: 1, source_name: "Main" };
      confirm.calls.reset();
      await component.scheduleRecording();
      expect(confirm).not.toHaveBeenCalled();
      expect(callsOf(calls, "schedule_recording").length).toBe(1);
    });
  });

  it("plays catch-up in the embedded player and closes the dialog it would cover", async () => {
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    if (component.epg) component.epg.timeshift_url = "http://example.test/archive.ts";
    await component.timeshift();
    expect(activeModal.close).toHaveBeenCalled();
    expect(play).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({ id: -1, url: "http://example.test/archive.ts" }),
      [],
    );
    // "Channel · Title (date)" for the player's banner.
    const name = (play.calls.mostRecent().args[0] as { name?: string }).name ?? "";
    expect(name).toMatch(/^News · Evening news \(.+\)$/);
    // Never a second mpv window beside the embedded player.
    expect(callsOf(calls, "play").length).toBe(0);
  });

  it("keeps the dialog open for the external player", async () => {
    TestBed.inject(MemoryService).UseExternalPlayer = true;
    spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    await component.timeshift();
    expect(activeModal.close).not.toHaveBeenCalled();
  });

  it("shows the times in the UI language from the timestamps, without the day", async () => {
    await firstValueFrom(TestBed.inject(TranslateService).use("de"));
    const start = new Date(2026, 9, 3, 20, 0);
    const end = new Date(2026, 9, 3, 20, 30);
    const epg = component.epg;
    if (!epg) throw new Error("no programme");
    component.epg = {
      ...epg,
      start_time: "October 03, 20:00",
      start_timestamp: start.getTime() / 1000,
      end_time: "October 03, 20:30",
      end_timestamp: end.getTime() / 1000,
    };
    component.day = new Date(2026, 9, 3);
    fixture.detectChanges();
    const time = () =>
      (fixture.nativeElement as HTMLElement).querySelector(".epg-time")?.textContent?.trim();
    const clock = new Intl.DateTimeFormat("de", { timeStyle: "short" });
    expect(time()).toBe(`${clock.format(start)} – ${clock.format(end)}`);
    expect(time()).toBe("20:00 – 20:30");
    expect(time()).not.toContain("October");
    // Past midnight: the end names its day.
    const late = new Date(2026, 9, 4, 0, 30);
    component.epg = { ...component.epg, end_timestamp: late.getTime() / 1000 };
    fixture.detectChanges();
    const withDate = new Intl.DateTimeFormat("de", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(time()).toBe(`20:00 – ${withDate.format(late)}`);
  });

  it("explains why reminders are off without the tray icon", () => {
    TestBed.inject(MemoryService).trayEnabled = false;
    fixture.detectChanges();
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll("button"),
    ).map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("EPG.NOTIFY_NEEDS_TRAY");
  });
});
