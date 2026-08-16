import { UnlistenFn } from "@tauri-apps/api/event";
import { Subject } from "rxjs";
import { Channel } from "./channel";

export enum DownloadStatus {
  /// Waiting in the queue, nothing transferred yet.
  Queued = "queued",
  /// Currently transferring.
  Active = "active",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export class Download {
  id!: string;
  progress!: number;
  complete!: Subject<boolean>;
  channel!: Channel;
  unlisten?: UnlistenFn;
  progressUpdate!: Subject<number>;
  status!: DownloadStatus;
  /// Explicit target path chosen by the user, kept so a retry reuses it.
  path?: string;
  /// Failure reason, shown in the download manager.
  error?: string;
}
