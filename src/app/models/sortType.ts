export enum SortType {
  alphabeticalAscending,
  alphabeticalDescending,
  provider,
  /// The user's own order. Only the favorites (and favorites lists) have one;
  /// elsewhere the backend falls back to the provider order.
  custom,
  /// By channel number; channels without one come last.
  number,
}

export const SORT_TYPES = [
  SortType.alphabeticalAscending,
  SortType.alphabeticalDescending,
  SortType.provider,
  SortType.number,
  SortType.custom,
];

export function getSortTypeText(sortType?: SortType): string {
  switch (sortType) {
    case SortType.alphabeticalAscending:
      return "SORT.ALPHABETICAL_ASC";
    case SortType.alphabeticalDescending:
      return "SORT.ALPHABETICAL_DESC";
    case SortType.provider:
      return "SORT.PROVIDER";
    case SortType.custom:
      return "SORT.CUSTOM";
    case SortType.number:
      return "SORT.NUMBER";
  }
  return "";
}
