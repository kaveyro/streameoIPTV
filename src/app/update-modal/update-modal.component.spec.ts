import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  activeModalStub,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";
import { UpdateModalComponent } from "./update-modal.component";
import { ErrorService } from "../error.service";

describe("UpdateModalComponent", () => {
  let component: UpdateModalComponent;
  let fixture: ComponentFixture<UpdateModalComponent>;
  let element: HTMLElement;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;
  let calls: IpcCall[];

  async function create(pending: unknown = 0) {
    calls = mockTauri({ pending_work_count: pending });
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [UpdateModalComponent],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();
    fixture = TestBed.createComponent(UpdateModalComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.version = "2.0.0";
    component.currentVersion = "1.0.0";
    fixture.detectChanges();
  }

  function buttons(): string[] {
    return Array.from(element.querySelectorAll(".modal-footer button")).map(
      (b) => b.textContent?.trim() ?? "",
    );
  }

  function click(text: string) {
    Array.from(element.querySelectorAll<HTMLButtonElement>(".modal-footer button"))
      .find((b) => b.textContent?.trim() === text)!
      .click();
  }

  afterEach(() => resetTauri());

  it("installs right away when nothing is pending", async () => {
    await create(0);
    const install = jasmine.createSpy("install").and.resolveTo();
    component.install = install;
    click("UPDATE.INSTALL");
    await settle();
    expect(callsOf(calls, "pending_work_count").length).toBe(1);
    expect(install).toHaveBeenCalled();
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it("warns about running recordings and downloads before installing", async () => {
    await create(3);
    const install = jasmine.createSpy("install").and.resolveTo();
    component.install = install;
    click("UPDATE.INSTALL");
    await settle();
    fixture.detectChanges();
    expect(component.state).toBe("warn");
    expect(install).not.toHaveBeenCalled();
    expect(element.querySelector(".update-warning")?.textContent).toContain("UPDATE.PENDING_WORK");
    // Later left, the main action right; nothing red.
    expect(buttons()).toEqual(["UPDATE.LATER", "UPDATE.INSTALL_ANYWAY"]);
    expect(element.querySelector(".modal-footer .btn-danger")).toBeNull();
    click("UPDATE.INSTALL_ANYWAY");
    await settle();
    expect(install).toHaveBeenCalled();
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it("closes without installing on Later", async () => {
    await create(2);
    component.install = jasmine.createSpy("install").and.resolveTo();
    click("UPDATE.INSTALL");
    await settle();
    fixture.detectChanges();
    click("UPDATE.LATER");
    expect(activeModal.close).toHaveBeenCalledWith(false);
    expect(component.install).not.toHaveBeenCalled();
  });

  it("counts as nothing pending when the backend cannot tell", async () => {
    await create(() => {
      throw "unknown command";
    });
    const install = jasmine.createSpy("install").and.resolveTo();
    component.install = install;
    await component.requestInstall();
    expect(install).toHaveBeenCalled();
  });

  it("shows the download progress, indeterminate while the size is unknown", async () => {
    await create(0);
    let report!: (event: DownloadEvent) => void;
    let finish!: () => void;
    component.install = (onEvent) => {
      report = onEvent;
      return new Promise<void>((resolve) => (finish = resolve));
    };
    void component.requestInstall();
    await settle();
    fixture.detectChanges();
    expect(component.state).toBe("installing");
    expect(element.querySelector(".modal-footer")).toBeNull();
    const bar = () => element.querySelector<HTMLElement>(".update-progress .progress-bar")!;
    report({ event: "Started", data: {} });
    fixture.detectChanges();
    expect(component.percent).toBeUndefined();
    expect(bar().classList).toContain("progress-bar-animated");
    expect(bar().getAttribute("aria-valuenow")).toBeNull();
    report({ event: "Started", data: { contentLength: 1000 } });
    report({ event: "Progress", data: { chunkLength: 250 } });
    fixture.detectChanges();
    expect(component.percent).toBe(25);
    expect(bar().style.width).toBe("25%");
    expect(bar().getAttribute("aria-valuenow")).toBe("25");
    expect(element.textContent).toContain("25%");
    report({ event: "Finished" });
    expect(component.percent).toBe(100);
    finish();
    await settle();
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it("reports a failed install and closes without relaunch", async () => {
    await create(0);
    const error = spyOn(TestBed.inject(ErrorService), "handleError");
    component.install = () => Promise.reject("signature mismatch");
    await component.requestInstall();
    expect(error).toHaveBeenCalledWith("signature mismatch", "TOAST.UPDATE_INSTALL_FAILED");
    expect(activeModal.close).toHaveBeenCalledWith(false);
  });
});
