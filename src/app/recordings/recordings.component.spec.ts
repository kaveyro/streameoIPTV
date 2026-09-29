import { ComponentFixture, TestBed } from "@angular/core/testing";

import { RecordingsComponent } from "./recordings.component";
import { ConfirmService } from "../confirm.service";
import { PlaybackService } from "../playback.service";
import { RecordingStatus, ScheduledRecording } from "../models/scheduledRecording";
import { RecordingFile } from "../models/recordingFile";
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
  const files: RecordingFile[] = [
    { path: "C:\\Recordings\\show.ts", name: "show.ts", size: 1536 * 1024 * 1024, modified: now },
  ];

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({
      get_recording_schedule: schedule,
      get_recording_files: files,
      ...handlers,
    });
    await TestBed.configureTestingModule({
      declarations: [RecordingsComponent],
      imports: TEST_IMPORTS,
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
    const row = element.querySelectorAll(".rec-section")[1].querySelector(".recording-row")!;
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
    );
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
    await create({ get_recording_schedule: [], get_recording_files: [] });
    const text = element.textContent ?? "";
    expect(text).toContain("EMPTY.NO_RECORDINGS");
    expect(text).toContain("EMPTY.NO_RECORDING_FILES");
    expect(element.querySelectorAll(".recording-row").length).toBe(0);
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
