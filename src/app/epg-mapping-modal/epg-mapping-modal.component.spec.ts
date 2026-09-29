import { ComponentFixture, TestBed } from "@angular/core/testing";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";

import { EpgMappingModalComponent } from "./epg-mapping-modal.component";
import { NowPlayingService } from "../now-playing.service";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { XmltvChannelHit } from "../models/epgExtras";
import {
  IpcCall,
  TEST_IMPORTS,
  activeModalStub,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("EpgMappingModalComponent", () => {
  let component: EpgMappingModalComponent;
  let fixture: ComponentFixture<EpgMappingModalComponent>;
  let activeModal: jasmine.SpyObj<NgbActiveModal>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const channel: Channel = {
    id: 7,
    name: "TR: Kanal D",
    media_type: MediaType.livestream,
    source_id: 1,
  };
  const hits: XmltvChannelHit[] = [
    { id: "KanalD.tr", programmes: 42, now_title: "Haberler" },
    { id: "KanalD.HD.tr", programmes: 0 },
  ];

  async function create(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({ search_xmltv_channels: hits, get_epg_mapping: null, ...handlers });
    activeModal = activeModalStub();
    await TestBed.configureTestingModule({
      declarations: [EpgMappingModalComponent],
      imports: TEST_IMPORTS,
      providers: [{ provide: NgbActiveModal, useValue: activeModal }],
    }).compileComponents();
    fixture = TestBed.createComponent(EpgMappingModalComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.channel = channel;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  function input(): HTMLInputElement {
    return element.querySelector("#epg-mapping-search") as HTMLInputElement;
  }

  function key(name: string) {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    fixture.detectChanges();
  }

  afterEach(() => resetTauri());

  it("searches for the name without its country prefix right away", async () => {
    await create();
    expect(component.query).toBe("Kanal D");
    expect(callsOf(calls, "search_xmltv_channels").map((c) => c.args)).toEqual([
      { query: "Kanal D" },
    ]);
    const options = element.querySelectorAll("[role=option]");
    expect(options.length).toBe(2);
    expect(options[0].textContent).toContain("KanalD.tr");
    expect(options[0].textContent).toContain("Haberler");
    expect(options[1].classList).toContain("muted");
    expect(options[1].textContent).toContain("EPG_MAPPING.NO_CURRENT");
  });

  it("shows the automatic state and disables 'assign automatically' then", async () => {
    await create();
    expect(element.querySelector(".mapping-state")?.textContent).toContain("EPG_MAPPING.AUTOMATIC");
    const auto = element.querySelector(".modal-footer .btn-outline-secondary") as HTMLButtonElement;
    expect(auto.disabled).toBeTrue();
  });

  it("shows a manual assignment and can remove it", async () => {
    await create({ get_epg_mapping: "KanalD.tr" });
    expect(element.querySelector(".mapping-state")?.textContent).toContain("KanalD.tr");
    expect(element.querySelector(".current-badge")).not.toBeNull();
    const invalidate = spyOn(TestBed.inject(NowPlayingService), "invalidate");
    await component.automatic();
    expect(callsOf(calls, "set_epg_mapping").map((c) => c.args)).toEqual([
      { channel, xmltvId: null },
    ]);
    expect(invalidate).toHaveBeenCalledWith(7);
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it("moves through the results with the arrow keys and assigns with Enter", async () => {
    await create();
    const invalidate = spyOn(TestBed.inject(NowPlayingService), "invalidate");
    expect(component.active).toBe(0);
    key("ArrowDown");
    expect(component.active).toBe(1);
    expect(input().getAttribute("aria-activedescendant")).toBe("epg-mapping-option-1");
    key("ArrowDown");
    expect(component.active).toBe(1);
    key("ArrowUp");
    expect(component.active).toBe(0);
    key("Enter");
    await settle();
    expect(callsOf(calls, "set_epg_mapping").map((c) => c.args)).toEqual([
      { channel, xmltvId: "KanalD.tr" },
    ]);
    expect(invalidate).toHaveBeenCalledWith(7);
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it("assigns a clicked result", async () => {
    await create();
    (element.querySelectorAll("[role=option]")[1] as HTMLElement).click();
    await settle();
    expect(callsOf(calls, "set_epg_mapping")[0].args["xmltvId"]).toBe("KanalD.HD.tr");
  });

  it("searches as you type, debounced", async () => {
    await create();
    input().value = "Show";
    input().dispatchEvent(new Event("input"));
    input().value = "Show TV";
    input().dispatchEvent(new Event("input"));
    expect(callsOf(calls, "search_xmltv_channels").length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    const searches = callsOf(calls, "search_xmltv_channels");
    expect(searches.length).toBe(2);
    expect(searches[1].args).toEqual({ query: "Show TV" });
  });

  it("says so when nothing matches", async () => {
    await create({ search_xmltv_channels: [] });
    expect(element.querySelector(".no-results")?.textContent).toContain("EPG_MAPPING.NO_RESULTS");
  });

  it("closes without changes on Escape", async () => {
    await create();
    key("Escape");
    expect(activeModal.close).toHaveBeenCalledWith(false);
    expect(callsOf(calls, "set_epg_mapping").length).toBe(0);
  });
});
