export const isInputFocused = () => {
  const activeElement = document.activeElement;
  const inputs = ["input", "select", "button", "textarea"];
  return activeElement && inputs.indexOf(activeElement.tagName?.toLowerCase()) !== -1;
};

export const sanitizeFileName = (fileName: string) => {
  return (
    fileName
      .replace(/[/\\:*?"<>|]/g, "_")
      // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
      .replace(/[\x00-\x1F\x7F]/g, "")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .replace(/^\s+|\s+$/g, "") || "untitled"
  );
};

export const getDateFormatted = (): string => {
  return new Date().toISOString().replace(/T|:/g, "-").split(".")[0];
};

export const getExtension = (url: string): string => {
  const split = url.split(".");
  const last = split[split.length - 1];
  if (split.length == 1 || last.startsWith("php?")) return "mp4";
  else return last;
};

/// Locale for Intl formatting: the active UI language, else the default one.
export const uiLocale = (translate: {
  getCurrentLang(): string | null | undefined;
  getFallbackLang(): string | null | undefined;
}): string | undefined => translate.getCurrentLang() || translate.getFallbackLang() || undefined;

/// Human readable file size (1024-based units), formatted for the locale.
export const formatFileSize = (bytes: number, locale?: string): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, {
      maximumFractionDigits: unit === 0 ? 0 : 1,
    }).format(value);
  } catch {
    formatted = value.toFixed(unit === 0 ? 0 : 1);
  }
  return `${formatted} ${units[unit]}`;
};
