import { NO_ERRORS_SCHEMA } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { AppComponent } from "./app.component";
import { ThemeService } from "./theme.service";
import { LanguageService } from "./language.service";
import { UpdateService } from "./update.service";
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
});
