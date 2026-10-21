import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SniDomainWarnings } from "./SniDomainWarnings";

test("a shared group retains another resource's missing domain on its own related entry", () => {
  const entries = [
    { entryHost: {id:1,name:"入口甲"}, sourcePort:443, domainSetConsistent:false, missingDomains:[], routes:[{ruleId:10},{ruleId:20}] },
    { entryHost: {id:2,name:"入口乙"}, sourcePort:443, domainSetConsistent:false, missingDomains:["other-resource.example"], routes:[{ruleId:10}] },
    { entryHost: {id:3,name:"独立入口丙"}, sourcePort:443, domainSetConsistent:false, missingDomains:["unrelated.example"], routes:[{ruleId:30}] },
    { entryHost: {id:1,name:"其他端口"}, sourcePort:8443, domainSetConsistent:false, missingDomains:["other-port.example"], routes:[{ruleId:10}] },
  ];
  const rules = [{id:10,sourcePort:443}]; // Resource 20 is deliberately absent from the displayed page/search.
  const html = renderToStaticMarkup(<SniDomainWarnings entries={entries} rules={rules} isAdmin />);
  assert.match(html, /域名配置不一致/);
  assert.match(html, /入口乙:443/);
  assert.match(html, /other-resource.example/);
  assert.match(html, /面板规则配置核对/);
  assert.doesNotMatch(html, /独立入口丙|unrelated.example|other-port.example|入口甲/);
  assert.equal(renderToStaticMarkup(<SniDomainWarnings entries={entries} rules={[{id:20,sourcePort:443}]} isAdmin />), "",
    "a missing domain on an unrelated entry must not be assigned to this resource");
  assert.equal(renderToStaticMarkup(<SniDomainWarnings entries={entries} rules={rules} isAdmin={false} />), "",
    "cached administrator data cannot leak after an identity change");
});

test("normal and uncovered direct tunnel groups do not occupy a warning row", () => {
  assert.equal(renderToStaticMarkup(<SniDomainWarnings rules={[{id:90,sourcePort:443}]} isAdmin />), "");
  assert.equal(renderToStaticMarkup(<SniDomainWarnings entries={[]} rules={[{id:90,sourcePort:443}]} isAdmin />), "");
});
