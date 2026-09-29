import { ComponentFixture, TestBed } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";

import { DownloadManagerComponent } from "./download-manager.component";
import { mockTauri, resetTauri } from "../../testing/test-helpers";

describe("DownloadManagerComponent", () => {
  let component: DownloadManagerComponent;
  let fixture: ComponentFixture<DownloadManagerComponent>;

  beforeEach(async () => {
    mockTauri();
    await TestBed.configureTestingModule({
      declarations: [DownloadManagerComponent],
      imports: [TranslateModule.forRoot(), ToastrModule.forRoot()],
    }).compileComponents();

    fixture = TestBed.createComponent(DownloadManagerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });
});
