import { Component, Input, OnDestroy, OnInit } from "@angular/core";

@Component({
  selector: "app-loading",
  standalone: false,
  templateUrl: "./loading.component.html",
  styleUrl: "./loading.component.css",
})
export class LoadingComponent implements OnInit, OnDestroy {
  @Input()
  center: boolean = false;
  count = 0;
  /// Translation keys, rotated every few seconds.
  texts: string[] = ["LOADING.CHANNELS"];

  currentText: string = "";
  private interval?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.displayRandomText();
    if (this.texts.length > 1) {
      this.interval = setInterval(() => this.displayRandomText(), 3500);
    }
  }

  displayRandomText() {
    if (this.count == this.texts.length) this.count = 0;
    this.currentText = this.texts[this.count++];
  }

  ngOnDestroy() {
    if (this.interval !== undefined) clearInterval(this.interval);
  }
}
