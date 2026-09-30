import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatMenuTrigger, MatMenuModule } from "@angular/material/menu";
import { MemoryService } from "../../memory.service";
import { FavoriteList, FavoriteListsService } from "../favorite-lists.service";
import { CommonModule } from "@angular/common";
import { TranslatePipe } from "@ngx-translate/core";

/**
 * The chip row above the favorites view: "Favorites", one chip per list (with
 * a small rename/delete menu) and "New list". The home page owns the
 * selection and loads the chosen list; renaming and deleting go through
 * {@link FavoriteListsService}, whose reload the home page follows.
 */
@Component({
  imports: [CommonModule, TranslatePipe, MatMenuModule],
  selector: "app-favorite-list-chips",
  templateUrl: "./favorite-list-chips.component.html",
  styleUrl: "./favorite-list-chips.component.css",
})
export class FavoriteListChipsComponent {
  @Input() lists: FavoriteList[] = [];
  /// The selected list; undefined for the favorites.
  @Input() selected?: number;
  /// The own order is shown: tell how to rearrange it.
  @Input() reorderHint = false;
  @Output() selectList = new EventEmitter<number | undefined>();
  @Output() createList = new EventEmitter<void>();

  constructor(
    private memory: MemoryService,
    private favoriteLists: FavoriteListsService,
  ) {}

  trackByList(_: number, list: FavoriteList) {
    return list.id;
  }

  /// The menus close on Escape themselves; the home page's arrow keys must
  /// not move the tile focus behind an open one (see HomeComponent.nav).
  menuOpened(trigger: MatMenuTrigger) {
    this.memory.currentContextMenu = trigger;
  }

  rename(list: FavoriteList) {
    void this.favoriteLists.promptRename(list);
  }

  delete(list: FavoriteList) {
    void this.favoriteLists.delete(list);
  }
}
