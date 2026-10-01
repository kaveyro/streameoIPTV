import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslatePipe, provideTranslateService } from "@ngx-translate/core";

import { ConfirmDeleteModalComponent } from "./confirm-delete-modal.component";

describe("ConfirmDeleteModalComponent", () => {
  let component: ConfirmDeleteModalComponent;
  let fixture: ComponentFixture<ConfirmDeleteModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    activeModal = jasmine.createSpyObj<NgbActiveModal>("NgbActiveModal", ["close", "dismiss"]);
    await TestBed.configureTestingModule({
      declarations: [ConfirmDeleteModalComponent],
      imports: [TranslatePipe],
      providers: [provideTranslateService(), { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDeleteModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("puts Cancel left of the action and the trash icon only on deletes", () => {
    const element = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(element.querySelectorAll(".modal-footer button"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      "MODAL.CANCEL",
      "MODAL.CONFIRM_DELETE",
    ]);
    expect(buttons[0].querySelector("svg")).toBeNull();
    expect(buttons[1].querySelector("svg")).not.toBeNull();
    component.trashIcon = false;
    fixture.detectChanges();
    expect(buttons[1].querySelector("svg")).toBeNull();
    expect(buttons[1].classList).toContain("btn-danger");
  });

  it("closes with true only on confirm", () => {
    component.confirm();
    expect(activeModal.close).toHaveBeenCalledWith(true);
    component.cancel();
    expect(activeModal.close).toHaveBeenCalledWith(false);
  });
});
