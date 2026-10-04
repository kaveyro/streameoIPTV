import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import {
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  activeModalStub,
  mockTauri,
  resetTauri,
} from "../../testing/test-helpers";
import { EpgModalItemComponent } from "./epg-modal-item/epg-modal-item.component";

import { EpgModalComponent } from "./epg-modal.component";

describe("EpgModalComponent", () => {
  let component: EpgModalComponent;
  let fixture: ComponentFixture<EpgModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    mockTauri();
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [EpgModalComponent, EpgModalItemComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(EpgModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("keeps only the programmes of the shown day", () => {
    const today = Math.floor(Date.now() / 1000);
    const programme = (start: number) => ({
      epg_id: String(start),
      title: "p" + start,
      description: "",
      start_time: "",
      start_timestamp: start,
      end_time: "",
      end_timestamp: start + 1800,
      has_archive: false,
      now_playing: false,
    });
    component.epg = [programme(today), programme(today + 3 * 24 * 3600)];
    component.filterEPGs();
    expect(component.filteredEPGs.map((e) => e.title)).toEqual(["p" + today]);
  });

  it("goes only to days the programmes reach and back with Today", () => {
    const at = (days: number, hour: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      date.setHours(hour, 0, 0, 0);
      return Math.floor(date.getTime() / 1000);
    };
    const programme = (start: number) => ({
      epg_id: String(start),
      title: "p" + start,
      description: "",
      start_time: "",
      start_timestamp: start,
      end_time: "",
      end_timestamp: start + 1800,
      has_archive: false,
      now_playing: false,
    });
    component.epg = [programme(at(0, 12)), programme(at(1, 12)), programme(at(2, 12))];
    component.filterEPGs();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const [prev, next] = Array.from(element.querySelectorAll<HTMLButtonElement>(".day-arrow"));
    const today = element.querySelector<HTMLButtonElement>(".day-today");
    // Nothing before today: no way back; today is shown.
    expect(prev.disabled).toBeTrue();
    expect(next.disabled).toBeFalse();
    expect(today?.disabled).toBeTrue();
    for (let i = 0; i < 5; i++) component.next();
    fixture.detectChanges();
    // Two days ahead is the last one with programmes.
    expect(component.filteredEPGs.map((e) => e.start_timestamp)).toEqual([at(2, 12)]);
    expect(next.disabled).toBeTrue();
    expect(today?.disabled).toBeFalse();
    today?.click();
    fixture.detectChanges();
    expect(component.isToday()).toBeTrue();
    expect(component.filteredEPGs.map((e) => e.start_timestamp)).toEqual([at(0, 12)]);
  });
});
