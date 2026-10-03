import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SOURCE_TYPE_LABELS, SourceTileComponent, maskUrlSecrets } from "./source-tile.component";
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

  it("shows a known backend error translated when the test fails", async () => {
    await create(xtream, {
      check_source: () => Promise.reject("The provider rejected the username or password"),
    });
    component.edit();
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    await component.testConnection();
    expect(error).toHaveBeenCalledWith("ERROR.CREDENTIALS_REJECTED", "SOURCE.CHECK_FAILED");
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

  it("labels the source type like the setup does", async () => {
    await create(link);
    const type = element.querySelector(".source-details dd")?.textContent?.trim();
    expect(type).toBe("SETUP.M3U_URL");
    expect(component.get_source_type_name()).toBe(SOURCE_TYPE_LABELS[SourceType.M3ULink]);
    resetTauri();
    await create({ ...xtream, source_type: SourceType.CustomImport });
    expect(component.get_source_type_name()).toBe("SETUP.CUSTOM_IMPORT");
  });

  it("shows a dash for an unset stream user agent", async () => {
    await create(xtream);
    expect(element.textContent).toContain("—");
  });

  it("rejects fewer than one max stream", async () => {
    await create(xtream);
    component.edit();
    component.editableSource.max_streams = 0;
    fixture.detectChanges();
    expect(component.maxStreamsValid).toBeFalse();
    expect(element.querySelector("input[name=streams]")?.classList).toContain("is-invalid");
    await component.save();
    expect(callsOf(calls, "update_source").length).toBe(0);
    component.editableSource.max_streams = 2;
    await component.save();
    expect(callsOf(calls, "update_source").length).toBe(1);
  });

  it("has no test for local M3U files", async () => {
    await create({ ...xtream, source_type: SourceType.M3U, url: "C:/list.m3u" });
    component.edit();
    fixture.detectChanges();
    expect(buttonWithText("SOURCE.CHECK")).toBeUndefined();
  });
  describe("M3U link secrets", () => {
    it("masks password-like query parameters and userinfo passwords", () => {
      expect(maskUrlSecrets("http://h/get.php?username=u&password=p1&type=m3u")).toBe(
        "http://h/get.php?username=u&password=••••&type=m3u",
      );
      expect(maskUrlSecrets("http://h/list?PASS=x&pwd=y&token=z#a")).toBe(
        "http://h/list?PASS=••••&pwd=••••&token=••••#a",
      );
      expect(maskUrlSecrets("http://bob:s3cr3t@h/list.m3u")).toBe("http://bob:••••@h/list.m3u");
      expect(maskUrlSecrets("http://h/list.m3u?type=m3u")).toBe("http://h/list.m3u?type=m3u");
    });

    it("shows the link with the password masked until revealed", async () => {
      await create(link);
      await settle();
      fixture.detectChanges();
      const details = element.querySelector(".source-details")!;
      expect(details.textContent).not.toContain("password=p&");
      expect(details.textContent).toContain("password=••••");
      const eye = details.querySelector<HTMLButtonElement>(".secret-row .eye")!;
      expect(eye.getAttribute("aria-pressed")).toBe("false");
      expect(eye.getAttribute("aria-label")).toBe("COMMON.SHOW_PASSWORD");
      eye.click();
      fixture.detectChanges();
      expect(details.textContent).toContain("password=p&");
      expect(eye.getAttribute("aria-pressed")).toBe("true");
      expect(eye.getAttribute("aria-label")).toBe("COMMON.HIDE_PASSWORD");
    });

    it("offers no reveal button for a link without secrets", async () => {
      await create({ ...link, url: "http://example.test/list.m3u" });
      fixture.detectChanges();
      expect(element.querySelector(".source-details .secret-row")).toBeNull();
    });
  });

  it("explains the user agents and max streams with focusable help buttons", async () => {
    await create(link);
    const help = Array.from(element.querySelectorAll<HTMLButtonElement>("dt .info-btn"));
    expect(help.map((b) => b.getAttribute("aria-label"))).toEqual([
      "SOURCE.USER_AGENT_TOOLTIP",
      "SOURCE.STREAM_USER_AGENT_TOOLTIP",
      "SOURCE.MAX_STREAMS_TOOLTIP",
    ]);
    expect(help.every((b) => b.type === "button")).toBeTrue();
  });

  it("shows only the first line of a failed connection test", async () => {
    await create(link, {
      check_source: () =>
        Promise.reject("error sending request\n\nCaused by:\n    0: dns error\n    1: no host"),
    });
    const error = spyOn(TestBed.inject(ToastrService), "error").and.callThrough();
    component.edit();
    await component.testConnection();
    expect(error).toHaveBeenCalledWith("error sending request", "SOURCE.CHECK_FAILED");
  });

  it("cancels the edit from the keyboard and focuses the actions button", async () => {
    await create(link);
    component.edit();
    fixture.detectChanges();
    element.querySelector<HTMLInputElement>("input[name=url]")!.focus();
    expect(component.containsFocus()).toBeTrue();
    component.cancel(true);
    fixture.detectChanges();
    await settle();
    expect(component.editing).toBeFalse();
    expect(document.activeElement).toBe(element.querySelector(".more-btn"));
  });
});
