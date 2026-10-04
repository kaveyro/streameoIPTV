import { NO_ERRORS_SCHEMA } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { AppComponent } from "./app.component";
import { ThemeService } from "./theme.service";
import { LanguageService } from "./language.service";
import { UpdateService } from "./update.service";
import { ZoomService } from "./zoom.service";
import { DEFAULT_THEME } from "./theme-cache";
import { RestreamService } from "./restream.service";
import {
  TEST_IMPORTS,
  TEST_PROVIDERS,
  mockTauri,
  resetTauri,
  settle,
} from "../testing/test-helpers";

describe("AppComponent", () => {
  async function create(settings: Record<string, unknown> = {}) {
    mockTauri({ get_settings: settings });
    await TestBed.configureTestingModule({
      declarations: [AppComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
      // Shallow: the routed pages and the player have their own specs.
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
  }

  afterEach(() => resetTauri());

  it("should create the app", async () => {
    await create();
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it(`should have as title 'streameoIPTV'`, async () => {
    await create();
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.title).toEqual("streameoIPTV");
  });

  it("renders the router outlet and the embedded player, no download manager when idle", async () => {
    await create();
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector("main router-outlet")).not.toBeNull();
    expect(compiled.querySelector("app-player")).not.toBeNull();
    expect(compiled.querySelector("app-download-manager")).toBeNull();
  });

  it("shows a restream status chip with Open and Stop while a restream runs", async () => {
    await create();
    const restream = TestBed.inject(RestreamService);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector(".restream-chip")).toBeNull();
    restream.state = "running";
    restream.channel = { id: 3, name: "News" };
    fixture.detectChanges();
    const chip = compiled.querySelector(".restream-chip")!;
    expect(chip.textContent).toContain("RESTREAM.CHIP_RUNNING");
    const open = spyOn(restream, "open");
    const stop = spyOn(restream, "stop").and.resolveTo();
    const [openButton, stopButton] = Array.from(chip.querySelectorAll("button"));
    expect(openButton.textContent?.trim()).toBe("RESTREAM.OPEN");
    openButton.click();
    expect(open).toHaveBeenCalled();
    stopButton.click();
    expect(stop).toHaveBeenCalled();
    restream.state = "idle";
    fixture.detectChanges();
    expect(compiled.querySelector(".restream-chip")).toBeNull();
  });

  it("applies the stored theme and language, and honours auto_update = false", async () => {
    await create({ theme: "light", accent_color: "teal", language: "de", auto_update: false });
    const theme = spyOn(TestBed.inject(ThemeService), "apply");
    const language = spyOn(TestBed.inject(LanguageService), "apply");
    const update = spyOn(TestBed.inject(UpdateService), "check");
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await settle();
    expect(theme).toHaveBeenCalledWith("light", "teal");
    expect(language).toHaveBeenCalledWith("de");
    expect(update).not.toHaveBeenCalled();
  });

  it("follows the OS theme when none is stored, and caches the applied theme", async () => {
    await create({ accent_color: "teal" });
    const theme = spyOn(TestBed.inject(ThemeService), "apply");
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await settle();
    expect(theme).toHaveBeenCalledWith(DEFAULT_THEME, "teal");
    expect(JSON.parse(localStorage.getItem("streameo.theme") ?? "{}")).toEqual({
      theme: "system",
      accent: "teal",
    });
  });

  it("zooms with Ctrl +, Ctrl - and Ctrl 0, also on the numpad", async () => {
    await create({ zoom: 120 });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await settle();
    const zoom = TestBed.inject(ZoomService);
    expect(zoom.value).toBe(120);
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { ctrlKey: true, cancelable: true, ...init });
      document.dispatchEvent(event);
      return event;
    };
    expect(press({ key: "+" }).defaultPrevented).toBeTrue();
    expect(zoom.value).toBe(130);
    press({ key: "=" });
    press({ key: "+", code: "NumpadAdd" });
    expect(zoom.value).toBe(150);
    press({ key: "-" });
    press({ key: "-", code: "NumpadSubtract" });
    expect(zoom.value).toBe(130);
    press({ key: "0", code: "Numpad0" });
    expect(zoom.value).toBe(100);
    // Without Ctrl, or with AltGr (Ctrl+Alt), nothing happens.
    press({ key: "+", ctrlKey: false });
    press({ key: "+", altKey: true });
    expect(zoom.value).toBe(100);
  });

  it("zooms with Ctrl + mouse wheel, one step per notch", async () => {
    await create({ zoom: 100 });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await settle();
    const zoom = TestBed.inject(ZoomService);
    const wheel = (deltaY: number, ctrlKey = true) =>
      document.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey }));
    wheel(-100);
    expect(zoom.value).toBe(110);
    // A touchpad's small deltas add up to one step.
    wheel(40);
    wheel(40);
    expect(zoom.value).toBe(110);
    wheel(40);
    expect(zoom.value).toBe(100);
    // Scrolling without Ctrl does not zoom.
    wheel(-300, false);
    expect(zoom.value).toBe(100);
  });
});
