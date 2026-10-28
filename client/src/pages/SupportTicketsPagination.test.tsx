import assert from "node:assert/strict";
import test from "node:test";
import * as supportTickets from "@shared/supportTickets";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

type ListInput = { page: number; pageSize: number; search: string; status?: string };
function setup(storage = new Map<string, string>()) {
  let role = "admin";
  let total = 2400;
  let queryState: "ready" | "loading" | "placeholder" = "ready";
  const requests: ListInput[] = [];
  const mutations: any[] = [];
  const confirmations: any[] = [];
  const utils = { supportTickets: { invalidate() {} } };
  const trpc = { useUtils: () => utils, supportTickets: {
    status: { useQuery: () => ({ data: { enabled: true } }) },
    summary: { useQuery: () => ({ data: { statuses: {}, unread: 0 } }) },
    list: { useQuery(input: ListInput) {
      requests.push(input);
      return {
        data: queryState === "loading" ? undefined : {
          total: queryState === "placeholder" ? 10 : total,
          pageSize: input.pageSize,
          items: Array.from({ length: Math.min(input.pageSize ?? 20, Math.max(0, total - (input.page - 1) * (input.pageSize ?? 20))) }, (_, index) => ({
            id: (input.page - 1) * (input.pageSize ?? 20) + index + 1,
            title: `Ticket ${index + 1}`, version: 3, status: "open", category: "technical", priority: "normal",
          })),
        },
        isLoading: queryState === "loading", isPlaceholderData: queryState === "placeholder", refetch() {},
      };
    } },
    bulkStatus: { useMutation: () => ({ isPending: false, mutate: (input: any) => mutations.push(input) }) },
  } };
  const harness = createPaginationHarness(storage, {
    "@/lib/trpc": { trpc },
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: { id: 1, role } }) },
    "wouter": { useLocation: () => ["/tickets", () => {}], useSearch: () => "" },
    "@shared/supportTickets": supportTickets,
    "@/components/SupportTicketMessage": { ticketDate: () => "—", TicketStatusBadge: "TicketStatusBadge" },
    "@/components/ui/confirm-dialog": { useConfirmDialog: () => async (input: any) => { confirmations.push(input); return true; } },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
  });
  const SupportTickets = harness.load("client/src/pages/SupportTickets.tsx").default;
  const paginationModule = harness.load("client/src/components/PersistentPagination.tsx");
  let tree: any;
  const render = () => {
    tree = harness.render(() => {
      const root = SupportTickets();
      const list = findElements(root, element => element.type?.name === "TicketList")[0];
      assert.ok(list, "render the actual ticket list reached from the page");
      return list.type(list.props);
    });
    return tree;
  };
  const paginationElement = () => findElements(tree, element => element.type === paginationModule.PersistentPagination)[0];
  return {
    ...harness, requests, mutations, confirmations, render,
    lastRequest: () => requests.at(-1)!,
    pagination() {
      assert.ok(paginationElement(), "ticket list must use the shared pagination");
      return paginationElement().props.pagination;
    },
    paginationBar() { return paginationModule.PersistentPagination(paginationElement().props); },
    selectSize(size: number) {
      assert.ok(paginationElement(), "ticket list must use the shared pagination");
      const bar = paginationModule.PersistentPagination(paginationElement().props);
      const select = findElements(bar, element => element.type === "Select")[0];
      assert.ok(select, "use the actual shared page-size selector");
      select.props.onValueChange(String(size));
      render();
    },
    setTotal(value: number) { total = value; render(); },
    setQueryState(value: typeof queryState) { queryState = value; render(); },
    switchRole(value: string) { role = value; harness.remount(); render(); },
    elements(predicate: (element: any) => boolean) { return findElements(tree, predicate); },
  };
}

test("ticket list sends selected tRPC pageSize, resets to page 1 and restores page and size on remount", () => {
  const page = setup();
  page.render();
  assert.equal(page.lastRequest().pageSize, 20);
  for (const size of [50, 100, 200, 500, 1000]) {
    page.pagination().setPage(2); page.render();
    assert.equal(page.lastRequest().page, 2);
    const offset = page.requests.length;
    page.selectSize(size);
    assert.ok(page.requests.slice(offset).every(input => input.page === 1 && input.pageSize === size));
    page.pagination().setPage(2); page.render();
    page.remount(); page.render();
    assert.equal(page.lastRequest().page, 2);
    assert.equal(page.lastRequest().pageSize, size);
    assert.equal(page.storage.get("forwardx.supportTickets.admin.page"), "2");
    assert.equal(page.storage.get("forwardx.supportTickets.admin.pageSize"), String(size));
  }
});

function bulkButtons(page: ReturnType<typeof setup>) {
  const buttons = page.elements(element => element.type === "Button" && ["标记已解决", "批量关闭"].includes(element.props.children));
  assert.equal(buttons.length, 2);
  return buttons;
}
function selectAll(page: ReturnType<typeof setup>) {
  const checkbox = page.elements(element => element.type === "input" && element.props["aria-label"] === "选择本页工单")[0];
  checkbox.props.onChange({ target: { checked: true } });
  page.render();
}

test("changing ticket page size while on page 1 clears all selected tickets", () => {
  const page = setup();
  page.render();
  selectAll(page);
  assert.ok(bulkButtons(page).every(button => button.props.disabled === false));
  page.selectSize(50);
  assert.equal(page.lastRequest().page, 1);
  assert.ok(bulkButtons(page).every(button => button.props.disabled === true));
  assert.ok(page.elements(element => element.type === "input" && element.props.type === "checkbox").every(checkbox => !checkbox.props.checked));
});

test("both bulk status actions submit 50 tickets once and block 51 without confirmation or requests", async () => {
  for (const [index, status] of ["resolved", "closed"].entries()) {
    const page = setup();
    page.render(); page.setTotal(50); page.selectSize(100);
    selectAll(page);
    assert.ok(bulkButtons(page).every(button => button.props.disabled === false));
    await bulkButtons(page)[index].props.onClick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(page.mutations.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(page.mutations[0])), {
      status, tickets: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, version: 3 })),
    });
    assert.equal(page.confirmations.length, 1);
    page.setTotal(51); selectAll(page);
    assert.ok(bulkButtons(page).every(button => button.props.disabled === true));
    assert.equal(page.elements(element => element.type === "p" && element.props.children === "一次最多批量处理 50 个工单").length, 1);
    for (const button of bulkButtons(page)) await button.props.onClick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(page.mutations.length, 1, "over-limit handlers do not split or submit requests");
    assert.equal(page.confirmations.length, 1);
  }
});

test("restored ticket page survives loading and placeholder totals, then corrects using current page size", () => {
  const page = setup(new Map([["forwardx.supportTickets.admin.page", "9"], ["forwardx.supportTickets.admin.pageSize", "50"]]));
  page.setQueryState("loading");
  assert.equal(page.lastRequest().page, 9);
  page.setQueryState("placeholder");
  assert.equal(page.lastRequest().page, 9, "old total 10 must not overwrite the restored page");
  page.setTotal(137); page.setQueryState("ready");
  assert.equal(page.lastRequest().page, 3, "137 tickets at 50 per page have three pages");
  assert.equal(page.lastRequest().pageSize, 50);
  assert.equal(page.storage.get("forwardx.supportTickets.admin.page"), "3");
  const statusFilter = page.elements(element => element.type?.name === "EnumSelect" && element.props.label === "全部状态")[0];
  statusFilter.props.onChange("resolved"); page.render();
  assert.equal(page.lastRequest().status, "resolved");
  assert.equal(page.lastRequest().page, 1);
  page.pagination().setPage(3); page.render();
  page.setTotal(0);
  assert.equal(page.lastRequest().page, 1);
});

test("ticket pagination uses record copy, hides at 20 and remains available for a single large page", () => {
  const page = setup(new Map([["forwardx.supportTickets.admin.pageSize", "100"]]));
  page.setTotal(20);
  assert.equal(page.paginationBar(), null);
  page.setTotal(21);
  assert.equal(page.pagination().totalPages, 1);
  const bar = page.paginationBar();
  assert.ok(findElements(bar, element => element.props.children === "共 21 条").length > 0);
  assert.ok(findElements(bar, element => element.type === "Select" && element.props.value === "100").length > 0);
});

test("administrator and user ticket views persist page and size independently", () => {
  const page = setup();
  page.render(); page.selectSize(50);
  page.pagination().setPage(2); page.render();
  page.switchRole("user");
  assert.equal(page.lastRequest().page, 1);
  assert.equal(page.lastRequest().pageSize, 20);
  page.selectSize(100);
  page.pagination().setPage(3); page.render();
  page.switchRole("admin");
  assert.equal(page.lastRequest().page, 2);
  assert.equal(page.lastRequest().pageSize, 50);
  page.switchRole("user");
  assert.equal(page.lastRequest().page, 3);
  assert.equal(page.lastRequest().pageSize, 100);
});
