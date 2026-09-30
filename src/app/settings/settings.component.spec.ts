import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SettingsComponent } from "./settings.component";
import { SourceTileComponent } from "./source-tile/source-tile.component";
import { ConfirmService } from "../confirm.service";
import { MemoryService } from "../memory.service";
import { SourceType } from "../models/sourceType";
import { Settings } from "../models/settings";
import { NowPlayingService } from "../now-playing.service";
import { FREE_EPG_SOURCES } from "../epg-free-sources";
import {
  IpcCall,
  SHARED_DECLARATIONS,
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
      declarations: [SettingsComponent, SourceTileComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
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
