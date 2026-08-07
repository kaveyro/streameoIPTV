export enum SortType {
  alphabeticalAscending,
  alphabeticalDescending,
  provider,
}

export const SORT_TYPES = [
  SortType.alphabeticalAscending,
  SortType.alphabeticalDescending,
  SortType.provider,
];

export function getSortTypeText(sortType?: SortType): string {
  switch (sortType) {
    case SortType.alphabeticalAscending:
      return "SORT.ALPHABETICAL_ASC";
    case SortType.alphabeticalDescending:
      return "SORT.ALPHABETICAL_DESC";
    case SortType.provider:
      return "SORT.PROVIDER";
  }
  return "";
}
