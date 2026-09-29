import { Component, Input } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

/**
 * Small dialog asking for the parental PIN. Closes with the entered PIN, or
 * with null when cancelled. Open it through {@link ParentalService.askPin}.
 */
@Component({
  selector: "app-pin-dialog",
  templateUrl: "./pin-dialog.component.html",
  styleUrl: "./pin-dialog.component.css",
})
export class PinDialogComponent {
  /// Translation keys.
  @Input() title = "PARENTAL.ENTER_PIN";
  @Input() message?: string;
  @Input() params: Record<string, unknown> = {};
  @Input() confirmLabel = "PARENTAL.CONFIRM";
  pin = "";

  constructor(public activeModal: NgbActiveModal) {}

  get valid(): boolean {
    return /^\d{4,8}$/.test(this.pin);
  }

  submit() {
    if (!this.valid) return;
    this.activeModal.close(this.pin);
  }

  cancel() {
    this.activeModal.close(null);
  }
}
