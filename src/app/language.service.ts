import { ApplicationRef, Injectable } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";

@Injectable({ providedIn: "root" })
export class LanguageService {
  static readonly SUPPORTED = [
    "en", "de", "tr", "es", "fr", "it", "pt", "nl", "pl", "ru",
    "uk", "ar", "zh", "ja", "ko", "hi", "el", "ro",
  ]; // keep in sync with the options in settings.component.html and the i18n files
  private static readonly RTL = ["ar"];

  constructor(
    private translate: TranslateService,
    private appRef: ApplicationRef,
  ) {
    this.translate.setDefaultLang("en");
  }

  /** Resolve a stored setting (may be undefined / "system") to a supported code. */
  resolve(setting?: string): string {
    if (setting && LanguageService.SUPPORTED.includes(setting)) {
      return setting;
    }
    const prefix = (navigator.language || "en").slice(0, 2).toLowerCase();
    return LanguageService.SUPPORTED.includes(prefix) ? prefix : "en";
  }

  isRtl(lang: string): boolean {
    return LanguageService.RTL.includes(lang);
  }

  apply(setting?: string) {
    const lang = this.resolve(setting);
    // use() may load the language file asynchronously; force a change-detection
    // pass once it resolves so every translated string refreshes on the first
    // switch (otherwise the view only updates on the next user interaction).
    this.translate.use(lang).subscribe({
      next: () => {
        document.documentElement.dir = this.isRtl(lang) ? "rtl" : "ltr";
        this.appRef.tick();
      },
      error: () => {},
    });
  }
}
