import { TestBed } from "@angular/core/testing";
import { NgbModal, NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { FavoriteListsService } from "./favorite-lists.service";
import { ConfirmService } from "../confirm.service";
import { MediaType } from "../models/mediaType";
import {
  IpcCall,
  TEST_IMPORTS,
  TEST_PROVIDERS,
  callsOf,
  mockTauri,
  resetTauri,
} from "../../testing/test-helpers";

describe("FavoriteListsService", () => {
  let service: FavoriteListsService;
  let calls: IpcCall[];
  const sport = { id: 4, name: "Sport", position: 1, count: 2 };
  const channel = { id: 3, name: "Kanal D", media_type: MediaType.livestream, source_id: 1 };

  function setup(handlers: Record<string, unknown> = {}) {
    calls = mockTauri({ get_favorite_lists: [sport], ...handlers });
    TestBed.configureTestingModule({ imports: TEST_IMPORTS, providers: TEST_PROVIDERS });
    service = TestBed.inject(FavoriteListsService);
  }

  /// The name dialog answers with `name` (null: cancelled).
  function answerName(name: string | null) {
    return spyOn(TestBed.inject(NgbModal), "open").and.returnValue({
      componentInstance: {},
      result: Promise.resolve(name),
    } as unknown as NgbModalRef);
  }

  afterEach(() => {
    resetTauri();
    sessionStorage.removeItem("favoriteListSelected");
  });

  it("is undefined until the lists loaded", async () => {
    setup();
    expect(service.lists.value).toBeUndefined();
    await service.load();
    expect(service.lists.value).toEqual([sport]);
  });

  it("remembers the selected list for the session", () => {
    setup();
    service.selected = 4;
    expect(sessionStorage.getItem("favoriteListSelected")).toBe("4");
    service.selected = undefined;
    expect(sessionStorage.getItem("favoriteListSelected")).toBeNull();
  });

  it("creates a list with the entered name", async () => {
    setup({ create_favorite_list: 7 });
    answerName("News");
    expect(await service.promptCreate()).toBe(7);
    expect(callsOf(calls, "create_favorite_list").map((c) => c.args)).toEqual([{ name: "News" }]);
    expect(callsOf(calls, "get_favorite_lists").length).toBe(1);
  });

  it("creates nothing when the dialog is cancelled", async () => {
    setup();
    answerName(null);
    expect(await service.promptCreate()).toBeUndefined();
    expect(callsOf(calls, "create_favorite_list").length).toBe(0);
  });

  it("renames a list", async () => {
    setup();
    answerName("Football");
    expect(await service.promptRename(sport)).toBeTrue();
    expect(callsOf(calls, "rename_favorite_list").map((c) => c.args)).toEqual([
      { id: 4, name: "Football" },
    ]);
  });

  it("deletes a list only after the confirmation", async () => {
    setup();
    const confirm = spyOn(TestBed.inject(ConfirmService), "confirm").and.resolveTo(false);
    expect(await service.delete(sport)).toBeFalse();
    expect(callsOf(calls, "delete_favorite_list").length).toBe(0);

    confirm.and.resolveTo(true);
    service.selected = 4;
    expect(await service.delete(sport)).toBeTrue();
    expect(callsOf(calls, "delete_favorite_list").map((c) => c.args)).toEqual([{ id: 4 }]);
    expect(service.selected).toBeUndefined();
  });

  it("adds and removes a channel", async () => {
    setup();
    expect(await service.setMember(sport, channel, true)).toBeTrue();
    expect(await service.setMember(sport, channel, false)).toBeTrue();
    expect(callsOf(calls, "add_to_favorite_list").map((c) => c.args)).toEqual([
      { listId: 4, channel },
    ]);
    expect(callsOf(calls, "remove_from_favorite_list").map((c) => c.args)).toEqual([
      { listId: 4, channel },
    ]);
  });

  it("reads the lists a channel is in", async () => {
    setup({ get_channel_favorite_lists: [4, 6] });
    expect(await service.membership(channel)).toEqual(new Set([4, 6]));
  });
});
