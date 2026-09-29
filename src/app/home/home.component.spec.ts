import { NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";

import { HomeComponent } from "./home.component";
import { MemoryService } from "../memory.service";
import { ParentalService } from "../parental.service";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { SourceType } from "../models/sourceType";
import { ViewMode } from "../models/viewMode";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("HomeComponent", () => {
  let component: HomeComponent;
  let fixture: ComponentFixture<HomeComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const source = { id: 1, name: "Main", source_type: SourceType.M3ULink, enabled: true };

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({ get_sources: [source], ...handlers });
    await TestBed.configureTestingModule({
      declarations: [HomeComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
      // Shallow: tiles, sort button, guide and recordings have their own specs.
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  function lastSearch(): Filters {
    const searches = callsOf(calls, "search");
    return searches[searches.length - 1].args["filters"] as Filters;
  }

  afterEach(() => resetTauri());

  it("should create and load the library", async () => {
    await create();
    expect(component).toBeTruthy();
    expect(callsOf(calls, "search").length).toBe(1);
  });

  it("sends the session's parental flag with every search", async () => {
    await create();
    expect(lastSearch().show_locked).toBeFalse();
    TestBed.inject(MemoryService).ShowLocked = true;
    await component.reload();
    expect(lastSearch().show_locked).toBeTrue();
  });

  it("shows the lock button only when a PIN exists", async () => {
    await create({ has_parental_pin: true });
    const lock = element.querySelector('button[aria-label="PARENTAL.SHOW_LOCKED"]');
    expect(lock).not.toBeNull();
    const toggle = spyOn(TestBed.inject(ParentalService), "toggleShowLocked").and.resolveTo(true);
    (lock as HTMLButtonElement).click();
    await settle();
    expect(toggle).toHaveBeenCalled();
    expect(callsOf(calls, "search").length).toBe(2);
  });

  it("has no lock button without a PIN", async () => {
    await create({ has_parental_pin: false });
    expect(element.querySelector('button[aria-label="PARENTAL.SHOW_LOCKED"]')).toBeNull();
  });

  it("'continue watching' is the history restricted to movies and episodes", async () => {
    await create();
    await component.switchMode(ViewMode.History, true);
    expect(lastSearch().view_type).toBe(ViewMode.History);
    expect(lastSearch().media_types).toEqual([MediaType.movie]);
    expect(component.isContinueWatching()).toBeTrue();
    expect(component.isMode(ViewMode.History)).toBeFalse();
    expect(component.filtersVisible()).toBeFalse();
    fixture.detectChanges();
    expect(element.querySelector("#viewMode-4")?.classList).toContain("active");

    // The plain history keeps all media types.
    await component.switchMode(ViewMode.History);
    expect(lastSearch().media_types).toEqual([
      MediaType.livestream,
      MediaType.movie,
      MediaType.serie,
    ]);
    expect(component.isMode(ViewMode.History)).toBeTrue();
  });

  it("the media shortcuts do not change 'continue watching'", async () => {
    await create();
    await component.switchMode(ViewMode.History, true);
    const searches = callsOf(calls, "search").length;
    component.updateMediaTypes(MediaType.livestream);
    expect(callsOf(calls, "search").length).toBe(searches);
    expect(component.filters?.media_types).toEqual([MediaType.movie]);
  });

  it("shows the recordings without searching", async () => {
    await create();
    const searches = callsOf(calls, "search").length;
    (element.querySelector("#viewMode-6") as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.panel).toBe("recordings");
    expect(element.querySelector("app-recordings")).not.toBeNull();
    expect(element.querySelector("app-channel-tile")).toBeNull();
    expect(callsOf(calls, "search").length).toBe(searches);
    expect(element.querySelector("#viewMode-6")?.getAttribute("aria-current")).toBe("page");
  });

  it("opens the guide for the current group and returns to it", async () => {
    await create();
    await component.switchMode(ViewMode.Categories);
    component.filters!.group_id = 5;
    component.showPanel("guide");
    fixture.detectChanges();
    expect(component.guideGroup?.id).toBe(5);
    expect(element.querySelector("app-tv-guide")).not.toBeNull();

    await component.switchMode(ViewMode.Categories);
    expect(component.panel).toBe("library");
    expect(lastSearch().group_id).toBe(5);
  });
});
