import { Injectable, OnDestroy } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BehaviorSubject } from "rxjs";
import { Settings } from "./models/settings";

/// UI zoom range in percent, as the settings field offers it.
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_DEFAULT = 100;
/// Step of the keyboard shortcuts (Ctrl +/-) and the settings spinner.
export const ZOOM_STEP = 10;
/// Shortcut presses in a row are saved once.
const SAVE_DEBOUNCE_MS = 400;

/// A typed or computed zoom within the supported range, or undefined when
/// it is no number at all.
export function clampZoom(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
}

/**
 * The UI zoom: applied to the webview, saved with the settings and shared by
 * the settings field and the Ctrl +/-/0 shortcuts (app.component).
 */
@Injectable({ providedIn: "root" })
export class ZoomService implements OnDestroy {
  private readonly zoom = new BehaviorSubject<number>(ZOOM_DEFAULT);
  /// The current zoom in percent; emits on every change.
  readonly changes = this.zoom.asObservable();
  private saveTimer?: ReturnType<typeof setTimeout>;

  get value(): number {
    return this.zoom.value;
  }

  /// A shortcut's zoom is still waiting to be saved: the stored value is older.
  get savePending(): boolean {
    return this.saveTimer !== undefined;
  }

  /** Applies a stored zoom (settings just loaded) without saving it again. */
  apply(value: number | null | undefined) {
    const zoom = clampZoom(value) ?? ZOOM_DEFAULT;
    // The stored value wins (e.g. a restored backup) over an unsaved one.
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.zoom.next(zoom);
    this.applyToWebview(zoom);
  }

  /**
   * Applies a new zoom and saves it (debounced). Returns the effective,
   * clamped value; an invalid input keeps the current zoom.
   */
  set(value: number | null | undefined): number {
    const zoom = clampZoom(value) ?? this.value;
    if (zoom === this.value) return zoom;
    this.zoom.next(zoom);
    this.applyToWebview(zoom);
    this.scheduleSave();
    return zoom;
  }

  /** One step in or out (Ctrl + / Ctrl -). */
  step(direction: 1 | -1): number {
    return this.set(this.value + direction * ZOOM_STEP);
  }

  /** Back to 100 % (Ctrl 0). */
  reset(): number {
    return this.set(ZOOM_DEFAULT);
  }

  ngOnDestroy() {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
  }

  private applyToWebview(zoom: number) {
    getCurrentWebview()
      .setZoom(Math.trunc(zoom * 100) / 10000)
      .catch((e) => console.error(e));
  }

  private scheduleSave() {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /// update_settings stores the whole object: the other settings are read
  /// back first so only the zoom changes.
  private async save() {
    try {
      const settings = ((await invoke<Settings>("get_settings")) ?? {}) as Settings;
      if (settings.zoom === this.value) return;
      await invoke("update_settings", { settings: { ...settings, zoom: this.value } });
    } catch (e) {
      console.error(e);
    }
  }
}
