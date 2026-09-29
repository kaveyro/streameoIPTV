import { Injectable } from "@angular/core";

@Injectable({
  providedIn: "root",
})
export class ThemeService {
  private systemQuery = window.matchMedia("(prefers-color-scheme: light)");
  private systemListener?: (event: MediaQueryListEvent) => void;

  /**
   * Applies the given theme and accent color via data attributes on <html>
   * and <body> (html so the root scrollbar and color-scheme follow the theme,
   * body for everything rendered inside it, incl. modals, menus and toasts).
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
    this.setAttribute("accent", !accent || accent == "blue" ? undefined : accent);
  }

  private setTheme(theme: string | undefined) {
    this.setAttribute("theme", !theme || theme == "dark" ? undefined : theme);
    // Native scrollbars, form popups (select lists, date pickers) and the
    // default canvas follow color-scheme; OLED is a dark scheme too.
    document.documentElement.style.colorScheme = theme == "light" ? "light" : "dark";
  }

  private setAttribute(name: "theme" | "accent", value: string | undefined) {
    for (const element of [document.documentElement, document.body]) {
      if (value === undefined) {
        delete element.dataset[name];
      } else {
        element.dataset[name] = value;
      }
    }
  }

  private clearSystemListener() {
    if (this.systemListener) {
      this.systemQuery.removeEventListener("change", this.systemListener);
      this.systemListener = undefined;
    }
  }
}
