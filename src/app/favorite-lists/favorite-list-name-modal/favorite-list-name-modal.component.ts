import { Component, Input } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

/// Same limit as the backend (list_name in lib.rs).
export const LIST_NAME_MAX_LENGTH = 80;

/**
 * Small dialog asking for the name of a favorites list (new list, rename).
 * Closes with the trimmed name, or with null when cancelled. Open it through
 * {@link FavoriteListsService}.
 */
@Component({
  standalone: false,
  selector: "app-favorite-list-name-modal",
  templateUrl: "./favorite-list-name-modal.component.html",
})
export class FavoriteListNameModalComponent {
  /// Translation keys.
  @Input() title = "FAV_LISTS.CREATE_TITLE";
  @Input() confirmLabel = "FAV_LISTS.CREATE";
  /// The current name when renaming.
  @Input() name = "";
  readonly maxLength = LIST_NAME_MAX_LENGTH;

  constructor(public activeModal: NgbActiveModal) {}

  get valid(): boolean {
    return this.name.trim().length > 0;
  }

  submit() {
    if (!this.valid) return;
    this.activeModal.close(this.name.trim());
  }

  cancel() {
    this.activeModal.close(null);
  }
}
