import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { routes } from "./app-routing.module";
import { SettingsComponent } from "./settings/settings.component";
import { SetupComponent } from "./setup/setup.component";
import { TEST_IMPORTS, mockTauri, resetTauri, settle } from "../testing/test-helpers";

describe("AppRoutingModule", () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    mockTauri();
    TestBed.configureTestingModule({
      imports: TEST_IMPORTS,
      providers: [provideRouter(routes)],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(async () => {
    await settle();
    resetTauri();
  });

  it("lazy loads the settings page", async () => {
    const page = await harness.navigateByUrl("/settings", SettingsComponent);
    expect(page).toBeInstanceOf(SettingsComponent);
  });

  it("lazy loads the setup page", async () => {
    const page = await harness.navigateByUrl("/setup", SetupComponent);
    expect(page).toBeInstanceOf(SetupComponent);
  });
});
