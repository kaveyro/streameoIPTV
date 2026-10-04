import { Component, HostListener, OnInit } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { DownloadService } from "./download.service";
import { ThemeService } from "./theme.service";
import { LanguageService } from "./language.service";
import { UpdateService } from "./update.service";
import { Settings } from "./models/settings";
import { cacheTheme, DEFAULT_THEME } from "./theme-cache";
import { ZoomService } from "./zoom.service";
import { RestreamService } from "./restream.service";

/// Wheel delta of one zoom step: one notch of a mouse wheel.
const WHEEL_STEP_DELTA = 100;

@Component({
  selector: "app-root",
  standalone: false,
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  title = "streameoIPTV";
  private wheelDelta = 0;

  constructor(
    private download: DownloadService,
    private theme: ThemeService,
    private language: LanguageService,
    private update: UpdateService,
    private zoom: ZoomService,
    public restream: RestreamService,
  ) {}

  ngOnInit(): void {
    // Apply the OS-resolved language immediately so first paint is localized;
    // the stored preference (if any) is applied once settings load.
    this.language.apply(undefined);
    this.applySettings();
  }

  private async applySettings() {
    try {
      const settings = (await invoke("get_settings")) as Settings;
      // Unset follows the OS, as the settings page shows it.
      const theme = settings.theme ?? DEFAULT_THEME;
      this.theme.apply(theme, settings.accent_color);
      // main.ts applies it before the next bootstrap: no dark flash.
      cacheTheme(theme, settings.accent_color);
      this.language.apply(settings.language);
      // Known from here on for the Ctrl +/- shortcuts.
      this.zoom.apply(settings.zoom);
      // Opt-out, not opt-in: unset means check, which is what the app did
      // before the setting existed.
      if (settings.auto_update !== false) {
        this.update.check(false);
      }
    } catch {
      // Settings unavailable (e.g. first launch) — keep the defaults.
      this.theme.apply(DEFAULT_THEME, undefined);
    }
  }

  /// Ctrl + / Ctrl - / Ctrl 0 (also on the numpad) zoom the UI in steps and
  /// save the zoom like the settings field; the webview's own zoom hotkeys
  /// are off (tauri.conf.json), they neither saved nor showed the value.
  @HostListener("document:keydown", ["$event"])
  onZoomKey(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
    // AltGr arrives as Ctrl+Alt on Windows; that is not a zoom shortcut.
    if (event.getModifierState?.("AltGraph")) return;
    const action = zoomAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === "reset") this.zoom.reset();
    else this.zoom.step(action === "in" ? 1 : -1);
  }

  /// Ctrl + mouse wheel, which the webview's zoom did as well. Wheel deltas
  /// add up to one step, so a touchpad does not race through the range.
  @HostListener("document:wheel", ["$event"])
  onZoomWheel(event: WheelEvent) {
    if (!event.ctrlKey || event.deltaY === 0) {
      this.wheelDelta = 0;
      return;
    }
    this.wheelDelta += event.deltaY;
    if (Math.abs(this.wheelDelta) < WHEEL_STEP_DELTA) return;
    this.zoom.step(this.wheelDelta < 0 ? 1 : -1);
    this.wheelDelta = 0;
  }

  @HostListener("document:contextmenu", ["$event"])
  onRightClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (this.isInsideMenuTrigger(target)) {
      return;
    }
    event.preventDefault();
  }

  private isInsideMenuTrigger(element: HTMLElement): boolean {
    return !!element.closest("[mat-menu-trigger-for], [matMenuTriggerFor]");
  }

  showDownloadManager() {
    return this.download.Downloads.size > 0 || this.download.History.length > 0;
  }
}

/// The zoom shortcut of a key press, by the typed character (keyboard layout
/// independent: "+" is its own key on German keyboards) or the numpad key.
export function zoomAction(event: KeyboardEvent): "in" | "out" | "reset" | undefined {
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "in";
  if (event.key === "-" || event.code === "NumpadSubtract") return "out";
  if (event.key === "0" || event.code === "Numpad0") return "reset";
  return undefined;
}
