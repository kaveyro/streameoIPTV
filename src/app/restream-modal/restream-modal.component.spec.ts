import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import {
  IpcCall,
  SHARED_DECLARATIONS,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  activeModalStub,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

import { RestreamModalComponent } from "./restream-modal.component";
import { RestreamService } from "../restream.service";

describe("RestreamModalComponent", () => {
  let component: RestreamModalComponent;
  let fixture: ComponentFixture<RestreamModalComponent>;
  let element: HTMLElement;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;
  let calls: IpcCall[];
  let restream: RestreamService;
  const channel = { id: 1, name: "News", media_type: 0, favorite: false };

  beforeEach(async () => {
    calls = mockTauri({
      start_restream: () => new Promise<void>(() => undefined),
      restream_url: ({ port }: Record<string, unknown>) =>
        `http://127.0.0.1:${port}/abc/stream.m3u8`,
    });
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [RestreamModalComponent, ...SHARED_DECLARATIONS],
      imports: TEST_IMPORTS,
      providers: [...TEST_PROVIDERS, { provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();

    restream = TestBed.inject(RestreamService);
    fixture = TestBed.createComponent(RestreamModalComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.channel = channel;
    fixture.detectChanges();
    await settle();
  });

  afterEach(() => resetTauri());

  function runRestream() {
    restream.state = "running";
    restream.channel = channel;
    restream.port = 3000;
    fixture.detectChanges();
  }

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("preselects the first local IP", async () => {
    await fixture.whenStable();
    expect(component.selectedIP).toBe("192.168.1.2");
  });

  it("starts through the restream service without waiting for its end", async () => {
    const start = spyOn(restream, "start").and.callThrough();
    component.start();
    expect(start).toHaveBeenCalledWith(channel, 3000);
    expect(restream.state).toBe("starting");
    fixture.detectChanges();
    expect(element.textContent).toContain("RESTREAM.STARTING");
    // Closable while it starts or runs: "Hide" keeps it going.
    const hide = element.querySelector<HTMLButtonElement>(".modal-footer .btn-secondary")!;
    expect(hide.textContent?.trim()).toBe("RESTREAM.HIDE");
    hide.click();
    expect(activeModal.close).toHaveBeenCalledWith("hide");
    expect(callsOf(calls, "stop_restream").length).toBe(0);
  });

  it("lists the addresses with copy buttons and a proper IP select", async () => {
    runRestream();
    expect(element.querySelector("br")).toBeNull();
    const urls = Array.from(element.querySelectorAll(".restream-url")).map((e) =>
      e.textContent?.trim(),
    );
    expect(urls).toEqual([
      "http://192.168.1.2:3000/abc/stream.m3u8",
      "http://203.0.113.1:3000/abc/stream.m3u8",
    ]);
    expect(element.querySelector("#ip-select")?.classList).toContain("form-select");
    element.querySelector<HTMLButtonElement>(".restream-copy")!.click();
    await settle();
    const copy = calls.find((c) => c.cmd.startsWith("plugin:clipboard-manager|write"));
    expect(copy?.args["text"]).toBe("http://192.168.1.2:3000/abc/stream.m3u8");
  });

  it("watches in the embedded player and hides the dialog", async () => {
    runRestream();
    const watch = spyOn(restream, "watch").and.resolveTo();
    await component.watch();
    expect(watch).toHaveBeenCalled();
    expect(activeModal.close).toHaveBeenCalledWith("hide");
  });

  it("stops through the restream service", async () => {
    runRestream();
    const stop = spyOn(restream, "stop").and.resolveTo();
    const button = Array.from(element.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "RESTREAM.STOP",
    )!;
    button.click();
    expect(stop).toHaveBeenCalled();
  });
});
