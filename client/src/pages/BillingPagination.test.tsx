import assert from "node:assert/strict";
import test from "node:test";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

type QueryInput = { page: number; pageSize: number; usage?: string };
const lists = [
  { tab: "ledger", procedure: "billing.ledgerPage", key: "ledger", size: 20 },
  { tab: "subscriptions", procedure: "plans.subscriptionsPage", key: "subscriptions", size: 20 },
  { tab: "balance", procedure: "billing.listTransactionsPage", key: "transactions", size: 20 },
  { tab: "redeem", procedure: "billing.listRedemptionCodesPage", key: "redemption", size: 50 },
  { tab: "discount", procedure: "billing.listDiscountCodesPage", key: "discount", size: 50 },
];

function setup(storage = new Map<string, string>()) {
  let tab = "ledger";
  let redemptionCount = 50;
  const requests: Array<{ procedure: string; input: QueryInput }> = [];
  const mutations: Array<{ procedure: string; input: any }> = [];
  const cached = new Map<string, any>();
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({invalidate() {}}) }) });
  const trpc = new Proxy({}, { get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, {
    get: (_, procedure) => ({
      useQuery(input: QueryInput, options?: {enabled?: boolean}) {
        const name = `${String(resource)}.${String(procedure)}`;
        if (input?.pageSize && options?.enabled !== false) requests.push({procedure: name, input});
        const key = JSON.stringify([name, input, redemptionCount]);
        if (!cached.has(key)) cached.set(key, input?.pageSize ? {
          items: name === "billing.listRedemptionCodesPage" ? Array.from({length: Math.min(redemptionCount, input.pageSize)}, (_, index) => ({
            id: (input.page - 1) * input.pageSize + index + 1, code: `CODE-${index}`, type: "balance", amountCents: 100,
          })) : [],
          totalItems: 2400,
        } : name === "plans.options" ? [] : {});
        return {data: cached.get(key), isLoading: false, isPlaceholderData: false};
      },
      useMutation() {
        return { isPending: false, mutate: (input: any) => mutations.push({procedure: `${String(resource)}.${String(procedure)}`, input}) };
      },
    }),
  }) });
  const harness = createPaginationHarness(storage, {
    "@/lib/trpc": {trpc},
    "@/hooks/useUrlTab": {useUrlTab: () => [tab, (value: string) => {tab = value;}]},
    "@/components/ui/confirm-dialog": {useConfirmDialog: () => async () => true},
    "@/lib/localizedToast": {toast: {success() {}, error() {}}},
  });
  const Billing = harness.load("client/src/pages/Billing.tsx").default;
  const paginationModule = harness.load("client/src/components/PersistentPagination.tsx");
  let tree: any;
  const render = () => { tree = harness.render(() => Billing()); return tree; };
  const paginationElement = (index: number) => findElements(tree, (element) => element.type === paginationModule.PersistentPagination)[index];
  return {
    ...harness, requests, mutations, render,
    switchTab(value: string) { tab = value; render(); },
    setRedemptionCount(value: number) { redemptionCount = value; render(); },
    pagination(index: number) { return paginationElement(index).props.pagination; },
    selectSize(index: number, size: number) {
      const bar = paginationModule.PersistentPagination(paginationElement(index).props);
      const select = findElements(bar, (element) => element.type === "Select")[0];
      assert.ok(select, "the actual pagination selector must be present");
      select.props.onValueChange(String(size));
      render();
    },
    elements(predicate: (element: any) => boolean) { return findElements(tree, predicate); },
    lastRequest(procedure: string) { return requests.filter((request) => request.procedure === procedure).at(-1)!.input; },
  };
}

test("all five billing lists send the selected tRPC pageSize, reset to page 1, restore and stay independent", () => {
  const page = setup();
  page.render();
  for (const list of lists) {
    page.switchTab(list.tab);
    assert.equal(page.lastRequest(list.procedure).pageSize, list.size);
  }
  const sizes = [50, 100, 200, 500, 1000];
  for (const [index, list] of lists.entries()) {
    page.switchTab(list.tab);
    page.pagination(index).setPage(2); page.render();
    assert.equal(page.lastRequest(list.procedure).page, 2);
    const offset = page.requests.length;
    page.selectSize(index, sizes[index]);
    const inputs = page.requests.slice(offset).filter((request) => request.procedure === list.procedure).map((request) => request.input);
    assert.ok(inputs.length > 0);
    assert.ok(inputs.every((input) => input.pageSize === sizes[index] && input.page === 1), "size and reset are atomic in actual query inputs");
    page.pagination(index).setPage(2); page.render();
  }
  page.remount(); page.render();
  for (const [index, list] of lists.entries()) {
    page.switchTab(list.tab);
    assert.equal(page.lastRequest(list.procedure).page, 2, list.procedure);
    assert.equal(page.lastRequest(list.procedure).pageSize, sizes[index], list.procedure);
    assert.equal(page.storage.get(`forwardx.billing.${list.key}.pageSize`), String(sizes[index]));
  }
});

test("redemption mount keeps restored page 2 after effects and an actual usage filter change resets it", () => {
  const page = setup(new Map([["forwardx.billing.redemption.page", "2"], ["forwardx.billing.redemption.pageSize", "100"]]));
  page.switchTab("redeem");
  assert.equal(page.lastRequest("billing.listRedemptionCodesPage").page, 2);
  page.remount(); page.render();
  assert.equal(page.lastRequest("billing.listRedemptionCodesPage").page, 2);
  const filter = page.elements((element) => element.type === "Select" && element.props.value === "all")[0];
  filter.props.onValueChange("unused"); page.render();
  assert.equal(page.lastRequest("billing.listRedemptionCodesPage").page, 1);
  assert.equal(page.lastRequest("billing.listRedemptionCodesPage").usage, "unused");
});

function deletionButton(page: ReturnType<typeof setup>) {
  return page.elements((element) => element.type === "Button" && JSON.stringify(element.props.children).includes("删除所选"))[0];
}
function selectAll(page: ReturnType<typeof setup>) {
  const headers = page.elements((element) => element.type === "TableHead");
  const checkbox = headers.flatMap((header) => findElements(header, (element) => element.type === "input" && element.props.type === "checkbox"))[0];
  checkbox.props.onChange({target: {checked: true}}); page.render();
}

test("redemption size change on page 1 clears selection; 500 deletes once, 501 disables and never requests deletion", async () => {
  const page = setup();
  page.switchTab("redeem");
  selectAll(page);
  assert.equal(deletionButton(page).props.disabled, false);
  page.selectSize(3, 100);
  assert.equal(page.lastRequest("billing.listRedemptionCodesPage").page, 1);
  assert.equal(deletionButton(page).props.disabled, true, "selection cleared even when the page stays at 1");
  page.setRedemptionCount(500); page.selectSize(3, 500);
  selectAll(page);
  assert.equal(deletionButton(page).props.disabled, false);
  await deletionButton(page).props.onClick(); page.render();
  assert.equal(page.mutations.length, 1);
  assert.equal(page.mutations[0].procedure, "billing.deleteRedemptionCodes");
  assert.equal(page.mutations[0].input.ids.length, 500);
  page.setRedemptionCount(501); page.selectSize(3, 1000);
  selectAll(page);
  const button = deletionButton(page);
  assert.equal(button.props.disabled, true);
  assert.ok(page.elements((element) => element.type === "p" && element.props.children === "一次最多删除 500 个兑换码").length > 0);
  await button.props.onClick();
  assert.equal(page.mutations.length, 1, "over-limit handler is guarded as well as disabled");
});
