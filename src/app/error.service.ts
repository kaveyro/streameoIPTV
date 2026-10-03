import { Injectable, Injector } from "@angular/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ToastrService } from "ngx-toastr";
import { TranslateService } from "@ngx-translate/core";
import { ErrorModalComponent } from "./error-modal/error-modal.component";
import { take } from "rxjs";
import { MemoryService } from "./memory.service";
import { ToastDetailsPayload } from "./app-toast/app-toast.component";
import { knownErrorKey } from "./error-text";

/// Error toasts link to the details: long enough to read and to reach the
/// "Details" button (hover and focus pause the timeout anyway).
const ERROR_TOAST_TIMEOUT_MS = 10000;
const ERROR_TOAST_EXTENDED_TIMEOUT_MS = 5000;

@Injectable({
  providedIn: "root",
})
export class ErrorService {
  constructor(
    private toastr: ToastrService,
    private modal: NgbModal,
    private translate: TranslateService,
    // MemoryService depends on this service, so it is resolved lazily.
    private injector: Injector,
  ) {}

  public handleError(e: unknown, message?: string) {
    const error = e as string;
    console.error(error);
    // A backend message meant for the user says more than "an error occurred".
    const known = message === undefined ? knownErrorKey(e) : undefined;
    if (known) message = this.translate.instant(known);
    this.toastr
      .error(
        message
          ? this.translate.instant("TOAST.ERROR_MORE_INFO", { message })
          : this.translate.instant("TOAST.ERROR_GENERIC_MORE_INFO"),
        undefined,
        {
          timeOut: ERROR_TOAST_TIMEOUT_MS,
          extendedTimeOut: ERROR_TOAST_EXTENDED_TIMEOUT_MS,
          // AppToastComponent renders a "Details" button that taps the toast.
          payload: { details: true } satisfies ToastDetailsPayload,
        },
      )
      .onTap.pipe(take(1))
      .subscribe(() => this.showError(error));
  }

  private showError(error: string) {
    const modalRef = this.modal.open(ErrorModalComponent, { backdrop: "static", size: "xl" });
    modalRef.componentInstance.name = "ErrorModal";
    modalRef.componentInstance.error = error;
    // The native player window would cover the modal: hide it meanwhile.
    void this.injector.get(MemoryService).hidePlayerWhile(modalRef.result);
  }

  public info(message: string) {
    this.toastr.info(message);
  }

  public success(message: string) {
    this.toastr.success(message);
  }
}
