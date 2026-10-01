import { ComponentFixture, TestBed } from "@angular/core/testing";

import { RecordingsComponent } from "./recordings.component";
import { ConfirmService } from "../confirm.service";
import { PlaybackService } from "../playback.service";
import { RecordingStatus, ScheduledRecording } from "../models/scheduledRecording";
import { RecordingFile } from "../models/recordingFile";
import { MediaType } from "../models/mediaType";
import { EpgAlert } from "../models/epgAlert";
import { MemoryService } from "../memory.service";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("RecordingsComponent", () => {
  let component: RecordingsComponent;
  let fixture: ComponentFixture<RecordingsComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];
  let confirm: jasmine.Spy;

  const now = Math.floor(Date.now() / 1000);
  const schedule: ScheduledRecording[] = [
    {
      id: 1,
      channel_id: 10,
      title: "Late show",
      channel_name: "One",
      start_timestamp: now + 3600,
      end_timestamp: now + 7200,
      status: RecordingStatus.Pending,
    },
    {
      id: 2,
      channel_id: 11,
      channel_name: "Two",
      start_timestamp: now - 600,
      end_timestamp: now + 600,
      status: RecordingStatus.Recording,
    },
    {
      id: 3,
      channel_id: 12,
      title: "Match",
      channel_name: "Three",
      start_timestamp: now - 7200,
      end_timestamp: now - 3600,
      status: RecordingStatus.Done,
    },
  ];
  const alerts: EpgAlert[] = [
    { id: 7, query: "Tatort", action: "record", created: now - 86400 },
    { id: 8, query: "Formel 1", action: "remind", created: now },
  ];
  const files: RecordingFile[] = [
    { path: "C:\\Recordings\\show.ts", name: "show.ts", size: 1536 * 1024 * 1024, modified: now },
  ];

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({
      get_recording_schedule: schedule,
      get_recording_files: files,
      get_epg_alerts: alerts,
      ...handlers,
    });
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, RecordingsComponent],
      providers: TEST_PROVIDERS,
    }).compileComponents();
    confirm = spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(true);
    fixture = TestBed.createComponent(RecordingsComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  function buttonByLabel(label: string): HTMLButtonElement | undefined {
    return Array.from(element.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label,
    );
  }

  afterEach(() => resetTauri());

  it("lists the schedule with a status badge per entry", async () => {
    await create();
    const rows = element.querySelectorAll(".rec-section:first-of-type .recording-row");
    expect(rows.length).toBe(3);
    const badges = Array.from(element.querySelectorAll(".recording-status")).map((b) =>
      b.textContent?.trim(),
    );
    expect(badges).toEqual([
      "RECORDING.STATUS_PENDING",
      "RECORDING.STATUS_RECORDING",
      "RECORDING.STATUS_DONE",
    ]);
    // Without a title the channel name is shown.
    expect(rows[1].querySelector(".recording-title")?.textContent).toContain("Two");
  });

  it("offers cancelling only pending and running recordings", async () => {
    await create();
    const cancels = element.querySelectorAll(
      '.recording-row button[aria-label^="HOME.CANCEL_RECORDING_ARIA"]',
    );
    expect(cancels.length).toBe(2);
  });

  it("cancels a recording after confirming", async () => {
    await create();
    await component.cancel(schedule[0]);
    expect(confirm).toHaveBeenCalled();
    expect(callsOf(calls, "cancel_scheduled_recording").map((c) => c.args)).toEqual([{ id: 1 }]);
    // The list is reloaded afterwards.
    expect(callsOf(calls, "get_recording_schedule").length).toBe(2);
  });

  it("does not cancel when the confirmation is declined", async () => {
    await create();
    confirm.and.resolveTo(false);
    await component.cancel(schedule[0]);
    expect(callsOf(calls, "cancel_scheduled_recording").length).toBe(0);
  });

  it("clears the finished entries", async () => {
    await create();
    const clear = Array.from(element.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "RECORDINGS.CLEAR_FINISHED",
    );
    expect(clear).toBeDefined();
    clear!.click();
    await settle();
    expect(callsOf(calls, "clear_finished_recordings").length).toBe(1);
    // Only done entries: nothing to ask about.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("hides 'clear finished' when nothing is finished", async () => {
    await create({ get_recording_schedule: [schedule[0]] });
    const clear = Array.from(element.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "RECORDINGS.CLEAR_FINISHED",
    );
    expect(clear).toBeUndefined();
  });

  it("lists the files with a human readable size", async () => {
    await create();
    const row = element.querySelector('[aria-labelledby="rec-files-title"] .recording-row')!;
    expect(row.querySelector(".recording-title")?.textContent).toContain("show.ts");
    expect(row.querySelector(".recording-time")?.textContent).toContain("GB");
    expect(component.formatSize(512)).toContain("512");
    expect(component.formatSize(512)).toContain("B");
  });

  it("plays a file as a pseudo movie channel through the shared playback path", async () => {
    await create();
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    buttonByLabel("RECORDINGS.PLAY_ARIA")!.click();
    await settle();
    expect(play).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({
        id: -1,
        name: "show.ts",
        url: "C:\\Recordings\\show.ts",
        media_type: MediaType.movie,
        favorite: false,
      }),
      // Nothing to zap to from a recording.
      [],
    );
  });

  it("marks a file still being recorded and does not delete it", async () => {
    await create({ get_recording_files: [{ ...files[0], recording: true }] });
    const row = element.querySelector('[aria-labelledby="rec-files-title"] .recording-row');
    expect(row?.querySelector(".recording-status")?.textContent).toContain(
      "RECORDINGS.FILE_RECORDING",
    );
    const remove = row?.querySelector<HTMLButtonElement>(
      'button[aria-label^="HOME.DELETE_RECORDING_ARIA"]',
    );
    expect(remove?.disabled).toBeTrue();
    await component.deleteFile({ ...files[0], recording: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(callsOf(calls, "delete_recording_file").length).toBe(0);
  });

  it("asks before clearing finished entries that include failed ones", async () => {
    const failed: ScheduledRecording = { ...schedule[2], id: 4, status: RecordingStatus.Failed };
    await create({ get_recording_schedule: [...schedule, failed] });
    confirm.and.resolveTo(false);
    await component.clearFinished();
    expect(confirm).toHaveBeenCalledWith(
      jasmine.objectContaining({ title: "CONFIRM.CLEAR_FINISHED_TITLE", params: { count: 1 } }),
    );
    expect(callsOf(calls, "clear_finished_recordings").length).toBe(0);
    confirm.and.resolveTo(true);
    await component.clearFinished();
    expect(callsOf(calls, "clear_finished_recordings").length).toBe(1);
  });

  it("deletes a file after confirming", async () => {
    await create();
    await component.deleteFile(files[0]);
    expect(confirm).toHaveBeenCalled();
    expect(callsOf(calls, "delete_recording_file").map((c) => c.args)).toEqual([
      { path: "C:\\Recordings\\show.ts" },
    ]);
  });

  it("shows the folder and copies its path", async () => {
    await create();
    expect(element.querySelector(".folder-path")?.textContent).toContain("C:\\Recordings");
    await component.copyFolder();
    const copy = calls.find((c) => c.cmd.startsWith("plugin:clipboard-manager|write"));
    expect(copy).toBeDefined();
  });

  it("shows empty states for both sections", async () => {
    await create({ get_recording_schedule: [], get_recording_files: [], get_epg_alerts: [] });
    const text = element.textContent ?? "";
    expect(text).toContain("EMPTY.NO_RECORDINGS");
    expect(text).toContain("EMPTY.NO_RECORDING_FILES");
    expect(text).toContain("RECORDINGS.ALERTS_EMPTY");
    expect(text).toContain("RECORDINGS.ALERTS_EMPTY_HINT");
    expect(element.querySelectorAll(".recording-row").length).toBe(0);
  });

  describe("automatic recordings and reminders", () => {
    const section = () => element.querySelector('[aria-labelledby="rec-alerts-title"]')!;
    const queryInput = () => section().querySelector("#rec-alert-query") as HTMLInputElement;
    const actionSelect = () => section().querySelector("#rec-alert-action") as HTMLSelectElement;
    async function fill(query: string, action?: "remind" | "record") {
      queryInput().value = query;
      queryInput().dispatchEvent(new Event("input"));
      if (action) {
        actionSelect().value = action;
        actionSelect().dispatchEvent(new Event("change"));
      }
      fixture.detectChanges();
      await settle();
    }
    async function submit() {
      (section().querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit"));
      await settle();
      fixture.detectChanges();
    }

    it("lists the alerts with their action and creation date", async () => {
      await create();
      const rows = section().querySelectorAll(".recording-row");
      expect(rows.length).toBe(2);
      expect(rows[0].querySelector(".recording-title")?.textContent).toContain("Tatort");
      expect(rows[0].textContent).toContain("RECORDINGS.ALERT_KIND_RECORD");
      expect(rows[0].textContent).toContain("RECORDINGS.ALERT_CREATED");
      expect(rows[0].querySelector(".alert-icon--record")).not.toBeNull();
      expect(rows[1].textContent).toContain("RECORDINGS.ALERT_KIND_REMIND");
      expect(rows[1].querySelector("button")?.getAttribute("aria-label")).toBe(
        "RECORDINGS.ALERT_DELETE_ARIA",
      );
    });

    it("adds an alert and reloads the schedule it filled", async () => {
      await create();
      await fill("  Champions League ");
      await submit();
      expect(callsOf(calls, "add_epg_alert").map((c) => c.args)).toEqual([
        { query: "Champions League", action: "record" },
      ]);
      expect(callsOf(calls, "get_recording_schedule").length).toBe(2);
      expect(callsOf(calls, "get_epg_alerts").length).toBe(2);
      // The form is emptied for the next one.
      expect(component.alertQuery).toBe("");
    });

    it("needs two characters and no duplicate (case-insensitive)", async () => {
      await create();
      await fill("T");
      await submit();
      expect(callsOf(calls, "add_epg_alert").length).toBe(0);
      expect(section().querySelector(".alert-error")?.textContent).toContain(
        "RECORDINGS.ALERT_TOO_SHORT",
      );
      expect(queryInput().getAttribute("aria-invalid")).toBe("true");

      await fill("tatort");
      await submit();
      expect(callsOf(calls, "add_epg_alert").length).toBe(0);
      expect(section().querySelector(".alert-error")?.textContent).toContain(
        "RECORDINGS.ALERT_EXISTS",
      );
    });

    it("adds a reminder only with the tray icon enabled", async () => {
      await create();
      const memory = TestBed.inject(MemoryService);
      memory.trayEnabled = false;
      await fill("Tatort", "remind");
      await submit();
      expect(callsOf(calls, "add_epg_alert").length).toBe(0);
      expect(section().querySelector(".alert-error")?.textContent).toContain(
        "GUIDE.ALERT_NEEDS_TRAY",
      );
      memory.trayEnabled = true;
      await submit();
      expect(callsOf(calls, "add_epg_alert").map((c) => c.args)).toEqual([
        { query: "Tatort", action: "remind" },
      ]);
    });

    it("deletes an alert after confirming that created entries stay", async () => {
      await create();
      await component.deleteAlert(alerts[0]);
      expect(confirm).toHaveBeenCalledWith(
        jasmine.objectContaining({
          messages: ["CONFIRM.DELETE_ALERT_RECORD_BODY", "CONFIRM.DELETE_ALERT_KEEP"],
          params: { query: "Tatort" },
        }),
      );
      expect(callsOf(calls, "delete_epg_alert").map((c) => c.args)).toEqual([{ id: 7 }]);
      expect(callsOf(calls, "get_epg_alerts").length).toBe(2);

      confirm.and.resolveTo(false);
      await component.deleteAlert(alerts[1]);
      expect(callsOf(calls, "delete_epg_alert").length).toBe(1);
    });
  });

  it("refreshes periodically and stops when destroyed", async () => {
    const realSetInterval = window.setInterval.bind(window);
    let refresh: (() => void) | undefined;
    spyOn(window, "setInterval").and.callFake(((handler: () => void, ms?: number) => {
      if (ms !== RecordingsComponent.REFRESH_MS) return realSetInterval(handler, ms);
      refresh = handler;
      return 4242;
    }) as typeof window.setInterval);
    const clear = spyOn(window, "clearInterval").and.callThrough();
    await create();
    expect(refresh).toBeDefined();
    const before = callsOf(calls, "get_recording_schedule").length;
    refresh!();
    await settle();
    expect(callsOf(calls, "get_recording_schedule").length).toBe(before + 1);
    expect(callsOf(calls, "get_recording_files").length).toBe(before + 1);
    fixture.destroy();
    expect(clear).toHaveBeenCalledWith(4242);
  });
});
