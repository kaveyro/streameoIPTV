import { TestBed, fakeAsync, flush, tick } from "@angular/core/testing";
import { ZOOM_MAX, ZOOM_MIN, ZoomService, clampZoom } from "./zoom.service";
import { IpcCall, callsOf, mockTauri, resetTauri, settle } from "../testing/test-helpers";

describe("ZoomService", () => {
  let service: ZoomService;
  let calls: IpcCall[];

  beforeEach(() => {
    calls = mockTauri({ get_settings: { zoom: 100, theme: "light" } });
    TestBed.configureTestingModule({});
    service = TestBed.inject(ZoomService);
  });

  afterEach(() => resetTauri());

  it("clamps to the range of the settings field", () => {
    expect(clampZoom(10)).toBe(ZOOM_MIN);
    expect(clampZoom(900)).toBe(ZOOM_MAX);
    expect(clampZoom(123.4)).toBe(123);
    expect(clampZoom(NaN)).toBeUndefined();
    expect(service.set(1000)).toBe(ZOOM_MAX);
    expect(service.set(NaN)).toBe(ZOOM_MAX);
  });

  it("steps in 10 % and stops at the limits", () => {
    service.apply(290);
    expect(service.step(1)).toBe(300);
    expect(service.step(1)).toBe(300);
    service.apply(55);
    expect(service.step(-1)).toBe(50);
    expect(service.reset()).toBe(100);
  });

  it("applies the zoom right away and saves it once, debounced, with the other settings", async () => {
    const changes: number[] = [];
    service.changes.subscribe((z) => changes.push(z));
    service.step(1);
    service.step(1);
    expect(changes).toEqual([100, 110, 120]);
    expect(service.savePending).toBeTrue();
    expect(callsOf(calls, "update_settings").length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    const saves = callsOf(calls, "update_settings");
    expect(saves.length).toBe(1);
    expect(saves[0].args["settings"]).toEqual({ zoom: 120, theme: "light" });
    expect(service.savePending).toBeFalse();
  });

  it("does not save a stored zoom that is only applied", fakeAsync(() => {
    service.apply(150);
    tick(1000);
    flush();
    expect(service.value).toBe(150);
    expect(callsOf(calls, "update_settings").length).toBe(0);
  }));
});
