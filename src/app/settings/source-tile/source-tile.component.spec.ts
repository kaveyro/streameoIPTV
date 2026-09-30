import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SourceTileComponent } from "./source-tile.component";
import { Source } from "../../models/source";
import { SourceType } from "../../models/sourceType";
import { ConfirmService } from "../../confirm.service";
import { MemoryService } from "../../memory.service";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../../testing/test-helpers";

describe("SourceTileComponent", () => {
  let component: SourceTileComponent;
  let fixture: ComponentFixture<SourceTileComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const xtream: Source = {
    id: 2,
    name: "Provider",
    source_type: SourceType.Xtream,
    url: "http://example.test:8080",
    username: "user",
    password: "secret",
    enabled: true,
  };

  async function create(source: Source, handlers: Record<string, unknown> = {}) {
    calls = mockTauri(handlers);
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, SourceTileComponent],
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(SourceTileComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.source = source;
    fixture.detectChanges();
  }

  function buttonWithText(text: string): HTMLButtonElement | undefined {
    return Array.from(element.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    );
  }

  afterEach(() => resetTauri());

  it("should create", async () => {
    await create(xtream);
    expect(component).toBeTruthy();
    expect(element.querySelector(".source-name")?.textContent).toContain("Provider");
  });

  it("tests the edited Xtream settings without saving them", async () => {
    await create(xtream);
    component.edit();
    fixture.detectChanges();
    const success = spyOn(TestBed.inject(ToastrService), "success").and.callThrough();
    buttonWithText("SOURCE.CHECK")!.click();
    expect(component.checking).toBeTrue();
    fixture.detectChanges();
    // Disabled and labelled "testing" while it runs.
    const running = buttonWithText("SOURCE.CHECKING");
    expect(running?.disabled).toBeTrue();
    await fixture.whenStable();
    const checks = callsOf(calls, "check_source");
    expect(checks.length).toBe(1);
    const checked = checks[0].args["source"] as Source;
    expect(checked.url).toBe("http://example.test:8080/player_api.php");
    expect(checked.username).toBe("user");
    expect(callsOf(calls, "update_source").length).toBe(0);
    expect(success).toHaveBeenCalledWith("SOURCE.CHECK_OK");
    expect(component.checking).toBeFalse();
  });

  it("shows the backend error when the test fails", async () => {
    await create(xtream, {
      check_source: () => Promise.reject("The provider rejected the username or password"),
    });
    component.edit();
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    await component.testConnection();
    expect(error).toHaveBeenCalledWith(
      "The provider rejected the username or password",
      "SOURCE.CHECK_FAILED",
    );
  });

  const link: Source = {
    id: 3,
    name: "Link",
    source_type: SourceType.M3ULink,
    url: "http://example.test:8080/get.php?username=u&password=p&type=m3u_plus",
    enabled: true,
  };
  const login = { url: "http://example.test:8080/player_api.php", username: "u", password: "p" };

  it("offers converting an M3U link that is an Xtream login", async () => {
    await create(link, { detect_xtream_login: login });
    await settle();
    fixture.detectChanges();
    expect(callsOf(calls, "detect_xtream_login").map((c) => c.args)).toEqual([{ url: link.url }]);
    const memory = TestBed.inject(MemoryService);
    const refreshSources = spyOn(memory.RefreshSources, "next");
    const refresh = spyOn(memory.Refresh, "next");
    const confirm = spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(true);
    buttonWithText("SOURCE.CONVERT_TO_XTREAM")!.click();
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(callsOf(calls, "convert_source_to_xtream").map((c) => c.args)).toEqual([
      { sourceId: 3 },
    ]);
    expect(refreshSources).toHaveBeenCalledWith(true);
    expect(refresh).toHaveBeenCalledWith(false);
    expect(memory.XtreamSourceIds.has(3)).toBeTrue();
    expect(component.converting).toBeFalse();
  });

  it("keeps the source when the conversion is not confirmed", async () => {
    await create(link, { detect_xtream_login: login });
    await settle();
    spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(false);
    await component.convertToXtream();
    expect(callsOf(calls, "convert_source_to_xtream").length).toBe(0);
  });

  it("offers no conversion for plain M3U links and Xtream sources", async () => {
    await create({ ...link, url: "http://example.test/list.m3u" });
    await settle();
    fixture.detectChanges();
    expect(buttonWithText("SOURCE.CONVERT_TO_XTREAM")).toBeUndefined();
    resetTauri();
    await create(xtream);
    await settle();
    expect(callsOf(calls, "detect_xtream_login").length).toBe(0);
  });

  it("has no test for local M3U files", async () => {
    await create({ ...xtream, source_type: SourceType.M3U, url: "C:/list.m3u" });
    component.edit();
    fixture.detectChanges();
    expect(buttonWithText("SOURCE.CHECK")).toBeUndefined();
  });
});
