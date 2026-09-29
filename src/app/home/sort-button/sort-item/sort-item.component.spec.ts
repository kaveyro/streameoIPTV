import { ComponentFixture, TestBed } from "@angular/core/testing";

import { SortItemComponent } from "./sort-item.component";
import { MemoryService } from "../../../memory.service";
import { SortType } from "../../../models/sortType";
import { TEST_IMPORTS, mockTauri, resetTauri } from "../../../../testing/test-helpers";

describe("SortItemComponent", () => {
  let component: SortItemComponent;
  let fixture: ComponentFixture<SortItemComponent>;

  beforeEach(async () => {
    mockTauri();
    await TestBed.configureTestingModule({
      declarations: [SortItemComponent],
      imports: TEST_IMPORTS,
    }).compileComponents();

    fixture = TestBed.createComponent(SortItemComponent);
    component = fixture.componentInstance;
    component.sortType = SortType.alphabeticalDescending;
    fixture.detectChanges();
  });

  afterEach(() => resetTauri());

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("publishes its sort and asks for a reload", () => {
    component.notifySortChange();
    expect(TestBed.inject(MemoryService).Sort.value).toEqual([
      SortType.alphabeticalDescending,
      true,
    ]);
  });
});
