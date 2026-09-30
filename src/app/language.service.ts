import { ApplicationRef, Injectable } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";

@Injectable({ providedIn: "root" })
export class LanguageService {
  static readonly SUPPORTED = [
    "en",
    "de",
    "tr",
    "es",
    "fr",
    "it",
    "pt",
    "nl",
    "pl",
    "ru",
    "uk",
    "ar",
    "zh",
    "ja",
    "ko",
    "hi",
    "el",
    "ro",
  ]; // keep in sync with the options in settings.component.html and the i18n files
  private static readonly RTL = ["ar"];
  /// Native names for language pickers (settings, first-run setup).
  static readonly OPTIONS: { code: string; name: string }[] = [
    { code: "en", name: "English" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
    { code: "fr", name: "Français" },
    { code: "it", name: "Italiano" },
    { code: "pt", name: "Português" },
    { code: "nl", name: "Nederlands" },
    { code: "pl", name: "Polski" },
    { code: "ro", name: "Română" },
    { code: "el", name: "Ελληνικά" },
    { code: "ru", name: "Русский" },
    { code: "uk", name: "Українська" },
    { code: "tr", name: "Türkçe" },
    { code: "ar", name: "العربية" },
    { code: "hi", name: "हिन्दी" },
    { code: "zh", name: "中文" },
    { code: "ja", name: "日本語" },
    { code: "ko", name: "한국어" },
  ];

  constructor(
    private translate: TranslateService,
    private appRef: ApplicationRef,
  ) {
    this.translate.setFallbackLang("en");
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

  /// Language of the most recent apply() call; the one that must win.
  private requested?: string;

  apply(setting?: string) {
    const lang = this.resolve(setting);
    this.requested = lang;
    // use() may load the language file asynchronously; force a change-detection
    // pass once it resolves so every translated string refreshes on the first
    // switch (otherwise the view only updates on the next user interaction).
    this.translate.use(lang).subscribe({
      next: () => {
        const latest = this.requested ?? lang;
        if (lang !== latest) {
          // An older request finished after a newer one (its file loaded
          // slower) and switched the language back: re-assert the latest.
          if (this.translate.getCurrentLang() !== latest) this.translate.use(latest);
          return;
        }
        document.documentElement.dir = this.isRtl(lang) ? "rtl" : "ltr";
        this.appRef.tick();
      },
      error: () => undefined,
    });
  }
}
