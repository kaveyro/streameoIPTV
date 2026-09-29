import { Injectable } from "@angular/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ConfirmDeleteModalComponent } from "./confirm-delete-modal/confirm-delete-modal.component";
import { MemoryService } from "./memory.service";

export interface ConfirmOptions {
  /// Translation key of the title.
  title: string;
  /// Translation keys, one per paragraph.
  messages: string[];
  /// Translation key of the confirm button.
  confirmLabel: string;
  /// Interpolation params for all keys.
  params?: Record<string, unknown>;
  /// Danger (red) confirm button; defaults to true.
  danger?: boolean;
  /// Render the messages as sanitized HTML (static translations only).
  html?: boolean;
}

/** Opens the shared small confirmation dialog for destructive actions. */
@Injectable({
  providedIn: "root",
})
export class ConfirmService {
  constructor(
    private modal: NgbModal,
    private memory: MemoryService,
  ) {}

  /** Resolves to true only if the user explicitly confirmed. */
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const ref = this.modal.open(ConfirmDeleteModalComponent, {
      size: "sm",
      centered: true,
    });
    const instance = ref.componentInstance as ConfirmDeleteModalComponent;
    instance.title = options.title;
    instance.messages = options.messages;
    instance.confirmLabel = options.confirmLabel;
    instance.params = options.params ?? {};
    instance.danger = options.danger ?? true;
    instance.html = options.html ?? false;
    const result = ref.result.then(
      (value) => value === true,
      () => false,
    );
    void this.memory.hidePlayerWhile(result);
    return result;
  }
}
