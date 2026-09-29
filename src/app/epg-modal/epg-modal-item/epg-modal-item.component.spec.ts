import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import {
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  activeModalStub,
  mockTauri,
  resetTauri,
} from "../../../testing/test-helpers";

import { EpgModalItemComponent } from "./epg-modal-item.component";

describe("EpgModalItemComponent", () => {
  let component: EpgModalItemComponent;
  let fixture: ComponentFixture<EpgModalItemComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    mockTauri();
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [EpgModalItemComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(EpgModalItemComponent);
    component = fixture.componentInstance;
    component.name = "News";
    component.channelId = 5;
    component.epg = {
      epg_id: "e1",
      title: "Evening news",
      description: "Headlines",
      start_time: "20:00",
      start_timestamp: Math.floor(Date.now() / 1000) + 3600,
      end_time: "20:30",
      end_timestamp: Math.floor(Date.now() / 1000) + 5400,
      has_archive: false,
      now_playing: false,
    };
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("offers scheduling a recording for a future programme", () => {
    expect(component.isFuture()).toBeTrue();
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll("button"),
    ).map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("EPG.SCHEDULE_RECORDING");
  });
});
