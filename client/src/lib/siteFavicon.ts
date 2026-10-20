export function siteFavicon(logo: string | null | undefined, dark = false) {
  const custom = logo?.trim() || "";
  const mime = /^data:(image\/(?:png|jpe?g|webp|gif));base64,/i.exec(custom)?.[1];
  return mime
    ? { href: custom, type: mime.toLowerCase(), svg: false }
    : { href: dark ? "/logo-dark.png" : "/logo-light.png", type: "image/png", svg: false };
}

export function applySiteFavicon(doc: Document, logo: string | null | undefined, dark = false) {
  const icon = siteFavicon(logo, dark);
  const existing = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  if (existing.length === 1 && existing[0].getAttribute("href") === icon.href && existing[0].type === icon.type) return;
  // Replace the node as well as the URL so browsers don't keep their previous
  // favicon candidate. Remove both static SVG/PNG links to avoid competition.
  const link = doc.createElement("link");
  link.id = "forwardx-site-favicon";
  link.rel = "icon";
  link.type = icon.type;
  if (icon.svg) link.setAttribute("sizes", "any");
  link.setAttribute("href", icon.href);
  existing.forEach(node => node.remove());
  doc.head.appendChild(link);
}
