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

import { DeleteGroupModalComponent } from "./delete-group-modal.component";

describe("DeleteGroupModalComponent", () => {
  let component: DeleteGroupModalComponent;
  let fixture: ComponentFixture<DeleteGroupModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    mockTauri();
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [DeleteGroupModalComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(DeleteGroupModalComponent);
    component = fixture.componentInstance;
    component.group = { id: 7, name: "News", source_id: 1, media_type: 3 };
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("forgets the replacement group when the input is cleared", () => {
    component.new_group_id = 3;
    component.checkEmpty("");
    expect(component.new_group_id).toBeUndefined();
  });
});
