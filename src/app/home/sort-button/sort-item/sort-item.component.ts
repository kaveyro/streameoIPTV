import { Component, Input } from "@angular/core";
import { SortType, getSortTypeText } from "../../../models/sortType";
import { MemoryService } from "../../../memory.service";
import { CommonModule } from "@angular/common";
import { TranslatePipe } from "@ngx-translate/core";
import { MatMenuModule } from "@angular/material/menu";

@Component({
  selector: "app-sort-item",
  imports: [CommonModule, TranslatePipe, MatMenuModule],
  templateUrl: "./sort-item.component.html",
  styleUrl: "./sort-item.component.css",
})
export class SortItemComponent {
  constructor(public memory: MemoryService) {}

  @Input()
  sortType?: SortType;
  /// Outside the favorites the own order falls back to the provider's.
  @Input() favorites = false;

  isSelected(): boolean {
    const current = this.memory.Sort.getValue()[0];
    if (current === this.sortType) return true;
    return !this.favorites && current === SortType.custom && this.sortType === SortType.provider;
  }

  getText(): string {
    return getSortTypeText(this.sortType);
  }

  notifySortChange() {
    this.memory.Sort.next([this.sortType!, true]);
  }
}
