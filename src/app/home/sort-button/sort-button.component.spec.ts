import { ComponentFixture, TestBed } from "@angular/core/testing";

import { SortButtonComponent } from "./sort-button.component";
import { SortItemComponent } from "./sort-item/sort-item.component";
import { TEST_IMPORTS, mockTauri, resetTauri } from "../../../testing/test-helpers";

describe("SortButtonComponent", () => {
  let component: SortButtonComponent;
  let fixture: ComponentFixture<SortButtonComponent>;

  beforeEach(async () => {
    mockTauri();
    await TestBed.configureTestingModule({
      declarations: [SortButtonComponent, SortItemComponent],
      imports: TEST_IMPORTS,
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
});
