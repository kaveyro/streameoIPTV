import { Component, Input, ViewChild } from "@angular/core";
import { MemoryService } from "../../memory.service";
import { MatMenuTrigger } from "@angular/material/menu";
import { SORT_TYPES, SortType } from "../../models/sortType";

@Component({
  selector: "app-sort-button",
  templateUrl: "./sort-button.component.html",
  styleUrl: "./sort-button.component.css",
})
export class SortButtonComponent {
  constructor(private memory: MemoryService) {}
  menuTopLeftPosition = { x: 0, y: 0 };
  sortTypes = SORT_TYPES;
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;

  click(event: Event) {
    event.preventDefault();
    if (event instanceof MouseEvent && event.clientX !== 0) {
      this.menuTopLeftPosition.x = event.clientX;
      this.menuTopLeftPosition.y = event.clientY;
    } else {
      const rect = (event.target as HTMLElement)?.getBoundingClientRect();
      if (rect) {
        this.menuTopLeftPosition.x = rect.left;
        this.menuTopLeftPosition.y = rect.bottom;
      }
    }
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    this.matMenuTrigger.openMenu();
  }
}
