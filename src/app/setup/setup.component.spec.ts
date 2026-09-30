import { ComponentFixture, TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { ToastrService } from "ngx-toastr";

import { SetupComponent } from "./setup.component";
import { LoadingComponent } from "../loading/loading.component";
import { Source } from "../models/source";
import { SourceType } from "../models/sourceType";
import { MemoryService } from "../memory.service";
import { FREE_EPG_SOURCES, freeEpgSourcesFor, topCountries } from "../epg-free-sources";
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

describe("SetupComponent", () => {
  let component: SetupComponent;
  let fixture: ComponentFixture<SetupComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri(handlers);
    await TestBed.configureTestingModule({
      declarations: [SetupComponent, LoadingComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(SetupComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
  }

  function testButton(): HTMLButtonElement | undefined {
    return Array.from(element.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "SOURCE.CHECK",
    );
  }

  afterEach(() => resetTauri());

  it("should create", async () => {
    await create();
    expect(component).toBeTruthy();
  });

  it("offers the connection test for Xtream and M3U links only", async () => {
    await create();
    expect(testButton()).toBeUndefined();
    component.switchMode(SourceType.M3ULink);
    fixture.detectChanges();
    expect(testButton()).toBeDefined();
    component.switchMode(SourceType.Xtream);
    fixture.detectChanges();
    expect(testButton()).toBeDefined();
    component.switchMode(SourceType.Custom);
    fixture.detectChanges();
    expect(testButton()).toBeUndefined();
  });

  it("tests an Xtream login without adding the source", async () => {
    await create();
    component.switchMode(SourceType.Xtream);
    component.source.url = " example.test:8080 ";
    component.source.username = "user";
    component.source.password = "pass";
    const success = spyOn(TestBed.inject(ToastrService), "success").and.callThrough();
    const pending = component.testConnection();
    expect(component.checking).toBeTrue();
    await pending;
    const checked = callsOf(calls, "check_source")[0].args["source"] as Source;
    expect(checked.url).toBe("http://example.test:8080/player_api.php");
    expect(checked.name).toBeTruthy();
    expect(callsOf(calls, "get_xtream").length).toBe(0);
    expect(success).toHaveBeenCalledWith("SOURCE.CHECK_OK");
    expect(component.checking).toBeFalse();
  });

  describe("M3U links with an Xtream login", () => {
    const link = "http://example.test:8080/get.php?username=u&password=p&type=m3u_plus";
    const login = { url: "http://example.test:8080/player_api.php", username: "u", password: "p" };

    async function submitLink(choice: "xtream" | "m3u" | "abort") {
      await create({ detect_xtream_login: login });
      component.switchMode(SourceType.M3ULink);
      component.source.name = "Provider";
      component.source.url = ` ${link} `;
      spyOn(component, "askImportAsXtream").and.resolveTo(choice);
      await component.submit();
    }

    it("imports them as Xtream when chosen", async () => {
      await submitLink("xtream");
      expect(callsOf(calls, "detect_xtream_login").map((c) => c.args)).toEqual([{ url: link }]);
      const imported = callsOf(calls, "get_xtream")[0].args["source"] as Source;
      expect(imported.source_type).toBe(SourceType.Xtream);
      expect(imported.url).toBe(login.url);
      expect(imported.username).toBe("u");
      expect(imported.password).toBe("p");
      expect(callsOf(calls, "get_m3u8_from_link").length).toBe(0);
    });

    it("imports them as M3U link when chosen", async () => {
      await submitLink("m3u");
      const imported = callsOf(calls, "get_m3u8_from_link")[0].args["source"] as Source;
      expect(imported.url).toBe(link);
      expect(imported.source_type).toBe(SourceType.M3ULink);
      expect(callsOf(calls, "get_xtream").length).toBe(0);
    });

    it("imports nothing when the question is closed", async () => {
      await submitLink("abort");
      expect(callsOf(calls, "get_m3u8_from_link").length).toBe(0);
      expect(callsOf(calls, "get_xtream").length).toBe(0);
      expect(component.loading).toBeFalse();
    });
  });

  it("drops credentials when testing an M3U link and reports failures", async () => {
    await create({
      check_source: () => Promise.reject("The link does not point to an M3U playlist"),
    });
    component.switchMode(SourceType.M3ULink);
    component.source.url = "https://example.test/list.m3u";
    component.source.username = "stale";
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    await component.testConnection();
    const checked = callsOf(calls, "check_source")[0].args["source"] as Source;
    expect(checked.username).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "The link does not point to an M3U playlist",
      "SOURCE.CHECK_FAILED",
    );
  });

  describe("first-run EPG step", () => {
    const sources = [
      { id: 1, name: "Main", source_type: SourceType.Xtream, enabled: true },
      { id: 2, name: "Old", source_type: SourceType.M3ULink, enabled: false },
    ];
    const de = "https://iptv-epg.org/files/epg-de.xml";
    const tr = "https://iptv-epg.org/files/epg-tr.xml";
    const gb = "https://iptv-epg.org/files/epg-uk.xml";

    let navigate: jasmine.Spy;

    async function importSource(handlers: Record<string, unknown>, additional = false) {
      await create({ get_sources: sources, ...handlers });
      navigate = spyOn(TestBed.inject(Router), "navigateByUrl").and.resolveTo(true);
      TestBed.inject(MemoryService).AddingAdditionalSource = additional;
      component.switchMode(SourceType.Custom);
      component.source.name = "Main";
      await component.submit();
      await settle();
      fixture.detectChanges();
    }

    it("preselects the guides for the playlist's main countries", async () => {
      await importSource({
        get_countries: [
          { code: "TR", count: 500 },
          { code: "UK", count: 300 },
          { code: "DE", count: 150 },
          { code: "AL", count: 5 },
        ],
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(component.step).toBe("epg");
      expect(callsOf(calls, "get_countries").map((c) => c.args)).toEqual([
        { sourceIds: [1], showLocked: false },
      ]);
      expect([...component.selectedEpg]).toEqual([tr, gb]);
      const chips = element.querySelectorAll(".free-epg-chip");
      expect(chips.length).toBe(FREE_EPG_SOURCES.length);
      expect(element.querySelectorAll(".free-epg-chip[aria-pressed='true']").length).toBe(2);
      expect(element.querySelector("#setup-language")).toBeNull();
    });

    it("preselects nothing without a detected country", async () => {
      await importSource({ get_countries: [] });
      expect(component.step).toBe("epg");
      expect(component.selectedEpg.size).toBe(0);
    });

    it("saves the selection, refreshes in the background and finishes", async () => {
      const custom = "https://my.test/guide.xml";
      let finishRefresh!: () => void;
      await importSource({
        get_countries: [{ code: "DE", count: 10 }],
        get_xmltv_sources: [custom],
        refresh_xmltv: () => new Promise<void>((resolve) => (finishRefresh = resolve)),
      });
      component.toggleEpg(tr);
      const info = spyOn(TestBed.inject(ToastrService), "info").and.callThrough();
      await component.applyEpg();
      expect(callsOf(calls, "set_xmltv_sources").map((c) => c.args)).toEqual([
        { urls: [custom, de, tr] },
      ]);
      expect(callsOf(calls, "refresh_xmltv").length).toBe(1);
      expect(info).toHaveBeenCalledWith("TOAST.EPG_LOADING");
      // Not waiting for the (slow) refresh.
      expect(component.step).toBe("done");
      finishRefresh();
      component.finish();
      expect(navigate).toHaveBeenCalledWith("");
    });

    it("skips the guides without saving anything", async () => {
      await importSource({ get_countries: [{ code: "DE", count: 10 }] });
      component.skipEpg();
      expect(component.step).toBe("done");
      expect(callsOf(calls, "set_xmltv_sources").length).toBe(0);
      expect(callsOf(calls, "refresh_xmltv").length).toBe(0);
    });

    it("goes straight home when adding another source", async () => {
      await importSource({ get_countries: [{ code: "DE", count: 10 }] }, true);
      expect(navigate).toHaveBeenCalledWith("");
      expect(component.step).toBe("source");
      expect(callsOf(calls, "get_countries").length).toBe(0);
    });
  });

  describe("free EPG source helpers", () => {
    it("picks the top countries covering most channels", () => {
      expect(
        topCountries([
          { code: "TR", count: 60 },
          { code: "de", count: 25 },
          { code: "US", count: 10 },
          { code: "FR", count: 5 },
        ]),
      ).toEqual(["TR", "DE"]);
      expect(topCountries([])).toEqual([]);
    });

    it("merges UK into GB", () => {
      expect(
        topCountries([
          { code: "DE", count: 50 },
          { code: "UK", count: 30 },
          { code: "GB", count: 30 },
        ])[0],
      ).toBe("GB");
    });

    it("picks one guide per country, at most four", () => {
      const urls = freeEpgSourcesFor(["UK", "GB", "XX", "DE", "TR", "US", "FR"]).map(
        (s) => s.country,
      );
      expect(urls).toEqual(["GB", "DE", "TR", "US"]);
    });
  });
});
