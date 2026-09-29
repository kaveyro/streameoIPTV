import { Injectable } from "@angular/core";
import { Source } from "./models/source";
import { BehaviorSubject, Subject } from "rxjs";
import { MatMenuTrigger } from "@angular/material/menu";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "./error.service";
import { NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { invoke } from "@tauri-apps/api/core";
import { SortType } from "./models/sortType";
import { SetNodeDTO } from "./models/setNodeDTO";
import { Channel } from "./models/channel";

@Injectable({
  providedIn: "root",
})
export class MemoryService {
  constructor(
    private toastr: ToastrService,
    private error: ErrorService,
  ) {
    invoke("is_container")
      .then((val) => (this.IsContainer = val as boolean))
      .catch((e) => {
        console.error(e);
        this.IsContainer = false;
      });
  }
  public SetNode: Subject<SetNodeDTO> = new Subject();
  public SetFocus: Subject<number> = new Subject();
  public Sort: BehaviorSubject<[number, boolean]> = new BehaviorSubject<[number, boolean]>([
    SortType.provider,
    false,
  ]);
  public Sources: Map<number, Source> = new Map();
  public currentContextMenu?: MatMenuTrigger;
  /// Number of tryIPC operations still running. A counter instead of a flag,
  /// so one of two concurrent operations finishing does not re-enable buttons
  /// while the other is still busy.
  private loadingCount = 0;
  public get Loading(): boolean {
    return this.loadingCount > 0;
  }
  public Refresh: Subject<boolean> = new Subject();
  public RefreshSources: Subject<boolean> = new Subject();
  public AddingAdditionalSource = false;
  public SeriesRefreshed: Map<number, boolean> = new Map();
  public HideChannels: Subject<boolean> = new Subject();
  public CustomSourceIds: Set<number> = new Set();
  public XtreamSourceIds: Set<number> = new Set();
  public ModalRef?: NgbModalRef;
  public Watched_epgs: Set<string> = new Set();
  private downloadingChannels: Map<number, [number, Subject<boolean>]> = new Map();
  public LoadingNotification: boolean = false;
  public trayEnabled?: boolean;
  public IsContainer?: boolean;
  public AlwaysAskSave?: boolean;
  public ShowChannelSource: boolean = true;
  /// Embedded player: a channel-tile requests playback by emitting here; the
  /// PlayerComponent opens the in-app player and drives mpv over IPC.
  public PlayerOpen: Subject<Channel> = new Subject();
  /// The currently displayed channel list, mirrored so the player's side list
  /// can offer seamless switching without going back to the grid.
  public PlayerChannelList: Channel[] = [];
  /// When true, playback keeps using the classic external mpv window instead of
  /// the embedded player (user setting / non-Windows).
  public UseExternalPlayer: boolean = false;
  /// Whether the embedded player view is currently shown.
  public PlayerVisible: boolean = false;
  /// Emits after settings that only apply when mpv spawns were changed and the
  /// embedded player was torn down; the PlayerComponent re-inits on next open.
  public PlayerReset: Subject<void> = new Subject();

  async tryIPC<T>(
    successMessage: string,
    errorMessage: string,
    action: () => Promise<T>,
  ): Promise<boolean> {
    this.loadingCount++;
    let error = false;
    try {
      await action();
      this.toastr.success(successMessage);
    } catch (e) {
      this.error.handleError(e, errorMessage);
      error = true;
    } finally {
      this.loadingCount = Math.max(0, this.loadingCount - 1);
    }
    return error;
  }

  /**
   * The embedded player's native window composites above the WebView, so a
   * modal opened while it is visible would be hidden underneath the video.
   * Hides the native window until `closed` settles, then shows it again if the
   * player is still open.
   */
  async hidePlayerWhile(closed: Promise<unknown>): Promise<void> {
    if (!this.PlayerVisible) {
      await closed.catch(() => {});
      return;
    }
    await invoke("player_set_visible", { visible: false }).catch(() => {});
    await closed.catch(() => {});
    if (this.PlayerVisible) {
      await invoke("player_set_visible", { visible: true }).catch(() => {});
    }
  }

  async get_epg_ids() {
    let data = await invoke("get_epg_ids");
    let set = new Set(data as Array<string>);
    this.Watched_epgs = set;
  }

  addDownloadingChannel(id: number) {
    this.downloadingChannels.set(id, [0, new Subject()]);
  }

  notifyDownloadFinished(id: number) {
    this.downloadingChannels.get(id)?.[1].next(true);
  }

  removeDownloadingChannel(id: number) {
    this.downloadingChannels.delete(id);
  }

  downloadExists(id: number) {
    return this.downloadingChannels.has(id);
  }

  getDownload(id: number) {
    return this.downloadingChannels.get(id);
  }

  setLastDownloadProgress(id: number, progress: number) {
    this.downloadingChannels.get(id)![0] = progress;
  }
}
