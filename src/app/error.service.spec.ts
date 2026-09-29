import { TestBed } from "@angular/core/testing";
import { ToastrService } from "ngx-toastr";

import { ErrorService } from "./error.service";
import { TEST_IMPORTS, mockTauri, resetTauri } from "../testing/test-helpers";

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
    expect(toast).toHaveBeenCalledWith("TOAST.ERROR_MORE_INFO");
    expect(console.error).toHaveBeenCalledWith("boom");
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
