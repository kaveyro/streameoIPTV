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
import { CountryPrefixMode } from "./country-prefix";

/// A tile that left the list shown (see MemoryService.RemoveTile).
export interface RemovedTile {
  channel: Channel;
  /// Taken out of the favorites: only gone where the favorites are listed
  /// (not inside a series, not in a favorites list).
  unfavorited?: boolean;
}

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
  /// A tile left the list shown (removed from the history or a list, hidden,
  /// deleted, unfavorited in the favorites): the home page drops it in place
  /// instead of reloading the first page.
  public RemoveTile: Subject<RemovedTile> = new Subject();
  public CustomSourceIds: Set<number> = new Set();
  public XtreamSourceIds: Set<number> = new Set();
  /** An external XMLTV guide is cached: any live channel may have EPG, matched
   *  by tvg-id or, without one, by its name. */
  public HasXmltv = false;
  /** How channel names show their country prefix (appearance setting). */
  public CountryPrefixMode: CountryPrefixMode = "show";
  /** Switch to another feed of the same channel when a live stream fails
   *  (playback setting, on by default). */
  public AutoFallback = true;
  public ModalRef?: NgbModalRef;
  public Watched_epgs: Set<string> = new Set();
  private downloadingChannels: Map<number, [number, Subject<boolean>]> = new Map();
  public LoadingNotification = false;
  public trayEnabled?: boolean;
  public IsContainer?: boolean;
  public AlwaysAskSave?: boolean;
  public ShowChannelSource = true;
  /// Embedded player: a channel-tile requests playback by emitting here; the
  /// PlayerComponent opens the in-app player and drives mpv over IPC.
  public PlayerOpen: Subject<Channel> = new Subject();
  /// The currently displayed channel list, mirrored so the player's side list
  /// can offer seamless switching without going back to the grid.
  public PlayerChannelList: Channel[] = [];
  /// The library grid's playable channels, handed to the player when a tile
  /// starts playback. The player only follows its updates (more pages
  /// loaded) while it plays from this list, not catch-up or a recording.
  public LibraryChannelList: Channel[] = [];
  /// When true, playback keeps using the classic external mpv window instead of
  /// the embedded player (user setting / non-Windows).
  public UseExternalPlayer = false;
  /// Whether the embedded player view is currently shown.
  public PlayerVisible = false;
  /// Whether the embedded player plays on in the small corner window while
  /// the rest of the app is used (PlayerVisible is false then).
  public PlayerMini = false;
  /// Emits after settings that only apply when mpv spawns were changed and the
  /// embedded player was torn down; the PlayerComponent re-inits on next open.
  public PlayerReset: Subject<void> = new Subject();
  /// Such a setting changed while the mini player was playing: the player is
  /// rebuilt once that playback ends (the PlayerComponent checks this when it
  /// closes or opens the next channel) instead of cutting the stream off.
  public PlayerRebuildPending = false;
  /// Parental lock: whether a PIN is set (refreshed by the home page and the
  /// settings), and whether the PIN was entered in this session so locked
  /// groups are listed. Every `search` sends ShowLocked as `show_locked`.
  public HasParentalPin = false;
  public ShowLocked = false;
  /// Ids of the groups locked by the parental PIN.
  public LockedGroupIds: Set<number> = new Set();

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
      await closed.catch(() => undefined);
      return;
    }
    // Counted, so with two dialogs open closing the top one does not bring
    // the video back over the other.
    if (this.playerHiddenBy++ === 0) {
      await invoke("player_set_visible", { visible: false }).catch(() => undefined);
    }
    await closed.catch(() => undefined);
    if (--this.playerHiddenBy === 0 && this.PlayerVisible) {
      await invoke("player_set_visible", { visible: true }).catch(() => undefined);
    }
  }

  private playerHiddenBy = 0;

  /** Reloads whether a parental PIN exists and which groups are locked. */
  async refreshParental(): Promise<void> {
    const [hasPin, locked] = await Promise.all([
      invoke<boolean>("has_parental_pin"),
      invoke<number[]>("get_locked_group_ids"),
    ]);
    this.HasParentalPin = hasPin;
    this.LockedGroupIds = new Set(locked);
    // Without a PIN nothing is locked any more.
    if (!hasPin) this.ShowLocked = false;
  }

  async get_epg_ids() {
    const data = await invoke("get_epg_ids");
    const set = new Set(data as Array<string>);
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
