import { Component, OnInit } from "@angular/core";
import { Channel } from "../models/channel";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ErrorService } from "../error.service";
import { NetworkInfo } from "../models/networkInfo";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { save } from "@tauri-apps/plugin-dialog";
import { sanitizeFileName } from "../utils";
import { CHANNEL_EXTENSION } from "../models/extensions";
import { TranslateService } from "@ngx-translate/core";
import { RestreamService, restreamUrlFor } from "../restream.service";

/// One address the restream can be reached at.
export interface RestreamAddress {
  host: string;
  /// The full URL to open, when the backend could tell.
  url?: string;
  wan: boolean;
}

/**
 * Starts, shows and stops the restream. The restream itself lives in
 * RestreamService: the dialog can be hidden (Escape, "Hide") while it runs,
 * and reopened from the status chip.
 */
@Component({
  selector: "app-restream-modal",
  standalone: false,
  templateUrl: "./restream-modal.component.html",
  styleUrl: "./restream-modal.component.css",
})
export class RestreamModalComponent implements OnInit {
  channel?: Channel;
  networkInfo?: NetworkInfo;
  networkError = false;
  selectedIP?: string;
  /// Where others reach the restream: the local addresses, then the public one.
  addresses: RestreamAddress[] = [];

  constructor(
    private error: ErrorService,
    public activeModal: NgbActiveModal,
    private translate: TranslateService,
    public restream: RestreamService,
  ) {}

  /// This dialog's channel is the one being re-streamed.
  private get ours(): boolean {
    return this.restream.active && this.restream.channel?.id === this.channel?.id;
  }

  get started(): boolean {
    return this.ours && this.restream.state === "running";
  }

  get starting(): boolean {
    return this.ours && this.restream.state === "starting";
  }

  /// Start/stop is in progress: the buttons wait.
  get loading(): boolean {
    return this.ours && (this.restream.state === "starting" || this.restream.state === "stopping");
  }

  get localAddresses(): RestreamAddress[] {
    return this.addresses.filter((a) => !a.wan);
  }

  get wanAddress(): RestreamAddress | undefined {
    return this.addresses.find((a) => a.wan);
  }

  ngOnInit(): void {
    this.loadNetwork();
  }

  private async loadNetwork() {
    try {
      this.networkInfo = (await invoke("get_network_info")) as NetworkInfo;
    } catch (e) {
      // Without the network info there is no port to re-stream on; Start
      // stays disabled instead of throwing on networkInfo!.port.
      this.networkError = true;
      this.error.handleError(e, this.translate.instant("TOAST.NETWORK_INFO_FAILED"));
      return;
    }
    this.selectedIP = this.networkInfo.local_ips[0];
    // The URL carries the restream's secret path; it is the same for every
    // run of the app, so it is known before the restream starts.
    const port = this.restream.port ?? this.networkInfo.port;
    const localUrl = await invoke<string>("restream_url", { port }).catch((e) => {
      console.error(e);
      return "";
    });
    const wan = typeof this.networkInfo.wan_ip === "string" ? this.networkInfo.wan_ip : "";
    this.addresses = [
      ...(this.networkInfo.local_ips ?? []).map((host) => ({ host, wan: false })),
      ...(wan ? [{ host: wan, wan: true }] : []),
    ].map((a) => ({ ...a, url: restreamUrlFor(localUrl, a.host) }));
  }

  start() {
    if (!this.networkInfo || !this.channel || this.restream.active) return;
    // Resolves only when the restream ends; the dialog may be closed by then.
    void this.restream.start(this.channel, this.networkInfo.port);
  }

  async stop() {
    await this.restream.stop();
  }

  async watch() {
    await this.restream.watch();
    // The player opens behind the dialog otherwise.
    this.hide();
  }

  /// Closes the dialog; a running restream goes on (status chip).
  hide() {
    this.activeModal.close("hide");
  }

  async copy(address: RestreamAddress) {
    try {
      await writeText(address.url ?? address.host);
      this.error.success(this.translate.instant("RESTREAM.COPIED"));
    } catch (e) {
      this.error.handleError(e);
    }
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
    // The exported channel plays this address as it is: the full URL, not
    // only the IP.
    const address = this.addresses.find((a) => a.host === this.selectedIP);
    try {
      await invoke("share_restream", {
        address: address?.url ?? this.selectedIP,
        channel: this.channel,
        path: file,
      });
      this.error.success(this.translate.instant("TOAST.RESTREAM_EXPORTED", { path: file }));
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
