import { MediaType } from "./mediaType";
import { SortType } from "./sortType";
import { ViewMode } from "./viewMode";

export class Filters {
  public query?: string;
  public source_ids!: number[];
  public media_types!: MediaType[];
  public view_type!: ViewMode;
  public page!: number;
  public group_id?: number;
  public series_id?: number;
  public use_keywords!: boolean;
  public sort?: SortType;
  public season?: number;
  /// Include groups locked by the parental PIN; always MemoryService.ShowLocked.
  public show_locked?: boolean;
  /// Only names with this country prefix ("TR"); undefined for all.
  public country?: string;
  /// Favorites view only: show this favorites list instead of the favorites
  /// (with SortType.custom in the list's own order).
  public favorite_list?: number;
}
