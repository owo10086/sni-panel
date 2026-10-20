import assert from "node:assert/strict";
import test from "node:test";
import { applySiteFavicon, siteFavicon } from "./siteFavicon";

test("favicon keeps the local PNG and follows light/dark mode", () => {
  assert.deepEqual(siteFavicon(null), { href: "/logo-light.png", type: "image/png", svg: false });
  assert.deepEqual(siteFavicon(undefined, true), { href: "/logo-dark.png", type: "image/png", svg: false });
});

test("uploaded logos take priority and retain the correct MIME type", () => {
  for (const type of ["png", "jpeg", "webp", "gif"]) {
    const logo = `data:image/${type};base64,dGVzdA==`;
    assert.deepEqual(siteFavicon(logo, false), { href: logo, type: `image/${type}`, svg: false });
    assert.equal(siteFavicon(logo, true).href, logo);
  }
  for (const invalid of [null, undefined, "", "javascript:alert(1)", "https://example.com/icon.png"]) {
    assert.equal(siteFavicon(invalid, false).href, "/logo-light.png");
  }
});

function fakeDocument() {
  const nodes: any[] = [];
  let created = 0;
  const doc = {
    querySelectorAll: () => nodes.filter(node => node.rel.split(/\s+/).includes("icon")),
    createElement: () => {
      created++;
      const node: any = { rel: "", type: "", attributes: new Map(),
        setAttribute(key: string, value: string) { this.attributes.set(key, value); },
        getAttribute(key: string) { return this.attributes.get(key); },
        remove() { nodes.splice(nodes.indexOf(this), 1); },
      };
      return node;
    },
    head: { appendChild: (node: any) => nodes.push(node) },
  };
  return { doc: doc as unknown as Document, nodes, created: () => created };
}

test("replace competing favicon candidates, refresh changed images, restore local PNG default and avoid churn", () => {
  const { doc, nodes, created } = fakeDocument();
  for (const rel of ["icon", "shortcut icon", "apple-touch-icon"]) {
    const node = doc.createElement("link"); node.rel = rel; doc.head.appendChild(node);
  }
  applySiteFavicon(doc, "", false);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].rel, "apple-touch-icon");
  assert.equal(nodes[1].id, "forwardx-site-favicon");
  assert.equal(nodes[1].getAttribute("sizes"), undefined);
  const initial = nodes[1];
  const before = created();
  applySiteFavicon(doc, "", false);
  assert.equal(created(), before);
  assert.equal(nodes[1], initial);
  const logo = "data:image/png;base64,dGVzdA==";
  applySiteFavicon(doc, logo, false);
  assert.notEqual(nodes[1], initial);
  assert.equal(nodes[1].getAttribute("href"), logo);
  assert.equal(nodes[1].type, "image/png");
  assert.equal(nodes[1].getAttribute("sizes"), undefined);
  applySiteFavicon(doc, null, true);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].type, "image/png");
  assert.equal(nodes[1].getAttribute("href"), "/logo-dark.png");
});
