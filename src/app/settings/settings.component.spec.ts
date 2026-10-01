import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { Router } from "@angular/router";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { SettingsComponent, isValidRestreamPort } from "./settings.component";
import { ConfirmService } from "../confirm.service";
import { LanguageService } from "../language.service";
import { MemoryService } from "../memory.service";
import { SourceType } from "../models/sourceType";
import { Settings } from "../models/settings";
import { NowPlayingService } from "../now-playing.service";
import { FREE_EPG_SOURCES } from "../epg-free-sources";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("SettingsComponent", () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const source = { id: 1, name: "Main", source_type: SourceType.M3ULink, enabled: true };

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({ get_sources: [source], ...handlers });
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, SettingsComponent],
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
    component.setCategory("parental");
    await settle();
    fixture.detectChanges();
  }

  afterEach(() => resetTauri());

  it("should create", async () => {
    await create();
    expect(component).toBeTruthy();
  });

  it("lists the parental lock category", async () => {
    await create();
    expect(component.settingsCategories.map((c) => c.id)).toContain("parental");
  });

  it("sets a first PIN without asking for a current one", async () => {
    await create({ has_parental_pin: false });
    expect(element.querySelector("#pin-current")).toBeNull();
    component.pinForm.next = "1234";
    component.pinForm.repeat = "1234";
    await component.savePin();
    expect(callsOf(calls, "set_parental_pin").map((c) => c.args)).toEqual([
      { currentPin: null, newPin: "1234" },
    ]);
    expect(component.pinForm.next).toBe("");
  });

  it("rejects mismatching or malformed PINs before calling the backend", async () => {
    await create();
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    component.pinForm.next = "1234";
    component.pinForm.repeat = "1235";
    await component.savePin();
    component.pinForm.next = "12";
    component.pinForm.repeat = "12";
    await component.savePin();
    expect(callsOf(calls, "set_parental_pin").length).toBe(0);
    expect(error.calls.allArgs().map((a) => a[0])).toEqual([
      "PARENTAL.PIN_MISMATCH",
      "PARENTAL.PIN_FORMAT",
    ]);
  });

  it("changes the PIN with the current one and shows backend errors", async () => {
    await create({
      has_parental_pin: true,
      set_parental_pin: () => Promise.reject("Wrong PIN"),
    });
    expect(element.querySelector("#pin-current")).not.toBeNull();
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    component.pinForm = { current: "0000", next: "5678", repeat: "5678", remove: "" };
    await component.savePin();
    expect(callsOf(calls, "set_parental_pin").map((c) => c.args)).toEqual([
      { currentPin: "0000", newPin: "5678" },
    ]);
    expect(error).toHaveBeenCalledWith("Wrong PIN");
  });

  it("lists the XMLTV sources with their status and the coverage", async () => {
    const a = "https://a.test/epg.xml";
    const b = "https://b.test/epg.xml.gz";
    const c = "https://c.test/epg.xml";
    await create({
      get_xmltv_sources: [a, b, c],
      get_xmltv_status: [
        {
          url: a,
          updated: Math.floor(Date.now() / 1000) - 7200,
          programmes: 73284,
          channels: 312,
        },
        { url: b, error: "HTTP 404" },
        { url: c },
      ],
      get_epg_coverage: { live: 623, matched: 312 },
    });
    component.setCategory("epg");
    await settle();
    fixture.detectChanges();
    const items = element.querySelectorAll(".xmltv-item");
    expect(items.length).toBe(3);
    expect(items[0].querySelector(".xmltv-url")?.getAttribute("title")).toBe(a);
    expect(items[0].textContent).toContain("SETTINGS.EPG.STATUS_LOADED");
    expect(items[1].querySelector(".xmltv-status--error")?.textContent).toContain(
      "SETTINGS.EPG.STATUS_ERROR",
    );
    expect(items[2].textContent).toContain("SETTINGS.EPG.STATUS_NEVER");
    expect(items[0].querySelector("button")?.getAttribute("aria-label")).toBeTruthy();
    expect(element.textContent).toContain("SETTINGS.EPG.COVERAGE");
    // Grouped for the UI locale ("73,284", "73.284", ...).
    expect(component.formatCount(73284)).toMatch(/^73\D284$/);
  });

  it("hides the coverage without XMLTV sources", async () => {
    await create({ get_epg_coverage: { live: 10, matched: 0 } });
    component.setCategory("epg");
    await settle();
    fixture.detectChanges();
    expect(element.textContent).not.toContain("SETTINGS.EPG.COVERAGE");
    expect(element.textContent).toContain("SETTINGS.EPG.NO_SOURCES");
  });

  it("adds valid XMLTV URLs once and removes them again", async () => {
    const a = "https://a.test/epg.xml";
    const b = "https://b.test/epg.xml.gz";
    await create({ get_xmltv_sources: [a] });
    component.newXmltvUrl = "ftp://x.test/epg.xml";
    await component.addXmltvSource();
    expect(component.xmltvUrlError).toBe("SETTINGS.EPG.INVALID_URL");
    component.newXmltvUrl = ` ${a} `;
    await component.addXmltvSource();
    expect(component.xmltvUrlError).toBeUndefined();
    expect(component.xmltvUrlHint).toBe("SETTINGS.EPG.DUPLICATE_URL");
    expect(callsOf(calls, "set_xmltv_sources").length).toBe(0);
    component.newXmltvUrl = b;
    await component.addXmltvSource();
    expect(component.newXmltvUrl).toBe("");
    await component.removeXmltvSource(a);
    expect(callsOf(calls, "set_xmltv_sources").map((c) => c.args)).toEqual([
      { urls: [a, b] },
      { urls: [b] },
    ]);
    expect(component.xmltvUrls).toEqual([b]);
  });

  it("points out countries covered by several free guides", async () => {
    await create();
    await component.toggleFreeSource("https://iptv-epg.org/files/epg-de.xml");
    expect(component.duplicateCountries).toEqual([]);
    await component.toggleFreeSource("https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz");
    expect(component.duplicateCountries).toEqual([{ code: "DE", count: 2 }]);
    await component.toggleFreeSource("https://iptv-epg.org/files/epg-de.xml");
    expect(component.duplicateCountries).toEqual([]);
  });

  it("refreshes the XMLTV guides and reloads their status", async () => {
    await create({ get_xmltv_sources: ["https://a.test/epg.xml"] });
    const changed = spyOn(TestBed.inject(NowPlayingService), "xmltvChanged");
    const before = callsOf(calls, "get_xmltv_status").length;
    const pending = component.refreshXmltv();
    expect(component.refreshingXmltv).toBeTrue();
    await pending;
    expect(component.refreshingXmltv).toBeFalse();
    expect(callsOf(calls, "refresh_xmltv").length).toBe(1);
    expect(changed).toHaveBeenCalled();
    expect(callsOf(calls, "get_xmltv_status").length).toBe(before + 1);
    expect(callsOf(calls, "get_epg_coverage").length).toBeGreaterThan(0);
  });

  it("saves and applies the country prefix mode", async () => {
    await create({ get_settings: { country_prefix: "nonsense" } });
    expect(component.settings.country_prefix).toBe("show");
    await component.updateCountryPrefix("badge");
    expect(TestBed.inject(MemoryService).CountryPrefixMode).toBe("badge");
    const saved = callsOf(calls, "update_settings").pop()!.args["settings"] as Settings;
    expect(saved.country_prefix).toBe("badge");
  });

  it("offers the shared free EPG sources", async () => {
    await create();
    expect(component.freeEpgSources).toBe(FREE_EPG_SOURCES);
    component.setCategory("epg");
    await settle();
    fixture.detectChanges();
    expect(element.querySelectorAll(".free-epg-chip").length).toBe(FREE_EPG_SOURCES.length);
  });

  it("defaults the stream fallback to on and applies a change at once", async () => {
    await create();
    expect(component.settings.auto_fallback).toBeTrue();
    const memory = TestBed.inject(MemoryService);
    component.settings.auto_fallback = false;
    const pending = component.updateAutoFallback();
    expect(memory.AutoFallback).toBeFalse();
    await pending;
    const saved = callsOf(calls, "update_settings").pop()!.args["settings"] as Settings;
    expect(saved.auto_fallback).toBeFalse();
  });

  it("keeps a stored stream fallback choice", async () => {
    await create({ get_settings: { auto_fallback: false } });
    expect(component.settings.auto_fallback).toBeFalse();
  });

  it("opens the log folder and reports failures", async () => {
    await create({ open_log_folder: () => Promise.reject("no file manager") });
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    await component.openLogFolder();
    expect(callsOf(calls, "open_log_folder").length).toBe(1);
    expect(error).toHaveBeenCalled();
  });

  it("exports the diagnostics report to the chosen file", async () => {
    const path = "C:/Temp/streameo-diagnose.txt";
    await create({ "plugin:dialog|save": path });
    const success = spyOn(TestBed.inject(ToastrService), "success").and.callThrough();
    await component.exportDiagnostics();
    const dialog = callsOf(calls, "plugin:dialog|save")[0].args["options"] as {
      defaultPath: string;
      filters: { extensions: string[] }[];
    };
    expect(dialog.defaultPath).toMatch(/^streameo-diagnose-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(dialog.filters[0].extensions).toEqual(["txt"]);
    expect(callsOf(calls, "export_diagnostics").map((c) => c.args)).toEqual([{ path }]);
    expect(success).toHaveBeenCalledWith("TOAST.DIAGNOSTICS_EXPORTED");
  });

  it("exports no diagnostics when the dialog is cancelled", async () => {
    await create({ "plugin:dialog|save": null });
    await component.exportDiagnostics();
    expect(callsOf(calls, "export_diagnostics").length).toBe(0);
  });

  function lastSaved(): Settings {
    const saves = callsOf(calls, "update_settings");
    return saves[saves.length - 1].args["settings"] as Settings;
  }

  it("applies the volume to the running player without rebuilding it", async () => {
    await create();
    const memory = TestBed.inject(MemoryService);
    const reset = spyOn(memory.PlayerReset, "next");
    component.settings.volume = 40;
    component.onVolumeChange();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect(callsOf(calls, "player_set_volume").map((c) => c.args)).toEqual([{ volume: 40 }]);
    expect(lastSaved().volume).toBe(40);
    expect(callsOf(calls, "player_destroy").length).toBe(0);
    expect(reset).not.toHaveBeenCalled();
  });

  it("rebuilds the player for spawn settings, later while the mini player plays", async () => {
    await create();
    const memory = TestBed.inject(MemoryService);
    const reset = spyOn(memory.PlayerReset, "next");
    memory.PlayerMini = true;
    component.settings.enable_hwdec = false;
    await component.updateSettings();
    expect(memory.PlayerRebuildPending).toBeTrue();
    expect(callsOf(calls, "player_destroy").length).toBe(0);
    expect(reset).not.toHaveBeenCalled();

    memory.PlayerMini = false;
    memory.PlayerRebuildPending = false;
    component.settings.enable_gpu = true;
    await component.updateSettings();
    expect(memory.PlayerRebuildPending).toBeFalse();
    expect(callsOf(calls, "player_destroy").length).toBe(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("ignores whitespace-only changes of the mpv parameters", async () => {
    await create({ get_settings: { mpv_params: "--hwdec=auto" } });
    component.settings.mpv_params = "--hwdec=auto ";
    await component.updateSettings();
    // Typed value kept as is (the space before the next option), sent trimmed.
    expect(component.settings.mpv_params).toBe("--hwdec=auto ");
    expect(lastSaved().mpv_params).toBe("--hwdec=auto");
    expect(callsOf(calls, "player_destroy").length).toBe(0);
  });

  it("never saves an invalid re-stream port", async () => {
    await create({ get_settings: { restream_port: 4000 } });
    component.settings.restream_port = 70000;
    component.onRestreamPortChange();
    expect(component.restreamPortValid).toBeFalse();
    fixture.detectChanges();
    component.setCategory("network");
    fixture.detectChanges();
    expect(element.querySelector("#set-restream-port")?.classList).toContain("is-invalid");
    expect(element.querySelector("#set-restream-port-error")).not.toBeNull();
    // Other settings still save, with the last valid port.
    await component.updateSettings();
    expect(lastSaved().restream_port).toBe(4000);
    component.settings.restream_port = 8080;
    component.onRestreamPortChange();
    await component.updateSettings();
    expect(lastSaved().restream_port).toBe(8080);
  });

  it("accepts re-stream ports from 1 to 65535 or none", () => {
    expect(isValidRestreamPort(undefined)).toBeTrue();
    expect(isValidRestreamPort(null)).toBeTrue();
    expect(isValidRestreamPort(1)).toBeTrue();
    expect(isValidRestreamPort(554)).toBeTrue();
    expect(isValidRestreamPort(65535)).toBeTrue();
    expect(isValidRestreamPort(0)).toBeFalse();
    expect(isValidRestreamPort(65536)).toBeFalse();
    expect(isValidRestreamPort(3000.5)).toBeFalse();
  });

  it("leaves a modal opened without Escape support open on Escape", async () => {
    await create();
    const memory = TestBed.inject(MemoryService);
    const ref = jasmine.createSpyObj<NgbModalRef>("NgbModalRef", ["close", "dismiss"]);
    memory.ModalRef = ref;
    spyOn(TestBed.inject(NgbModal), "hasOpenModals").and.returnValue(true);
    const navigate = spyOn(TestBed.inject(Router), "navigateByUrl").and.resolveTo(true);
    component.onKeyDown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(ref.close).not.toHaveBeenCalled();
    expect(ref.dismiss).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    memory.ModalRef = undefined;
  });

  it("writes the clamped zoom back into the field", async () => {
    await create({ get_settings: { zoom: 300 } });
    const input = document.createElement("input");
    input.type = "number";
    input.value = "900";
    component.onZoomChange(input);
    expect(input.value).toBe("300");
    expect(component.settings.zoom).toBe(300);
    input.value = "";
    component.onZoomChange(input);
    expect(input.value).toBe("300");
  });

  it("shows the real default recording folder and resets to it", async () => {
    await create({
      get_settings: { recording_path: "D:/Rec" },
      get_default_recording_folder: "C:\\Users\\me\\Videos\\streameoIPTV",
    });
    await component.resetRecordingFolder();
    expect(lastSaved().recording_path).toBeUndefined();
    component.setCategory("recording");
    fixture.detectChanges();
    expect(element.querySelector("#default-path")?.textContent).toContain(
      "C:\\Users\\me\\Videos\\streameoIPTV",
    );
  });

  it("says that deleting everything closes the app", async () => {
    await create();
    const confirm = spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(false);
    await component.nuke();
    expect(confirm.calls.mostRecent().args[0].messages).toContain("CONFIRM_DELETE.APP_CLOSES");
    expect(confirm.calls.mostRecent().args[0].confirmLabel).toBe("CONFIRM_DELETE.CONFIRM_ALL");
    expect(callsOf(calls, "delete_database").length).toBe(0);
  });

  it("flags a malformed new PIN inline", async () => {
    await create();
    expect(component.pinFormatError("12", false)).toBeFalse();
    expect(component.pinFormatError("12", true)).toBeTrue();
    expect(component.pinFormatError("12a", false)).toBeTrue();
    expect(component.pinFormatError("1234", true)).toBeFalse();
  });

  it("lists the languages of the language service", async () => {
    await create();
    const options = Array.from(element.querySelectorAll("#set-language option")).map((o) =>
      o.textContent?.trim(),
    );
    expect(options.slice(1)).toEqual(LanguageService.OPTIONS.map((o) => o.name));
  });

  it("removes the PIN after confirming", async () => {
    await create({ has_parental_pin: true });
    spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(true);
    TestBed.inject(MemoryService).ShowLocked = true;
    component.pinForm.remove = "1234";
    await component.removePin();
    expect(callsOf(calls, "set_parental_pin").map((c) => c.args)).toEqual([
      { currentPin: "1234", newPin: null },
    ]);
    expect(TestBed.inject(MemoryService).ShowLocked).toBeFalse();
  });
});
