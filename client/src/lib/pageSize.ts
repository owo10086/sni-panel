import { PAGE_SIZE_OPTIONS, type PageSize } from "@shared/pagination";

export function pageSizeStorageKey(pageStorageKey: string) {
  return pageStorageKey.endsWith(".page")
    ? `${pageStorageKey.slice(0, -5)}.pageSize`
    : `${pageStorageKey}.pageSize`;
}

export function parsePageSize(value: unknown, defaultPageSize: PageSize): PageSize {
  const size = Number(value);
  return PAGE_SIZE_OPTIONS.find((option) => option === size) ?? defaultPageSize;
}

export function readStoredPageSize(storageKey: string, defaultPageSize: PageSize): PageSize {
  try {
    return parsePageSize(window.localStorage.getItem(pageSizeStorageKey(storageKey)), defaultPageSize);
  } catch {
    return defaultPageSize;
  }
}

export function writeStoredPageSize(storageKey: string, pageSize: PageSize) {
  try {
    window.localStorage.setItem(pageSizeStorageKey(storageKey), String(pageSize));
  } catch {
    // Pagination still works without localStorage in restricted browsers.
  }
}
