import { ComponentFixture, TestBed } from "@angular/core/testing";

import { GuideEpgCache, TvGuideComponent } from "./tv-guide.component";
import { MemoryService } from "../memory.service";
import { PlaybackService } from "../playback.service";
import { Channel } from "../models/channel";
import { EPG } from "../models/epg";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { ProgrammeHit } from "../models/epgExtras";
import { CountryNamePipe } from "../pipes/country-name.pipe";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../../testing/test-helpers";

describe("TvGuideComponent", () => {
  let component: TvGuideComponent;
  let fixture: ComponentFixture<TvGuideComponent>;
  let element: HTMLElement;
  let calls: IpcCall[];

  const now = Math.floor(Date.now() / 1000);
  const channels: Channel[] = [
    { id: 1, name: "One", media_type: MediaType.livestream, favorite: false, source_id: 1 },
    { id: 2, name: "Two", media_type: MediaType.livestream, favorite: false, source_id: 1 },
  ];
  const programme = (title: string, start: number, end: number, archive = false): EPG => ({
    epg_id: title,
    title,
    description: `About ${title}`,
    start_time: "",
    start_timestamp: start,
    end_time: "",
    end_timestamp: end,
    has_archive: archive,
    now_playing: start <= now && now < end,
    timeshift_url: archive ? `http://example.test/${title}.ts` : undefined,
  });
  const epg: EPG[] = [
    programme("Past", now - 3000, now - 600, true),
    programme("Now", now - 600, now + 1200),
    programme("Later", now + 1200, now + 4800),
    programme("Far future", now + 3 * 24 * 3600, now + 3 * 24 * 3600 + 60),
  ];

  async function create(
    handlers: Record<string, unknown> = {},
    group?: { id: number; name: string },
  ) {
    calls = mockTauri({
      search: channels,
      get_epg: (args: Record<string, unknown>) =>
        (args["channel"] as Channel).id === 1 ? epg : [],
      ...handlers,
    });
    await TestBed.configureTestingModule({
      declarations: [TvGuideComponent, CountryNamePipe],
      imports: TEST_IMPORTS,
      providers: TEST_PROVIDERS,
    }).compileComponents();
    TestBed.inject(GuideEpgCache).entries.clear();
    TestBed.inject(MemoryService).Sources = new Map([[1, { id: 1, name: "Main" }]]);
    fixture = TestBed.createComponent(TvGuideComponent);
    component = fixture.componentInstance;
    component.group = group;
    element = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  afterEach(() => resetTauri());

  it("spans now - 1 h to now + 6 h in 30 minute slots", async () => {
    await create();
    expect(component.windowStart).toBeLessThanOrEqual(now - 3600);
    expect(component.windowStart % TvGuideComponent.SLOT_SECONDS).toBe(0);
    expect(component.windowEnd).toBeGreaterThanOrEqual(now + 6 * 3600);
    expect(element.querySelectorAll(".guide-slot").length).toBe(component.slots.length);
    expect(element.querySelector(".guide-now-line")).not.toBeNull();
  });

  it("lists the live channels of the enabled sources, respecting the parental flag", async () => {
    await create();
    const filters = callsOf(calls, "search")[0].args["filters"] as Filters;
    expect(filters.media_types).toEqual([MediaType.livestream]);
    expect(filters.source_ids).toEqual([1]);
    expect(filters.page).toBe(1);
    expect(filters.show_locked).toBeFalse();
    expect(element.querySelectorAll(".guide-row").length).toBe(2);
  });

  it("restricts the rows to the selected group", async () => {
    await create({}, { id: 42, name: "Sports" });
    const filters = callsOf(calls, "search")[0].args["filters"] as Filters;
    expect(filters.group_id).toBe(42);
    expect(element.querySelector(".guide-group")?.textContent).toContain("Sports");
  });

  it("lays out the programmes of a row inside the window and caches them", async () => {
    await create();
    const row = component.rows[0];
    component.request(row);
    await settle();
    fixture.detectChanges();
    expect(row.blocks.map((b) => b.epg.title)).toEqual(["Past", "Now", "Later"]);
    expect(row.blocks.map((b) => b.state)).toEqual(["past", "now", "future"]);
    const [past, current] = row.blocks;
    expect(current.offset).toBeCloseTo(past.offset + past.width, 0);
    expect(row.blocks[1].tooltip).toContain("About Now");
    expect(TestBed.inject(GuideEpgCache).entries.get(1)?.length).toBe(4);

    const second = component.rows[1];
    component.request(second);
    await settle();
    fixture.detectChanges();
    expect(second.blocks.length).toBe(0);
    expect(element.querySelectorAll(".guide-row")[1].textContent).toContain("GUIDE.NO_EPG");
  });

  it("keeps at most four EPG requests in flight", async () => {
    const many: Channel[] = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      name: `C${i}`,
      media_type: MediaType.livestream,
      favorite: false,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    await create({
      search: many,
      get_epg: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve([]);
          }, 5),
        );
      },
    });
    component.rows.forEach((row) => component.request(row));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(maxInFlight).toBe(TvGuideComponent.MAX_IN_FLIGHT);
    // Rows the viewport observer dropped from the queue (scrolled away) are
    // fetched once they are visible again; nothing is left hanging.
    expect(component.rows.every((r) => r.state === "done" || r.state === "idle")).toBeTrue();
    expect(component.rows.some((r) => r.state === "done")).toBeTrue();
  });

  it("plays the channel for the current programme and catch-up for a past one", async () => {
    await create();
    const row = component.rows[0];
    component.request(row);
    await settle();
    const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
    await component.activate(row, row.blocks[1]);
    expect(play).toHaveBeenCalledOnceWith(row.channel);
    expect(callsOf(calls, "add_last_watched").map((c) => c.args)).toEqual([{ id: 1 }]);

    await component.activate(row, row.blocks[0]);
    const catchup = callsOf(calls, "play");
    expect(catchup.length).toBe(1);
    expect(catchup[0].args["channel"]).toEqual(
      jasmine.objectContaining({ id: -1, url: "http://example.test/Past.ts", source_id: 1 }),
    );
  });

  it("schedules a recording of a future programme", async () => {
    await create();
    const row = component.rows[0];
    component.request(row);
    await settle();
    component.menuRow = row;
    component.menuBlock = row.blocks[2];
    await component.toggleRecording();
    expect(callsOf(calls, "schedule_recording").map((c) => c.args)).toEqual([
      {
        channelId: 1,
        title: "Later",
        startTimestamp: now + 1200,
        endTimestamp: now + 4800,
      },
    ]);
  });

  it("moves between programmes with the arrow keys", async () => {
    await create();
    const row = component.rows[0];
    component.request(row);
    component.request(component.rows[1]);
    await settle();
    fixture.detectChanges();
    const key = (k: string) =>
      component.onKeyDown(new KeyboardEvent("keydown", { key: k, cancelable: true }));
    key("ArrowRight");
    expect([component.activeRow, component.activeCol]).toEqual([0, 1]);
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight"); // stays on the last block
    expect(component.activeCol).toBe(3);
    key("ArrowDown"); // the second row has no programmes: its channel cell
    expect([component.activeRow, component.activeCol]).toEqual([1, 0]);
    key("ArrowUp");
    key("End");
    expect([component.activeRow, component.activeCol]).toEqual([0, 3]);
    key("Home");
    expect(component.activeCol).toBe(0);
    await settle();
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe(component.cellId(0, 0));
  });

  it("shows the country prefix as a pill in badge mode", async () => {
    await create({ search: [{ ...channels[0], name: "TR: Kanal D" }] });
    const memory = TestBed.inject(MemoryService);
    const label = () => element.querySelector(".guide-channel") as HTMLElement;
    expect(label().textContent?.trim()).toBe("TR: Kanal D");
    memory.CountryPrefixMode = "badge";
    fixture.detectChanges();
    expect(label().querySelector(".guide-country")?.textContent?.trim()).toBe("TR");
    expect(label().textContent).not.toContain("TR:");
    memory.CountryPrefixMode = "hide";
    fixture.detectChanges();
    expect(label().querySelector(".guide-country")).toBeNull();
    expect(label().textContent?.trim()).toBe("Kanal D");
  });

  describe("programme search", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const debounce = TvGuideComponent.SEARCH_DEBOUNCE_MS + 30;
    const at = (daysAhead: number, hour: number) => {
      const date = new Date();
      date.setDate(date.getDate() + daysAhead);
      date.setHours(hour, 0, 0, 0);
      return Math.floor(date.getTime() / 1000);
    };
    const hit = (title: string, start: number, end: number, channel = channels[0]) =>
      ({
        channel,
        epg_id: `id-${title}`,
        title,
        description: `About ${title}`,
        start_timestamp: start,
        end_timestamp: end,
      }) as ProgrammeHit;
    const hits: ProgrammeHit[] = [
      hit("Tatort live", now - 600, now + 1200),
      hit("Tatort", at(1, 12), at(1, 13), channels[1]),
      hit("Tatort classic", at(3, 12), at(3, 13)),
    ];
    const input = () => element.querySelector(".guide-search") as HTMLInputElement;
    async function type(query: string) {
      input().value = query;
      input().dispatchEvent(new Event("input"));
      await wait(debounce);
      await settle();
      fixture.detectChanges();
    }

    it("searches after a pause and replaces the grid until Escape clears it", async () => {
      await create({ search_programmes: hits });
      await type("Tatort");
      expect(callsOf(calls, "search_programmes").map((c) => c.args)).toEqual([
        { query: "Tatort", showLocked: false },
      ]);
      const scroller = element.querySelector(".guide-scroller") as HTMLElement;
      expect(scroller.hidden).toBeTrue();
      const days = Array.from(element.querySelectorAll(".guide-day-title")).map((d) =>
        d.textContent?.trim(),
      );
      expect(days.slice(0, 2)).toEqual(["GUIDE.TODAY", "GUIDE.TOMORROW"]);
      expect(days[2]).not.toContain("GUIDE.");
      const items = element.querySelectorAll(".guide-hit");
      expect(items.length).toBe(3);
      expect(items[0].classList).toContain("is-now");
      expect(items[0].querySelector(".guide-hit-progress")).not.toBeNull();
      expect(items[1].textContent).toContain("Two");
      expect(items[1].textContent).toContain("About Tatort");

      const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      input().dispatchEvent(escape);
      fixture.detectChanges();
      // ngModel writes the emptied value to the field asynchronously.
      await settle();
      // Handled here: the home page must not navigate back as well.
      expect(escape.defaultPrevented).toBeTrue();
      expect(input().value).toBe("");
      expect(element.querySelector(".guide-results")).toBeNull();
      expect(scroller.hidden).toBeFalse();
      expect(element.querySelectorAll(".guide-row").length).toBe(2);
      expect(callsOf(calls, "search").length).toBe(1);
    });

    it("needs two characters and drops the answers to older queries", async () => {
      await create({
        search_programmes: (args: Record<string, unknown>) =>
          args["query"] === "Ta"
            ? new Promise((resolve) => setTimeout(() => resolve([hits[2]]), 600))
            : [hits[1]],
      });
      await type("T");
      expect(callsOf(calls, "search_programmes").length).toBe(0);
      expect(element.querySelector(".guide-results")).toBeNull();

      await type("Ta"); // its answer is still pending when the next query runs
      await type("Tat");
      await wait(450);
      await settle();
      fixture.detectChanges();
      expect(callsOf(calls, "search_programmes").map((c) => c.args["query"])).toEqual([
        "Ta",
        "Tat",
      ]);
      expect(component.searchResults).toEqual([hits[1]]);
      expect(element.querySelectorAll(".guide-hit").length).toBe(1);
    });

    it("watches a running hit, and reminds of and records an upcoming one", async () => {
      await create({ search_programmes: hits });
      TestBed.inject(MemoryService).trayEnabled = true;
      const play = spyOn(TestBed.inject(PlaybackService), "play").and.resolveTo();
      await type("Tatort");
      const items = element.querySelectorAll(".guide-hit");
      const buttons = (i: number) =>
        Array.from(items[i].querySelectorAll<HTMLButtonElement>(".guide-hit-actions button"));
      expect(buttons(0).length).toBe(1);
      expect(buttons(0)[0].getAttribute("aria-label")).toBe("GUIDE.WATCH: Tatort live");
      buttons(0)[0].click();
      await settle();
      expect(play).toHaveBeenCalledOnceWith(channels[0]);

      const [remind, record] = buttons(1);
      expect(remind.getAttribute("aria-pressed")).toBe("false");
      remind.click();
      await settle();
      expect(callsOf(calls, "add_epg").map((c) => c.args["epg"])).toEqual([
        {
          channel_name: "Two",
          epg_id: "id-Tatort",
          start_timestamp: at(1, 12),
          title: "Tatort",
        },
      ]);
      record.click();
      await settle();
      expect(callsOf(calls, "schedule_recording").map((c) => c.args)).toEqual([
        { channelId: 2, title: "Tatort", startTimestamp: at(1, 12), endTimestamp: at(1, 13) },
      ]);
    });

    it("explains an empty result and that it needs external EPG sources", async () => {
      await create({ search_programmes: [] });
      const memory = TestBed.inject(MemoryService);
      memory.HasXmltv = false;
      await type("Nothing");
      const results = () => element.querySelector(".guide-results")?.textContent ?? "";
      expect(results()).toContain("GUIDE.SEARCH_NO_RESULTS");
      expect(results()).toContain("GUIDE.SEARCH_NEEDS_XMLTV");
      memory.HasXmltv = true;
      fixture.detectChanges();
      expect(results()).toContain("GUIDE.SEARCH_SCOPE");
      expect(results()).not.toContain("GUIDE.SEARCH_NEEDS_XMLTV");
    });
  });
});
