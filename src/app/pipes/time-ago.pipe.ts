import { Pipe, PipeTransform } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";

/**
 * "Just now" / "5 minutes ago" in the current UI language.
 *
 * Impure so the text keeps up with the clock and with language switches, but
 * the result is cached and only recomputed when the input or language changed
 * or the previous result is older than {@link TimeAgoPipe.REFRESH_MS}.
 */
@Pipe({
  name: "timeAgo",
  pure: false,
})
export class TimeAgoPipe implements PipeTransform {
  private static readonly REFRESH_MS = 30 * 1000;
  private static readonly INTERVALS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];

  private lastValue: unknown;
  private lastLang?: string;
  private lastComputedAt = 0;
  private lastResult = "";

  constructor(private translate: TranslateService) {}

  transform(value: number | string | Date | null | undefined): string {
    if (!value) return "";
    const lang = this.translate.getCurrentLang() || this.translate.getFallbackLang() || "en";
    const now = Date.now();
    if (
      value === this.lastValue &&
      lang === this.lastLang &&
      now - this.lastComputedAt < TimeAgoPipe.REFRESH_MS
    ) {
      return this.lastResult;
    }
    this.lastValue = value;
    this.lastLang = lang;
    this.lastComputedAt = now;
    this.lastResult = this.format(value, lang, now);
    return this.lastResult;
  }

  private format(value: number | string | Date, lang: string, now: number): string {
    const time = +new Date(value);
    if (Number.isNaN(time)) return String(value);
    const seconds = Math.floor((now - time) / 1000);
    if (seconds < 29) return this.translate.instant("TIME.JUST_NOW");
    let formatter: Intl.RelativeTimeFormat;
    try {
      formatter = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
    } catch {
      formatter = new Intl.RelativeTimeFormat("en", { numeric: "always" });
    }
    for (const [unit, size] of TimeAgoPipe.INTERVALS) {
      const counter = Math.floor(seconds / size);
      if (counter > 0) return formatter.format(-counter, unit);
    }
    return this.translate.instant("TIME.JUST_NOW");
  }
}
