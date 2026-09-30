import { Component } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslatePipe } from "@ngx-translate/core";

@Component({
  selector: "app-confirm-modal",
  imports: [TranslatePipe],
  templateUrl: "./confirm-modal.component.html",
  styleUrl: "./confirm-modal.component.css",
})
export class ConfirmModalComponent {
  constructor(public activeModal: NgbActiveModal) {}
}
