import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

import { PinDialogComponent } from "./pin-dialog.component";
import { TEST_IMPORTS, activeModalStub } from "../../testing/test-helpers";

describe("PinDialogComponent", () => {
  let component: PinDialogComponent;
  let fixture: ComponentFixture<PinDialogComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;
  let element: HTMLElement;

  beforeEach(async () => {
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [PinDialogComponent],
      imports: TEST_IMPORTS,
      providers: [{ provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    fixture = TestBed.createComponent(PinDialogComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    fixture.detectChanges();
  });

  function input(): HTMLInputElement {
    return element.querySelector("#pin-dialog-input") as HTMLInputElement;
  }

  function submitButton(): HTMLButtonElement {
    return element.querySelector("button[type=submit]") as HTMLButtonElement;
  }

  /// View -> model updates of ngModel are synchronous.
  function type(value: string) {
    input().value = value;
    input().dispatchEvent(new Event("input"));
    fixture.detectChanges();
  }

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("asks for a masked, numeric PIN", () => {
    expect(input().type).toBe("password");
    expect(input().getAttribute("inputmode")).toBe("numeric");
    expect(input().hasAttribute("ngbautofocus")).toBeTrue();
    expect(input().maxLength).toBe(8);
  });

  it("only accepts 4 to 8 digits", () => {
    type("12");
    expect(submitButton().disabled).toBeTrue();
    type("12a4");
    expect(submitButton().disabled).toBeTrue();
    type("1234");
    expect(submitButton().disabled).toBeFalse();
    component.pin = "123456789";
    expect(component.valid).toBeFalse();
  });

  it("closes with the PIN when the form is submitted (Enter)", () => {
    type("4321");
    element.querySelector("form")!.dispatchEvent(new Event("submit"));
    expect(activeModal.close).toHaveBeenCalledOnceWith("4321");
  });

  it("does not submit an invalid PIN", () => {
    type("12");
    element.querySelector("form")!.dispatchEvent(new Event("submit"));
    expect(activeModal.close).not.toHaveBeenCalled();
  });

  it("closes with null when cancelled", () => {
    const cancel = Array.from(element.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "MODAL.CANCEL",
    )!;
    cancel.click();
    expect(activeModal.close).toHaveBeenCalledOnceWith(null);
  });

  it("shows the title and the optional message", () => {
    component.title = "PARENTAL.LOCK_GROUP_TITLE";
    component.message = "PARENTAL.UNLOCK_HINT";
    fixture.detectChanges();
    expect(element.querySelector(".modal-title")!.textContent).toContain(
      "PARENTAL.LOCK_GROUP_TITLE",
    );
    expect(element.querySelector("#pin-dialog-message")!.textContent).toContain(
      "PARENTAL.UNLOCK_HINT",
    );
    expect(input().getAttribute("aria-describedby")).toBe("pin-dialog-message");
  });
});
