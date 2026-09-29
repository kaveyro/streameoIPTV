import { Component, Input } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

/**
 * Asks before an update is installed. Installing restarts the app, which used
 * to happen unannounced right after launch - in the middle of playback if the
 * check happened to finish late.
 */
@Component({
  selector: "app-update-modal",
  standalone: false,
  templateUrl: "./update-modal.component.html",
  styleUrl: "./update-modal.component.css",
})
export class UpdateModalComponent {
  @Input() version = "";
  @Input() currentVersion = "";
  /// Release notes as published with the update, may be empty.
  @Input() notes = "";

  constructor(public activeModal: NgbActiveModal) {}
}
