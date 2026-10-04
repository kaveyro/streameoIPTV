import { TestBed } from "@angular/core/testing";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { UpdateService } from "./update.service";
import { UpdateModalComponent } from "./update-modal/update-modal.component";
import {
  TEST_IMPORTS,
  TEST_PROVIDERS,
  mockTauri,
  resetTauri,
  settle,
} from "../testing/test-helpers";

describe("UpdateService", () => {
  const available = {
    rid: 1,
    currentVersion: "1.0.0",
    version: "2.0.0",
    date: null,
    body: "",
    rawJson: {},
  };

  function setup(update: unknown) {
    mockTauri({ "plugin:updater|check": update });
    TestBed.configureTestingModule({
      declarations: [UpdateModalComponent],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    });
    return TestBed.inject(UpdateService);
  }

  afterEach(() => resetTauri());

  it("is busy but no longer checking while the dialog is open, idle afterwards", async () => {
    const service = setup(available);
    const modal = TestBed.inject(NgbModal);
    const done = service.check(true);
    expect(service.Checking).toBeTrue();
    await settle();
    expect(modal.hasOpenModals()).toBeTrue();
    expect(service.Busy).toBeTrue();
    expect(service.Checking).toBeFalse();
    modal.dismissAll();
    await done;
    expect(service.Busy).toBeFalse();
    expect(service.Checking).toBeFalse();
  });

  it("hands the dialog an installer for the offered update", async () => {
    const service = setup(available);
    const modal = TestBed.inject(NgbModal);
    const open = spyOn(modal, "open").and.callThrough();
    const done = service.check(false);
    await settle();
    const instance = open.calls.mostRecent().returnValue.componentInstance as UpdateModalComponent;
    expect(instance.version).toBe("2.0.0");
    expect(typeof instance.install).toBe("function");
    modal.dismissAll();
    await done;
  });

  it("is idle again when there is nothing to install", async () => {
    const service = setup(null);
    await service.check(true);
    expect(service.Busy).toBeFalse();
    expect(service.Checking).toBeFalse();
  });
});
