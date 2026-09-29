import { TestBed } from "@angular/core/testing";

import { MemoryService } from "./memory.service";
import { TEST_IMPORTS, callsOf, mockTauri, resetTauri, settle } from "../testing/test-helpers";

describe("MemoryService", () => {
  let service: MemoryService;

  afterEach(() => resetTauri());

  function create(handlers: Record<string, unknown> = {}) {
    const calls = mockTauri(handlers);
    TestBed.configureTestingModule({ imports: TEST_IMPORTS });
    service = TestBed.inject(MemoryService);
    return calls;
  }

  it("should be created and ask whether it runs in a container", async () => {
    const calls = create({ is_container: true });
    await settle();
    expect(service).toBeTruthy();
    expect(callsOf(calls, "is_container").length).toBe(1);
    expect(service.IsContainer).toBeTrue();
  });

  it("does not show locked groups by default", () => {
    create();
    expect(service.ShowLocked).toBeFalse();
    expect(service.HasParentalPin).toBeFalse();
  });

  it("loads the parental PIN state and the locked groups", async () => {
    create({ has_parental_pin: true, get_locked_group_ids: [3, 9] });
    await service.refreshParental();
    expect(service.HasParentalPin).toBeTrue();
    expect(Array.from(service.LockedGroupIds)).toEqual([3, 9]);
  });

  it("stops showing locked groups once the PIN is gone", async () => {
    create({ has_parental_pin: false, get_locked_group_ids: [] });
    service.ShowLocked = true;
    await service.refreshParental();
    expect(service.ShowLocked).toBeFalse();
  });

  it("hides the native player while a dialog is open", async () => {
    const calls = create();
    service.PlayerVisible = true;
    let close!: () => void;
    const closed = new Promise<void>((resolve) => (close = resolve));
    const done = service.hidePlayerWhile(closed);
    await settle();
    expect(callsOf(calls, "player_set_visible").map((c) => c.args["visible"])).toEqual([false]);
    close();
    await done;
    expect(callsOf(calls, "player_set_visible").map((c) => c.args["visible"])).toEqual([
      false,
      true,
    ]);
  });
});
