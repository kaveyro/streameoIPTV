import { ComponentFixture, TestBed } from "@angular/core/testing";

import { SortButtonComponent } from "./sort-button.component";
import { TEST_IMPORTS, mockTauri, resetTauri } from "../../../testing/test-helpers";
import { SortType } from "../../models/sortType";

describe("SortButtonComponent", () => {
  let component: SortButtonComponent;
  let fixture: ComponentFixture<SortButtonComponent>;

  beforeEach(async () => {
    mockTauri();
    await TestBed.configureTestingModule({
      imports: [...TEST_IMPORTS, SortButtonComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SortButtonComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("opens the sort menu at the pointer", () => {
    const open = spyOn(component.matMenuTrigger, "openMenu");
    const event = new MouseEvent("click", { clientX: 40, clientY: 60 });
    component.click(event);
    expect(component.menuTopLeftPosition).toEqual({ x: 40, y: 60 });
    expect(open).toHaveBeenCalled();
  });

  it("offers the own order only in the favorites view", () => {
    expect(component.sortTypes).not.toContain(SortType.custom);
    expect(component.sortTypes).toContain(SortType.number);
    component.favorites = true;
    expect(component.sortTypes).toContain(SortType.custom);
  });
});
