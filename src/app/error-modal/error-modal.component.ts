import { Component } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ToastrService } from "ngx-toastr";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-error-modal",
  standalone: false,
  templateUrl: "./error-modal.component.html",
  styleUrl: "./error-modal.component.css",
})
export class ErrorModalComponent {
  error?: string;
  constructor(
    public activeModal: NgbActiveModal,
    private toastr: ToastrService,
    private translate: TranslateService,
  ) {}

  async copy() {
    await writeText(this.error!);
    this.toastr.success(this.translate.instant("TOAST.ERROR_COPIED"));
  }
}
