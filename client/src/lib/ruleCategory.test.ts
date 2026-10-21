import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("Rules.tsx", readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageFunction(name: string, context: Record<string, unknown>) {
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) expression = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `actual page function ${name}`);
  return runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
}
const parseResource = (value: string) => {
  const [type, id] = value.split(":");
  return { type: type === "all" ? null : type, id: Number(id) || null };
};

test("selecting SNI clears the old resource and subsequent resource selection retains the SNI tab", () => {
  let category = "group", resource = "group:12";
  const context = {
    RULE_CATEGORIES: ["all","local","tunnel","chain","group","sni"],
    ruleCategory: category, filterResource: resource, filterResourceStorageKey: "test",
    parseRuleResourceFilter: parseResource, normalizeRuleResourceFilter: (v: string) => v,
    setRuleCategory: (v: string) => { category = v; }, setFilterResource: (v: string) => { resource = v; },
    storeString() {}, setRuleResourceMenuType() {}, setRuleResourceMenuOpen() {},
  };
  pageFunction("handleRuleCategoryChange", context)("sni");
  assert.equal(category, "sni");
  assert.equal(resource, "all");
  for (const selected of ["local:10", "tunnel:20", "chain:11", "group:12", "all"]) {
    pageFunction("handleFilterResourceChange", {...context, ruleCategory: category})(selected);
    assert.equal(category, "sni");
    assert.equal(resource, selected);
  }
  pageFunction("handleRuleCategoryChange", {...context, ruleCategory: category, filterResource: resource})("chain");
  assert.equal(category, "chain");
  assert.equal(resource, "chain");
});

test("batch filtering keeps SNI source rules and exports actual resource types", () => {
  const getResource = pageFunction("getRuleCategory", {getRuleForwardGroupKind: () => "chain"});
  const visible = pageFunction("isForwardRuleVisibleByFilters", {
    parseRuleResourceFilter: parseResource, getRuleCategory: getResource, isRuleSearchMatch: () => true,
  });
  const rule = {id:101,userId:1,sni:"a.example",forwardGroupId:11};
  const filters = {isAdmin:true,filterUser:"self",userId:1,filterResource:"all",forwardGroupById:new Map([[11,{}]]),ruleCategory:"all"};
  assert.equal(visible(rule,filters),false);
  assert.equal(visible(rule,{...filters,ruleCategory:"chain"}),false);
  assert.equal(visible(rule,{...filters,ruleCategory:"sni"}),true);
  assert.equal(visible(rule,{...filters,includeSniInAll:true}),true, "explicit selections survive the batch dialog's all-rules filter");
  assert.equal(visible({...rule,userId:2},{...filters,ruleCategory:"sni"}),false);
  assert.equal(getResource(rule,new Map()),"chain", "resource paths and copying retain the actual link type");
  let exportType = "";
  pageFunction("openExportDialog", { ruleCategory:"sni", filterResource:"chain:11", parseRuleResourceFilter:parseResource,
    setExportScopeType:(v:string)=>{exportType=v;}, setShowExportDialog() {} })();
  assert.equal(exportType,"chain");
});
