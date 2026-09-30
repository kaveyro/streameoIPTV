import { ComponentFixture, TestBed } from "@angular/core/testing";
import { FavoriteListChipsComponent } from "./favorite-list-chips.component";
import { FavoriteListsService } from "../favorite-lists.service";
import { TEST_IMPORTS, TEST_PROVIDERS, mockTauri, resetTauri } from "../../../testing/test-helpers";

describe("FavoriteListChipsComponent", () => {
  let component: FavoriteListChipsComponent;
  let fixture: ComponentFixture<FavoriteListChipsComponent>;
  let element: HTMLElement;
  const sport = { id: 4, name: "Sport", position: 1, count: 2 };

  beforeEach(async () => {
    mockTauri();
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, FavoriteListChipsComponent],
      providers: TEST_PROVIDERS,
    }).compileComponents();
    fixture = TestBed.createComponent(FavoriteListChipsComponent);
    component = fixture.componentInstance;
    element = fixture.nativeElement;
    component.lists = [sport];
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  function chips(): HTMLButtonElement[] {
    return Array.from(element.querySelectorAll("button.list-chip"));
  }

  it("shows the favorites, the lists with their counts and 'new list'", () => {
    expect(chips().map((c) => c.textContent?.trim())).toEqual([
      "HOME.NAV.FAVORITES",
      "Sport2",
      "FAV_LISTS.NEW_LIST",
    ]);
    expect(element.querySelector(".chip-count")?.textContent).toBe("2");
    expect(chips()[1].getAttribute("aria-label")).toBe("FAV_LISTS.CHIP_LABEL");
    expect(chips()[0].getAttribute("aria-pressed")).toBe("true");
    expect(element.querySelector(".list-chip-menu")?.getAttribute("aria-label")).toBe(
      "FAV_LISTS.LIST_OPTIONS",
    );
  });

  it("marks the selected list", () => {
    component.selected = 4;
    fixture.detectChanges();
    expect(chips()[0].getAttribute("aria-pressed")).toBe("false");
    expect(chips()[1].getAttribute("aria-pressed")).toBe("true");
    expect(element.querySelector(".list-chip-group")?.classList).toContain("active");
  });

  it("reports the chosen chip and 'new list'", () => {
    const selected: (number | undefined)[] = [];
    component.selectList.subscribe((id) => selected.push(id));
    let created = 0;
    component.createList.subscribe(() => created++);
    chips()[1].click();
    chips()[0].click();
    chips()[2].click();
    expect(selected).toEqual([4, undefined]);
    expect(created).toBe(1);
  });

  it("renames and deletes through the service", () => {
    const service = TestBed.inject(FavoriteListsService);
    const rename = spyOn(service, "promptRename").and.resolveTo(true);
    const remove = spyOn(service, "delete").and.resolveTo(true);
    component.rename(sport);
    component.delete(sport);
    expect(rename).toHaveBeenCalledWith(sport);
    expect(remove).toHaveBeenCalledWith(sport);
  });

  it("shows the reorder hint in the own order", () => {
    expect(element.querySelector(".reorder-hint")).toBeNull();
    component.reorderHint = true;
    fixture.detectChanges();
    expect(element.querySelector(".reorder-hint")).not.toBeNull();
  });
});
