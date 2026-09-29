import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "./memory.service";
import { Channel } from "./models/channel";

/**
 * The one way to start playback of a channel (tiles, the TV guide, the
 * recordings view). The user's external player keeps using the classic
 * spawn-a-window path; everything else opens the embedded player, which falls
 * back to that path by itself where it is unavailable (not on Windows).
 */
@Injectable({
  providedIn: "root",
})
export class PlaybackService {
  constructor(private memory: MemoryService) {}

  async play(channel: Channel): Promise<void> {
    if (this.memory.UseExternalPlayer) {
      await invoke("play", { channel, record: false, recordPath: null });
    } else {
      this.memory.PlayerOpen.next(channel);
    }
  }

  /** Adds a real (stored) channel to the history; pseudo channels are skipped. */
  async addToHistory(channel: Channel): Promise<void> {
    if (channel.id === undefined || channel.id < 0) return;
    await invoke("add_last_watched", { id: channel.id });
  }
}
