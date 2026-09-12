import crypto from "crypto";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";

type GostAuth = {
  username: string;
  password: string;
};

type GostComponent = {
  type: "forward" | "relay";
  auth?: GostAuth;
  metadata?: Record<string, unknown>;
};

function relayComponent(username: string, passwordSeed: string): GostComponent {
  return {
    type: "relay",
    auth: {
      username,
      password: crypto.createHash("sha256").update(passwordSeed).digest("hex"),
    },
    metadata: { nodelay: true },
  };
}

export function planGostTunnelHopRelay(input: {
  tunnelId: number;
  secretSeed: string;
}): GostComponent {
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  return relayComponent(
    `fwx-hop-${tunnelId}`,
    `forwardx-gost-hop-relay:v1|${String(input.secretSeed || "")}|${tunnelId}`,
  );
}

export type GostTunnelRuleProtocolPlan = {
  protocol: "tcp" | "udp" | "both";
  entryNeedsTarget: boolean;
  chainConnector: GostComponent;
  exitHandler: GostComponent;
  exitTargetDialType: "tcp" | "udp" | null;
};

export function planGostTunnelRuleProtocol(input: {
  protocol: unknown;
  tunnelId: number;
  ruleId: number;
  /**
   * Identity to derive the relay credentials from, when it must not be tied to
   * a single rule. SNI 分流组 share one entry listener, so every member has to
   * agree on one credential that survives any one member being removed.
   */
  ruleKey?: string;
  secretSeed: string;
}): GostTunnelRuleProtocolPlan {
  const protocol = normalizeForwardRuleProtocol(input.protocol, "tcp");
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  const ruleId = Math.max(0, Math.trunc(Number(input.ruleId) || 0));
  const ruleKey = String(input.ruleKey || "").trim() || String(ruleId);
  const component = relayComponent(
    `fwx-${tunnelId}-${ruleKey}`,
    `forwardx-gost-relay:v1|${String(input.secretSeed || "")}|${tunnelId}|${ruleKey}`,
  );

  return {
    protocol,
    entryNeedsTarget: true,
    chainConnector: component,
    exitHandler: component,
    exitTargetDialType: null,
  };
}
