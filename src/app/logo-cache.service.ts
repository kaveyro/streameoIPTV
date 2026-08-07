import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

@Injectable({
  providedIn: "root",
})
export class LogoCacheService {
  private cache = new Map<string, Promise<string>>();

  /**
   * Resolves a channel logo URL to a data URL served from the on-disk cache,
   * downloading and caching it first if necessary. Concurrent requests for the
   * same URL are deduped via an in-memory promise map. On any error the
   * original remote URL is returned so the image can still load directly.
   */
  getLogo(url: string): Promise<string> {
    const existing = this.cache.get(url);
    if (existing) {
      return existing;
    }
    const promise = invoke<string>("get_cached_logo", { url }).catch(() => {
      // Drop the failed entry so a later tile can retry, but still resolve
      // to the remote URL as a graceful fallback for current callers.
      this.cache.delete(url);
      return url;
    });
    this.cache.set(url, promise);
    return promise;
  }
}
