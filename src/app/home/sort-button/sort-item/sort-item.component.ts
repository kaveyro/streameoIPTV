import { Component, Input } from "@angular/core";
import { SortType, getSortTypeText } from "../../../models/sortType";
import { MemoryService } from "../../../memory.service";

@Component({
  selector: "app-sort-item",
  standalone: false,
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
