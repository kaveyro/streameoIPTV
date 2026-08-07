import { Injectable } from "@angular/core";

@Injectable({
  providedIn: "root",
})
export class ThemeService {
  private systemQuery = window.matchMedia("(prefers-color-scheme: light)");
  private systemListener?: (event: MediaQueryListEvent) => void;

  /**
   * Applies the given theme and accent color to <body> via data attributes.
   * - theme "dark" or undefined removes the attribute so the :root defaults apply.
   * - theme "system" resolves against prefers-color-scheme and keeps following
   *   OS changes until another theme is applied.
   */
  apply(theme: string | undefined, accent: string | undefined) {
    this.clearSystemListener();
    if (theme == "system") {
      this.setTheme(this.systemQuery.matches ? "light" : "dark");
      this.systemListener = (event) => this.setTheme(event.matches ? "light" : "dark");
      this.systemQuery.addEventListener("change", this.systemListener);
    } else {
      this.setTheme(theme);
    }
    if (!accent || accent == "blue") {
      delete document.body.dataset["accent"];
    } else {
      document.body.dataset["accent"] = accent;
    }
  }

  private setTheme(theme: string | undefined) {
    if (!theme || theme == "dark") {
      delete document.body.dataset["theme"];
    } else {
      document.body.dataset["theme"] = theme;
    }
  }

  private clearSystemListener() {
    if (this.systemListener) {
      this.systemQuery.removeEventListener("change", this.systemListener);
      this.systemListener = undefined;
    }
  }
}
