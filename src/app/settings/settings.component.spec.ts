import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { SettingsComponent } from "./settings.component";
import { SourceTileComponent } from "./source-tile/source-tile.component";
import { ConfirmService } from "../confirm.service";
import { MemoryService } from "../memory.service";
import { SourceType } from "../models/sourceType";
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
