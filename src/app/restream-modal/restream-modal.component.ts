import { Component, NgZone, OnDestroy, OnInit } from "@angular/core";
import { Channel } from "../models/channel";
import { invoke } from "@tauri-apps/api/core";
import { ErrorService } from "../error.service";
import { NetworkInfo } from "../models/networkInfo";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { sanitizeFileName } from "../utils";
import { CHANNEL_EXTENSION } from "../models/extensions";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "app-restream-modal",
  standalone: false,
  templateUrl: "./restream-modal.component.html",
  styleUrl: "./restream-modal.component.css",
})
export class RestreamModalComponent implements OnInit, OnDestroy {
  channel?: Channel;
  loading = false;
  watching = false;
  started = false;
  networkInfo?: NetworkInfo;
  networkError = false;
  selectedIP?: string;
  toUnlisten: UnlistenFn[] = [];

  constructor(
    private error: ErrorService,
    public activeModal: NgbActiveModal,
    private ngZone: NgZone,
    private translate: TranslateService,
  ) {}

  ngOnInit(): void {
    invoke("get_network_info")
      .then((network) => {
        this.networkInfo = network as NetworkInfo;
        this.selectedIP = this.networkInfo.local_ips[0];
      })
      .catch((e) => {
        // Without the network info there is no port to re-stream on; Start
        // stays disabled instead of throwing on networkInfo!.port.
        this.networkError = true;
        this.error.handleError(e, this.translate.instant("TOAST.NETWORK_INFO_FAILED"));
      });
    listen<boolean>("restream_started", () => {
      this.ngZone.run(() => {
        this.started = true;
        this.loading = false;
      });
    }).then((unlisten) => this.toUnlisten.push(unlisten));
  }

  async start() {
    if (!this.networkInfo) return;
    this.loading = true;
    try {
      await invoke("start_restream", { channel: this.channel, port: this.networkInfo.port });
    } catch (e) {
      this.error.handleError(e);
    }
    this.started = false;
    this.loading = false;
  }

  async stop() {
    this.loading = true;
    try {
      await invoke("stop_restream");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async watch() {
    this.watching = true;
    try {
      await invoke("watch_self", { port: this.networkInfo?.port });
    } catch (e) {
      this.error.handleError(e);
    }
    this.watching = false;
  }

  async share() {
    const file = await save({
      canCreateDirectories: true,
      title: this.translate.instant("DIALOG.EXPORT_RESTREAM"),
      defaultPath: `${sanitizeFileName(this.channel?.name!)}_rst${CHANNEL_EXTENSION}`,
    });
    if (!file) {
      return;
    }
    try {
      await invoke("share_restream", {
        address: this.selectedIP,
        channel: this.channel,
        path: file,
      });
      this.error.success(this.translate.instant("TOAST.RESTREAM_EXPORTED", { path: file }));
    } catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy(): void {
    this.toUnlisten.forEach((x) => x());
  }
}
