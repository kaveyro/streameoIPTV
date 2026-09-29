import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SourceTileComponent } from "./source-tile.component";
import { Source } from "../../models/source";
import { SourceType } from "../../models/sourceType";
import {
  IpcCall,
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
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
      declarations: [SourceTileComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
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

  it("has no test for local M3U files", async () => {
    await create({ ...xtream, source_type: SourceType.M3U, url: "C:/list.m3u" });
    component.edit();
    fixture.detectChanges();
    expect(buttonWithText("SOURCE.CHECK")).toBeUndefined();
  });
});
