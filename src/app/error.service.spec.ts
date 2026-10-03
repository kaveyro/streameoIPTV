import { ApplicationRef } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { ToastrModule, ToastrService } from "ngx-toastr";

import { ErrorService } from "./error.service";
import { AppToastComponent } from "./app-toast/app-toast.component";
import { TEST_IMPORTS, mockTauri, resetTauri, settle } from "../testing/test-helpers";

/// TEST_IMPORTS' toastr (default toast), replaced by the app's one below.
const TOASTR_DEFAULT = TEST_IMPORTS.find(
  (m) => (m as { ngModule?: unknown }).ngModule === ToastrModule,
);

describe("ErrorService", () => {
  let service: ErrorService;
  let toastr: ToastrService;

  beforeEach(() => {
    mockTauri();
    TestBed.configureTestingModule({ imports: TEST_IMPORTS });
    service = TestBed.inject(ErrorService);
    toastr = TestBed.inject(ToastrService);
  });

  afterEach(() => resetTauri());

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("reports an error with the given message in a toast", () => {
    spyOn(console, "error");
    const toast = spyOn(toastr, "error").and.callThrough();
    service.handleError("boom", "Failed");
    expect(toast).toHaveBeenCalledWith(
      "TOAST.ERROR_MORE_INFO",
      undefined,
      jasmine.objectContaining({ timeOut: 10000, payload: { details: true } }),
    );
    expect(console.error).toHaveBeenCalledWith("boom");
  });

  it("names a known backend error instead of the generic text", () => {
    spyOn(console, "error");
    const toast = spyOn(toastr, "error").and.callThrough();
    service.handleError("This programme is already scheduled for recording\n\nCaused by: x");
    expect(toast).toHaveBeenCalledWith(
      "TOAST.ERROR_MORE_INFO",
      undefined,
      jasmine.objectContaining({ payload: { details: true } }),
    );
    service.handleError("something unexpected");
    expect(toast.calls.mostRecent().args[0]).toBe("TOAST.ERROR_GENERIC_MORE_INFO");
  });

  it("shows success and info toasts", () => {
    const success = spyOn(toastr, "success").and.callThrough();
    const info = spyOn(toastr, "info").and.callThrough();
    service.success("done");
    service.info("fyi");
    expect(success).toHaveBeenCalledWith("done");
    expect(info).toHaveBeenCalledWith("fyi");
  });
});

describe("ErrorService with the app's toast", () => {
  beforeEach(() => {
    mockTauri();
    TestBed.configureTestingModule({
      imports: [
        ...TEST_IMPORTS.filter((m) => m !== TOASTR_DEFAULT),
        ToastrModule.forRoot({ toastComponent: AppToastComponent, closeButton: true }),
      ],
    });
  });

  afterEach(() => {
    document.querySelectorAll(".toast-container").forEach((c) => c.remove());
    resetTauri();
  });

  function toastElement(): HTMLElement {
    const toast = document.querySelector<HTMLElement>(".toast-container .ngx-toastr");
    expect(toast).withContext("toast").not.toBeNull();
    return toast!;
  }

  it("offers a keyboard-reachable Details button that opens the error dialog", async () => {
    spyOn(console, "error");
    // The error dialog itself is declared in AppModule; only its opening matters.
    const open = spyOn(TestBed.inject(NgbModal), "open").and.returnValue({
      componentInstance: {},
      result: new Promise(() => undefined),
    } as unknown as NgbModalRef);
    TestBed.inject(ErrorService).handleError("boom\n\nCaused by:\n    0: inner", "Failed");
    TestBed.inject(ApplicationRef).tick();
    await settle();
    const details = toastElement().querySelector<HTMLButtonElement>(".toast-details-button");
    expect(details).withContext("details button").not.toBeNull();
    expect(details!.tabIndex).toBe(0);
    details!.click();
    expect(open).toHaveBeenCalled();
  });

  it("translates the close label and closing does not open the details", async () => {
    spyOn(console, "error");
    // The error dialog itself is declared in AppModule; only its opening matters.
    const open = spyOn(TestBed.inject(NgbModal), "open").and.returnValue({
      componentInstance: {},
      result: new Promise(() => undefined),
    } as unknown as NgbModalRef);
    TestBed.inject(ErrorService).handleError("boom");
    TestBed.inject(ApplicationRef).tick();
    await settle();
    const close = toastElement().querySelector<HTMLButtonElement>(".toast-close-button");
    // The test translations render the key itself.
    expect(close?.getAttribute("aria-label")).toBe("MODAL.CLOSE");
    close!.click();
    expect(open).not.toHaveBeenCalled();
  });
});
