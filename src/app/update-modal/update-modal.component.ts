import { Component, Input } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { renderReleaseNotes } from "./release-notes";

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
  /// Release notes as published with the update (Markdown), may be empty.
  @Input()
  set notes(value: string) {
    this._notes = value ?? "";
    this.notesHtml = renderReleaseNotes(this._notes);
  }
  get notes(): string {
    return this._notes;
  }
  private _notes = "";
  /// The notes rendered from their Markdown subset (escaped, see release-notes.ts).
  notesHtml = "";

  constructor(public activeModal: NgbActiveModal) {}
}
