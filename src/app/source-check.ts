import { Source } from "./models/source";
import { SourceType } from "./models/sourceType";

/** Whether "Test connection" applies to a source type (remote sources only). */
export const canCheckSource = (type?: SourceType): boolean =>
  type === SourceType.Xtream || type === SourceType.M3ULink;

/**
 * The source as `check_source` expects it: trimmed (but the password, like
 * the login keeps it), a name (the backend
 * requires one), http:// assumed for a bare Xtream host and the Xtream API
 * path added to a bare origin, like the login does after asking.
 */
export const sourceForCheck = (source: Source): Source => {
  const checked: Source = {
    ...source,
    name: source.name?.trim() || "check",
    url: source.url?.trim(),
    username: source.username?.trim(),
    password: source.password,
    user_agent: source.user_agent?.trim() || undefined,
    enabled: source.enabled ?? true,
  };
  if (checked.source_type === SourceType.Xtream && checked.url) {
    if (!/^https?:\/\//i.test(checked.url)) checked.url = `http://${checked.url}`;
    try {
      const url = new URL(checked.url);
      if (url.pathname === "/") {
        url.pathname = "/player_api.php";
        checked.url = url.toString();
      }
    } catch {
      // Left as is: the backend reports the invalid URL.
    }
  } else {
    checked.username = undefined;
    checked.password = undefined;
  }
  return checked;
};
