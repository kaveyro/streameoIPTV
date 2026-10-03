import { ApplicationRef, Injectable } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";
import { invoke } from "@tauri-apps/api/core";

/// Strings the backend shows outside the WebView (tray menu, notifications,
/// quit dialog): translation key -> name in set_native_strings.
export const NATIVE_STRING_KEYS: Record<string, string> = {
  "NATIVE.TRAY_SHOW": "tray_show",
  "NATIVE.TRAY_QUIT": "tray_quit",
  "NATIVE.TRAY_PAUSE": "tray_pause",
  "NATIVE.TRAY_STOP": "tray_stop",
  "NATIVE.REMINDER_TITLE": "reminder_title",
  "NATIVE.REMINDER_BODY": "reminder_body",
  "NATIVE.RECORDING_STARTED": "recording_started",
  "NATIVE.RECORDING_FINISHED": "recording_finished",
  "NATIVE.RECORDING_FAILED": "recording_failed",
  "NATIVE.SCHEDULED_PROGRAM": "scheduled_program",
  "NATIVE.LOCAL_LIVESTREAM": "local_livestream",
  "NATIVE.QUIT_TITLE": "quit_title",
  "NATIVE.QUIT_BODY": "quit_body",
  "NATIVE.QUIT_CONFIRM": "quit_confirm",
  "NATIVE.QUIT_CANCEL": "quit_cancel",
};

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
  ]; // keep in sync with OPTIONS below and the i18n files
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
    // Emitted once the language's translations are loaded: every switch
    // (also the first one at startup) updates <html lang> and hands the
    // backend its strings in the new language.
    this.translate.onLangChange.subscribe((event) => {
      this.setDocumentLanguage(event.lang);
      this.sendNativeStrings();
    });
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

  /// Resolves once the language is in use (also when its file failed to
  /// load), e.g. to show a confirmation in the new language.
  apply(setting?: string): Promise<void> {
    const lang = this.resolve(setting);
    this.requested = lang;
    return new Promise<void>((resolve) => {
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
            resolve();
            return;
          }
          this.setDocumentLanguage(lang);
          this.appRef.tick();
          resolve();
        },
        error: () => resolve(),
        complete: () => resolve(),
      });
    });
  }

  /// lang (screen reader pronunciation, hyphenation) and text direction of
  /// the whole document.
  private setDocumentLanguage(lang: string) {
    document.documentElement.lang = lang;
    document.documentElement.dir = this.isRtl(lang) ? "rtl" : "ltr";
  }

  /// Tray menu, notifications and the quit dialog are drawn by the backend.
  /// Keys without a translation are left out (the backend keeps its default).
  private sendNativeStrings() {
    const strings: Record<string, string> = {};
    for (const [key, name] of Object.entries(NATIVE_STRING_KEYS)) {
      const value: unknown = this.translate.instant(key);
      if (typeof value === "string" && value && value !== key) strings[name] = value;
    }
    invoke("set_native_strings", { strings }).catch((e) => console.error(e));
  }
}
