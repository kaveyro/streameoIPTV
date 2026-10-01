import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import {
  IpcCall,
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  activeModalStub,
  callsOf,
  mockTauri,
  resetTauri,
} from "../../testing/test-helpers";

import { ErrorModalComponent } from "./error-modal.component";

describe("ErrorModalComponent", () => {
  let component: ErrorModalComponent;
  let fixture: ComponentFixture<ErrorModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  let calls: IpcCall[];

  beforeEach(async () => {
    calls = mockTauri();
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [ErrorModalComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(ErrorModalComponent);
    component = fixture.componentInstance;
    component.error = "Something failed";
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("shows the error text", () => {
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Something failed");
    // No indentation in front of the error.
    expect((fixture.nativeElement as HTMLElement).querySelector("textarea")?.value).toBe(
      "Something failed",
    );
  });

  it("opens the log folder instead of listing OS paths", async () => {
    await component.openLogFolder();
    expect(callsOf(calls, "open_log_folder").length).toBe(1);
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("%localappdata%");
  });
});
