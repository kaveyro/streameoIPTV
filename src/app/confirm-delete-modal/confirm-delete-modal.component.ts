import { Component, Input } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

/**
 * Small reusable yes/no confirmation for destructive actions. Open it through
 * {@link ConfirmService.confirm}, which resolves to true only when the user
 * pressed the confirm button (Cancel, the close cross, Escape and a backdrop
 * click all resolve to false).
 *
 * All texts are translation keys (or already translated strings); `params`
 * are interpolated into every key.
 */
@Component({
  selector: "app-confirm-delete-modal",
  standalone: false,
  templateUrl: "./confirm-delete-modal.component.html",
  styleUrl: "./confirm-delete-modal.component.css",
})
export class ConfirmDeleteModalComponent {
  @Input() title = "CONFIRM_DELETE.TITLE";
  /// One entry per paragraph.
  @Input() messages: string[] = ["CONFIRM_DELETE.BODY1", "CONFIRM_DELETE.BODY2"];
  /// Render the paragraphs as (sanitized) HTML. Only for static translations,
  /// never for texts that interpolate user data such as channel names.
  @Input() html = false;
  @Input() confirmLabel = "MODAL.CONFIRM_DELETE";
  @Input() cancelLabel = "MODAL.CANCEL";
  /// Danger styling for the confirm button.
  @Input() danger = true;
  @Input() params: Record<string, unknown> = {};

  constructor(public activeModal: NgbActiveModal) {}

  confirm() {
    this.activeModal.close(true);
  }

  cancel() {
    this.activeModal.close(false);
  }
}
