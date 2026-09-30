import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { FavoriteListNameModalComponent } from "./favorite-list-name-modal.component";
import { TEST_IMPORTS, activeModalStub } from "../../../testing/test-helpers";

describe("FavoriteListNameModalComponent", () => {
  let component: FavoriteListNameModalComponent;
  let fixture: ComponentFixture<FavoriteListNameModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [FavoriteListNameModalComponent],
      imports: TEST_IMPORTS,
      providers: [{ provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();
    fixture = TestBed.createComponent(FavoriteListNameModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("closes with the trimmed name", () => {
    component.name = "  Sport ";
    component.submit();
    expect(activeModal.close).toHaveBeenCalledWith("Sport");
  });

  it("does not accept an empty name", () => {
    component.name = "   ";
    expect(component.valid).toBeFalse();
    component.submit();
    expect(activeModal.close).not.toHaveBeenCalled();
    const submit = fixture.nativeElement.querySelector("button[type=submit]") as HTMLButtonElement;
    fixture.detectChanges();
    expect(submit.disabled).toBeTrue();
  });

  it("closes with null when cancelled", () => {
    component.cancel();
    expect(activeModal.close).toHaveBeenCalledWith(null);
  });
});
