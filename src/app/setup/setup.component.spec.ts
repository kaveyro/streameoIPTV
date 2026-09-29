import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SetupComponent } from "./setup.component";
import { LoadingComponent } from "../loading/loading.component";
import { Source } from "../models/source";
import { SourceType } from "../models/sourceType";
import {
  IpcCall,
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
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
});
