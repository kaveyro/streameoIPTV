/**
 * The theme setting is only known once get_settings answered, which is after
 * Angular bootstrapped: without a cache light-theme users saw a dark flash on
 * every start. The last applied theme and accent are kept in localStorage and
 * applied by main.ts before the bootstrap (the CSP forbids an inline script).
 */
const STORAGE_KEY = "streameo.theme";

/** Theme without a stored setting; matches the settings page default. */
export const DEFAULT_THEME = "system";

interface CachedTheme {
  theme?: string;
  accent?: string;
}

/** Remembers the theme and accent setting that were just applied. */
export function cacheTheme(theme: string | undefined, accent: string | undefined) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, accent } satisfies CachedTheme));
  } catch {
    // Storage unavailable: the next start just applies the default first.
  }
}

export function readCachedTheme(): CachedTheme {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as CachedTheme | null;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * Applies the cached theme the way ThemeService does (data-theme/data-accent
 * on <html> and <body>, color-scheme), once and without following later OS
 * changes: ThemeService takes over as soon as the settings are loaded.
 */
export function applyCachedTheme() {
  const { theme = DEFAULT_THEME, accent } = readCachedTheme();
  let resolved = theme;
  if (theme === "system") {
    resolved = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  for (const element of [document.documentElement, document.body]) {
    if (!element) continue;
    if (resolved && resolved !== "dark") element.dataset["theme"] = resolved;
    if (accent && accent !== "blue") element.dataset["accent"] = accent;
  }
  document.documentElement.style.colorScheme = resolved === "light" ? "light" : "dark";
}
