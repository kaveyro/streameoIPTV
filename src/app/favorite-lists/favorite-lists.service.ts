import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import { BehaviorSubject } from "rxjs";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { ErrorService } from "../error.service";
import { ConfirmService } from "../confirm.service";
import { FavoriteListNameModalComponent } from "./favorite-list-name-modal/favorite-list-name-modal.component";

export interface FavoriteList {
  id: number;
  name: string;
  position: number;
  /// Channels in the list.
  count: number;
}

/// sessionStorage key of the chip selected in the favorites view.
const SELECTED_LIST = "favoriteListSelected";

/**
 * The user's favorites lists (named lists besides the favorites, kept per
 * source + channel name so they survive refreshes). Shared by the home page's
 * list chips and the tiles' "add to list" menu, so both show the same lists
 * and counts.
 */
@Injectable({
  providedIn: "root",
})
export class FavoriteListsService {
  /// All lists; undefined until the first load answered.
  readonly lists = new BehaviorSubject<FavoriteList[] | undefined>(undefined);
  /// The chip selected in the favorites view (undefined: the favorites),
  /// remembered for the session.
  private _selected?: number = FavoriteListsService.readSelected();

  constructor(
    private modal: NgbModal,
    private memory: MemoryService,
    private error: ErrorService,
    private translate: TranslateService,
    private confirmService: ConfirmService,
  ) {}

  get selected(): number | undefined {
    return this._selected;
  }

  set selected(id: number | undefined) {
    this._selected = id;
    try {
      if (id === undefined) sessionStorage.removeItem(SELECTED_LIST);
      else sessionStorage.setItem(SELECTED_LIST, String(id));
    } catch {
      // Only a convenience: the selection then lasts as long as the page.
    }
  }

  private static readSelected(): number | undefined {
    try {
      const id = Number(sessionStorage.getItem(SELECTED_LIST) ?? "");
      return Number.isInteger(id) && id > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  current(): FavoriteList[] {
    return this.lists.value ?? [];
  }

  /** Loads the lists with their counts; best effort (the chips stay as they are). */
  async load(): Promise<FavoriteList[]> {
    try {
      const lists = (await invoke<FavoriteList[]>("get_favorite_lists")) ?? [];
      this.lists.next(lists);
      return lists;
    } catch (e) {
      console.error(e);
      return this.current();
    }
  }

  /** Asks for a name and creates the list. Resolves to the new list's id. */
  async promptCreate(): Promise<number | undefined> {
    const name = await this.askName("FAV_LISTS.CREATE_TITLE", "FAV_LISTS.CREATE");
    if (!name) return undefined;
    try {
      const id = await invoke<number>("create_favorite_list", { name });
      await this.load();
      return id;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("FAV_LISTS.CREATE_FAILED"));
      return undefined;
    }
  }

  /** Asks for a new name. Resolves to true when the list was renamed. */
  async promptRename(list: FavoriteList): Promise<boolean> {
    const name = await this.askName("FAV_LISTS.RENAME_TITLE", "MODAL.SAVE", list.name);
    if (!name || name === list.name) return false;
    try {
      await invoke("rename_favorite_list", { id: list.id, name });
      await this.load();
      return true;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("FAV_LISTS.RENAME_FAILED"));
      return false;
    }
  }

  /** Asks for confirmation and deletes the list (the channels stay). */
  async delete(list: FavoriteList): Promise<boolean> {
    const confirmed = await this.confirmService.confirm({
      title: "FAV_LISTS.DELETE_TITLE",
      messages: ["FAV_LISTS.DELETE_BODY"],
      confirmLabel: "MODAL.DELETE",
      params: { name: list.name },
    });
    if (!confirmed) return false;
    try {
      await invoke("delete_favorite_list", { id: list.id });
      if (this.selected === list.id) this.selected = undefined;
      await this.load();
      this.error.success(this.translate.instant("FAV_LISTS.DELETED", { name: list.name }));
      return true;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("FAV_LISTS.DELETE_FAILED"));
      return false;
    }
  }

  /** Ids of the lists the channel is in; empty when that is unknown. */
  async membership(channel: Channel): Promise<Set<number>> {
    try {
      return new Set((await invoke<number[]>("get_channel_favorite_lists", { channel })) ?? []);
    } catch (e) {
      console.error(e);
      return new Set();
    }
  }

  /** Adds the channel to the list, or takes it out. Resolves to true on success. */
  async setMember(list: FavoriteList, channel: Channel, member: boolean): Promise<boolean> {
    const params = { name: channel.name ?? "", list: list.name };
    try {
      await invoke(member ? "add_to_favorite_list" : "remove_from_favorite_list", {
        listId: list.id,
        channel,
      });
      this.error.success(
        this.translate.instant(member ? "FAV_LISTS.ADDED" : "FAV_LISTS.REMOVED", params),
      );
      // Only the counts changed: best effort.
      void this.load();
      return true;
    } catch (e) {
      this.error.handleError(e, this.translate.instant("FAV_LISTS.UPDATE_FAILED", params));
      return false;
    }
  }

  /// Resolves to the trimmed name, or null when cancelled.
  private askName(title: string, confirmLabel: string, name = ""): Promise<string | null> {
    const ref = this.modal.open(FavoriteListNameModalComponent, {
      size: "sm",
      centered: true,
      ariaLabelledBy: "favorite-list-name-title",
    });
    const instance = ref.componentInstance as FavoriteListNameModalComponent;
    instance.title = title;
    instance.confirmLabel = confirmLabel;
    instance.name = name;
    const result = ref.result.then(
      (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
      () => null,
    );
    void this.memory.hidePlayerWhile(result);
    return result;
  }
}
