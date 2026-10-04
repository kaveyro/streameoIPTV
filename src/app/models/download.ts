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
  /// Bytes received so far (event download-bytes-<id>).
  downloaded?: number;
  /// Size of the file, when the server sends it.
  total?: number | null;
  /// Transfer rate in bytes per second, smoothed.
  speed?: number;
  /// Continue a partial file (<path>.part) instead of starting over.
  resume?: boolean;
  /// Where the finished file was saved (returned by the backend).
  filePath?: string;
}
