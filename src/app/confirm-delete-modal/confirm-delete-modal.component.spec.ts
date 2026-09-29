import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateModule } from "@ngx-translate/core";

import { ConfirmDeleteModalComponent } from "./confirm-delete-modal.component";

describe("ConfirmDeleteModalComponent", () => {
  let component: ConfirmDeleteModalComponent;
  let fixture: ComponentFixture<ConfirmDeleteModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;

  beforeEach(async () => {
    activeModal = jasmine.createSpyObj<NgbActiveModal>("NgbActiveModal", ["close", "dismiss"]);
    await TestBed.configureTestingModule({
      declarations: [ConfirmDeleteModalComponent],
      imports: [TranslateModule.forRoot()],
      providers: [{ provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDeleteModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("closes with true only on confirm", () => {
    component.confirm();
    expect(activeModal.close).toHaveBeenCalledWith(true);
    component.cancel();
    expect(activeModal.close).toHaveBeenCalledWith(false);
  });
});
