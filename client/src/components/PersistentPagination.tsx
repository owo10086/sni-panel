import { t as translateText } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZE_OPTIONS, type PageSize } from "@shared/pagination";
import { parsePageSize, readStoredPageSize, writeStoredPageSize } from "@/lib/pageSize";

export type PersistentPaginationState<T> = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  setPageSize: (pageSize: number) => void;
  startItem: number;
  endItem: number;
  items: T[];
  setPage: (page: number) => void;
  nextPage: () => void;
  previousPage: () => void;
};

export type PersistentPageRequestState = {
  page: number;
  setPage: (page: number) => void;
  pageSize: PageSize;
  setPageSize: (pageSize: number) => void;
};

function readStoredPage(storageKey: string) {
  if (typeof window === "undefined") return 1;
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  } catch {
    return 1;
  }
}

function writeStoredPage(storageKey: string, page: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(page));
  } catch {
    // Pagination still works without localStorage in restricted browsers.
  }
}

export function usePersistentPageRequest(storageKey: string, defaultPageSize: PageSize): PersistentPageRequestState {
  const readState = () => ({
    storageKey,
    page: readStoredPage(storageKey),
    pageSize: readStoredPageSize(storageKey, defaultPageSize),
  });
  const [stored, setStored] = useState(readState);
  // Switching lists restores the target state before issuing its first request.
  const state = stored.storageKey === storageKey ? stored : readState();
  if (stored.storageKey !== storageKey) setStored(state);

  const setPage = useCallback((nextPage: number) => {
    const normalized = Math.max(1, Math.floor(Number(nextPage) || 1));
    setStored((current) => ({ ...current, page: normalized }));
    writeStoredPage(storageKey, normalized);
  }, [storageKey]);

  const setPageSize = useCallback((nextPageSize: number) => {
    const pageSize = parsePageSize(nextPageSize, defaultPageSize);
    setStored((current) => ({ ...current, page: 1, pageSize }));
    writeStoredPageSize(storageKey, pageSize);
    writeStoredPage(storageKey, 1);
  }, [defaultPageSize, storageKey]);

  return {
    page: state.page,
    setPage,
    pageSize: state.pageSize,
    setPageSize,
  };
}

export function useServerPagination<T>(
  items: T[],
  totalItems: number,
  request: PersistentPageRequestState,
  { isReady = true }: { isReady?: boolean } = {},
): PersistentPaginationState<T> {
  const pageSize = request.pageSize;
  const normalizedTotal = Math.max(0, Math.floor(Number(totalItems) || 0));
  const totalPages = isReady ? Math.max(1, Math.ceil(normalizedTotal / pageSize)) : Math.max(1, request.page);
  const currentPage = isReady ? Math.min(Math.max(request.page, 1), totalPages) : Math.max(request.page, 1);

  useEffect(() => {
    if (!isReady || request.page === currentPage) return;
    request.setPage(currentPage);
  }, [currentPage, isReady, request]);

  const setPage = (nextPage: number) => {
    const normalized = Math.floor(Number(nextPage) || 1);
    request.setPage(Math.min(Math.max(normalized, 1), totalPages));
  };
  const startItem = normalizedTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = normalizedTotal === 0 ? 0 : Math.min(normalizedTotal, currentPage * pageSize);

  return {
    currentPage,
    totalPages,
    totalItems: normalizedTotal,
    pageSize,
    setPageSize: request.setPageSize,
    startItem,
    endItem,
    items: isReady ? items : [],
    setPage,
    nextPage: () => setPage(currentPage + 1),
    previousPage: () => setPage(currentPage - 1),
  };
}

function getPageWindow(currentPage: number, totalPages: number) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, currentPage]);
  if (currentPage > 2) pages.add(currentPage - 1);
  if (currentPage < totalPages - 1) pages.add(currentPage + 1);
  return Array.from(pages).sort((a, b) => a - b);
}

export function PersistentPagination<T>({
  pagination,
  className,
}: {
  pagination: PersistentPaginationState<T>;
  className?: string;
}) {
  if (pagination.totalItems <= PAGE_SIZE_OPTIONS[0]) return null;
  const pages = getPageWindow(pagination.currentPage, pagination.totalPages);

  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-3 text-sm", className)}>
      <div className="text-xs tabular-nums text-muted-foreground">{translateText("共 {0} 条", [pagination.totalItems])}</div>
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={translateText("上一页")}
          disabled={pagination.currentPage <= 1}
          onClick={pagination.previousPage}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 text-xs tabular-nums text-muted-foreground sm:hidden" aria-label={translateText("第 {0} 页，共 {1} 页", [pagination.currentPage, pagination.totalPages])}>{pagination.currentPage} / {pagination.totalPages}</span>
        <div className="hidden items-center gap-1 sm:flex">
          {pages.map((page, index) => {
            const previous = pages[index - 1];
            const hasGap = previous && page - previous > 1;
            return (
              <div key={page} className="flex items-center gap-1">
                {hasGap && <span className="px-1 text-xs text-muted-foreground">...</span>}
                <Button
                  variant={page === pagination.currentPage ? "outline" : "ghost"}
                  size="sm"
                  className={cn("h-8 min-w-8 px-2", page === pagination.currentPage && "border-primary bg-primary/5 text-primary")}
                  aria-current={page === pagination.currentPage ? "page" : undefined}
                  onClick={() => pagination.setPage(page)}
                >
                  {page}
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label={translateText("下一页")}
          disabled={pagination.currentPage >= pagination.totalPages}
          onClick={pagination.nextPage}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex w-full justify-end sm:w-auto">
        <Select value={String(pagination.pageSize)} onValueChange={(value) => pagination.setPageSize(Number(value))}>
          <SelectTrigger className="h-8 w-auto min-w-28" aria-label={translateText("{0} 条/页", [pagination.pageSize])}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)} className="data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground">
                {translateText("{0} 条/页", [size])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
