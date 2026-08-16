import { Component, HostListener, OnInit } from "@angular/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { DownloadService } from "./download.service";
import { ErrorService } from "./error.service";
import { ThemeService } from "./theme.service";
import { LanguageService } from "./language.service";
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
    private error: ErrorService,
    private theme: ThemeService,
    private language: LanguageService,
  ) {}

  ngOnInit(): void {
    // Apply the OS-resolved language immediately so first paint is localized;
    // the stored preference (if any) is applied once settings load.
    this.language.apply(undefined);
    this.applySettings();
    this.checkForUpdates();
  }

  private async applySettings() {
    try {
      const settings = (await invoke("get_settings")) as Settings;
      this.theme.apply(settings.theme, settings.accent_color);
      this.language.apply(settings.language);
    } catch {
      // Settings unavailable (e.g. first launch) — keep the defaults.
    }
  }

  private async checkForUpdates() {
    try {
      const update = await check();
      if (!update) {
        return;
      }
      this.error.info(`Downloading update v${update.version}...`);
      await update.downloadAndInstall();
      this.error.success("Update installed, restarting...");
      await relaunch();
    } catch {
      // No update endpoint reachable (e.g. no release published yet) — stay silent.
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
