import { Component, HostListener, OnInit } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { DownloadService } from "./download.service";
import { ThemeService } from "./theme.service";
import { LanguageService } from "./language.service";
import { UpdateService } from "./update.service";
import { Settings } from "./models/settings";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  title = "open-tv";

  constructor(
    private download: DownloadService,
    private theme: ThemeService,
    private language: LanguageService,
    private update: UpdateService,
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
      this.theme.apply(settings.theme, settings.accent_color);
      this.language.apply(settings.language);
      // Opt-out, not opt-in: unset means check, which is what the app did
      // before the setting existed.
      if (settings.auto_update !== false) {
        this.update.check(false);
      }
    } catch {
      // Settings unavailable (e.g. first launch) — keep the defaults.
    }
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
