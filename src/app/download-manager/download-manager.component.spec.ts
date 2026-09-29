import { ComponentFixture, TestBed } from "@angular/core/testing";
import { TranslatePipe, provideTranslateService } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";

import { DownloadManagerComponent } from "./download-manager.component";

describe("DownloadManagerComponent", () => {
  let component: DownloadManagerComponent;
  let fixture: ComponentFixture<DownloadManagerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [DownloadManagerComponent],
      imports: [TranslatePipe, ToastrModule.forRoot()],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(DownloadManagerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });
});
