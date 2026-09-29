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

import { RestreamModalComponent } from "./restream-modal.component";

describe("RestreamModalComponent", () => {
  let component: RestreamModalComponent;
  let fixture: ComponentFixture<RestreamModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    mockTauri();
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [RestreamModalComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(RestreamModalComponent);
    component = fixture.componentInstance;
    component.channel = { id: 1, name: "News", media_type: 0, favorite: false };
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("preselects the first local IP", async () => {
    await fixture.whenStable();
    expect(component.selectedIP).toBe("192.168.1.2");
  });
});
