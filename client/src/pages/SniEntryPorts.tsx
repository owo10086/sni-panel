import { Redirect } from "wouter";

/** Compatibility for old bookmarks and already-prefetched route modules. */
export default function SniEntryPortsPage() {
  return <Redirect to="/rules?tab=sni" replace />;
}
