import { Injectable } from "@angular/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { TranslateService } from "@ngx-translate/core";
import { MemoryService } from "./memory.service";
import { PinDialogComponent } from "./pin-dialog/pin-dialog.component";
import { Channel } from "./models/channel";

/** Parental lock actions shared by the home toolbar and the group tiles. */
@Injectable({
  providedIn: "root",
})
export class ParentalService {
  constructor(
    private modal: NgbModal,
    private memory: MemoryService,
    private toastr: ToastrService,
    private translate: TranslateService,
  ) {}

  /** Asks for the PIN; resolves to the PIN, or null when cancelled. */
  async askPin(
    title = "PARENTAL.ENTER_PIN",
    message?: string,
    params: Record<string, unknown> = {},
  ): Promise<string | null> {
    const ref = this.modal.open(PinDialogComponent, { size: "sm", centered: true });
    const instance = ref.componentInstance as PinDialogComponent;
    instance.title = title;
    instance.message = message;
    instance.params = params;
    const result = ref.result.then(
      (value) => (typeof value === "string" ? value : null),
      () => null,
    );
    void this.memory.hidePlayerWhile(result);
    return result;
  }

  /** Shows (after asking the PIN) or hides the locked groups for this session. */
  async toggleShowLocked(): Promise<boolean> {
    if (this.memory.ShowLocked) {
      this.memory.ShowLocked = false;
      return true;
    }
    const pin = await this.askPin("PARENTAL.ENTER_PIN", "PARENTAL.UNLOCK_HINT");
    if (pin === null) return false;
    try {
      if (!(await invoke<boolean>("verify_parental_pin", { pin }))) {
        this.toastr.error(this.translate.instant("PARENTAL.WRONG_PIN"));
        return false;
      }
    } catch (e) {
      this.toastr.error(String(e));
      return false;
    }
    this.memory.ShowLocked = true;
    return true;
  }

  isLocked(group?: Channel): boolean {
    return group?.id !== undefined && this.memory.LockedGroupIds.has(group.id);
  }

  /** Locks or unlocks a group after asking the PIN. Resolves to true on success. */
  async toggleGroupLock(group: Channel): Promise<boolean> {
    if (group.id === undefined) return false;
    if (!this.memory.HasParentalPin) {
      this.toastr.info(this.translate.instant("PARENTAL.SET_PIN_FIRST"));
      return false;
    }
    const locked = !this.isLocked(group);
    const pin = await this.askPin(
      locked ? "PARENTAL.LOCK_GROUP_TITLE" : "PARENTAL.UNLOCK_GROUP_TITLE",
      undefined,
      { name: group.name ?? "" },
    );
    if (pin === null) return false;
    try {
      await invoke("set_group_locked", { groupId: group.id, locked, pin });
    } catch (e) {
      // "Wrong PIN" and the like: the backend message is meant for the user.
      this.toastr.error(String(e));
      return false;
    }
    if (locked) this.memory.LockedGroupIds.add(group.id);
    else this.memory.LockedGroupIds.delete(group.id);
    this.toastr.success(
      this.translate.instant(locked ? "PARENTAL.GROUP_LOCKED" : "PARENTAL.GROUP_UNLOCKED", {
        name: group.name ?? "",
      }),
    );
    // The cache is refreshed from the backend too, in case another change
    // happened meanwhile.
    this.memory.refreshParental().catch((e) => console.error(e));
    return true;
  }
}
