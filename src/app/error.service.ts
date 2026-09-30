import { Injectable, Injector } from "@angular/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ToastrService } from "ngx-toastr";
import { TranslateService } from "@ngx-translate/core";
import { ErrorModalComponent } from "./error-modal/error-modal.component";
import { take } from "rxjs";
import { MemoryService } from "./memory.service";

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
    this.toastr
      .error(
        message
          ? this.translate.instant("TOAST.ERROR_MORE_INFO", { message })
          : this.translate.instant("TOAST.ERROR_GENERIC_MORE_INFO"),
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
