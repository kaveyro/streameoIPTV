import { ChangeDetectionStrategy, Component, ElementRef, inject } from "@angular/core";
import { TranslatePipe } from "@ngx-translate/core";
import { Toast } from "ngx-toastr";

/// Payload of a toast that offers more information (ErrorService): a
/// "Details" button triggers the toast's onTap, like clicking the toast.
export interface ToastDetailsPayload {
  details: true;
}

/**
 * ngx-toastr's toast with a translated close label, a keyboard-reachable
 * "Details" button for error toasts, and a timeout that pauses while the
 * focus is inside the toast (as it does on hover).
 */
@Component({
  selector: "[app-toast-component]",
  imports: [TranslatePipe],
  templateUrl: "./app-toast.component.html",
  // Toast's fade in/out (component styles are not inherited).
  styles: [
    ":host.toast-in{animation:toast-animation var(--animation-duration) var(--animation-easing)}" +
      ":host.toast-out{animation:toast-animation var(--animation-duration) var(--animation-easing) reverse forwards}" +
      "@keyframes toast-animation{0%{opacity:0}to{opacity:1}}",
  ],
  host: {
    "(focusin)": "stickAround()",
    "(focusout)": "onFocusOut($event)",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppToastComponent extends Toast {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  get hasDetails(): boolean {
    return (this.options().payload as ToastDetailsPayload | undefined)?.details === true;
  }

  /// The close button must not also count as a tap on the toast (which
  /// opens the error details).
  close(event: Event) {
    event.stopPropagation();
    this.remove();
  }

  showDetails(event: Event) {
    event.stopPropagation();
    this.tapToast();
  }

  /// Leaving with the mouse must not remove a toast the keyboard is in.
  override delayedHideToast() {
    if (this.host.nativeElement.contains(document.activeElement)) return;
    super.delayedHideToast();
  }

  onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) return;
    this.delayedHideToast();
  }
}
