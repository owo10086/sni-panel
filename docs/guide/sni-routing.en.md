# SNI routing with a host failover group

[中文说明](./sni-routing.md)

A host failover group selects the current entrance. Each SNI rule selects a final destination by the full hostname in the client's TLS ClientHello. Every enabled host runs a final splitter directly on the saved business port. There is no shared exit host or extra loopback listener.

## Set up the service

1. Add at least two Linux hosts and check that every enabled member reports a recognizable Agent version of **2.2.195 or newer**. Business connections still need a working path from their entrance to the destination.
2. Save a **host** failover group under link management. Choose member priorities, the failure and recovery observation windows, automatic failback, and an entrance domain if using DDNS. Tunnel failover groups, entrance groups and exit groups are outside this SNI support.
3. As an administrator, add a rule on the saved group and enable SNI routing. The default entrance port is **443**, and you can change it to an allowed port. Editing preserves a saved non-443 port. SNI uses TCP; the group's ordinary forwarding tool is not used for these splitters.
4. Enter a full business hostname, destination address and port. Add more hostnames on the same business port as needed. For example, `api.example.com` and `files.example.com` can share port `18443` and reach different services.
5. Wait for applied confirmation on every member. A saved rule or an open listening port does not confirm readiness. Old destinations or old limits remain pending even if the hostname and a successful configuration version are still reported.

## Failover and DNS

An SNI entrance is eligible when its Agent is online, every required splitter port and rule is running with the current configuration, and enabled China health checks have passed. Missing, failed or expired SNI destination probes do not block DDNS or independently switch the whole group. For example, one failed business destination leaves entrance A selected while A's splitter and Bing check remain healthy. Ordinary rules in a mixed group still require their existing destination checks.

Splitter confirmations remain valid for **five minutes**. An explicit unchanged-content report can renew a confirmation when the panel has the corresponding verified full contents. Presence, Bing reports and command acknowledgements cannot renew it. Confirmed disconnection, an Agent restart or expired confirmation requires fresh runtime confirmation. After a panel restart, incomplete history also requires confirmation and recovery observation.

Failure and recovery windows use the group's settings and run independently for each health source. A healthy Bing probe cannot clear a splitter failure or lend its healthy duration to a recovering splitter. First use does not add a splitter recovery delay after valid confirmation. A previously failed backup must finish recovery even when the current entrance has failed: with a 120-second recovery setting, B recovered for only five seconds cannot replace A; a qualified C can, otherwise the existing DNS record is retained until reevaluation. Deadlines and changed time settings trigger automatic reevaluation. Automatic failback returns to a qualified higher-priority member when enabled; when disabled, a healthy backup remains selected, while a failed current member can still be replaced by a recovered higher-priority member. Status messages identify missing confirmation, stopped splitters, outdated contents, expired confirmation or unfinished recovery.

A business domain can use a CNAME to the group's entrance domain: `api.example.com → entry.example.com`. TLS still carries `api.example.com`, which is the name the splitter matches. Changing the group domain updates the new domain even when the selected member and address are unchanged. Existing DDNS settings, traffic exclusions and switch notifications continue to apply. A DDNS failure leaves a visible error, does not announce a completed switch and uses the existing retry flow. If no entrance qualifies, ordinary health failures retain the existing DNS record.

DNS caches may keep clients on the old entrance. Established connections do not migrate. They can continue while the old entrance is reachable; interrupted connections must reconnect. Prepared backups cannot eliminate DNS cache delays.

## Limits, traffic and edits

Rate and connection limits apply **per member**. A rule limited to 10 Mbps can receive 10 Mbps on each entrance when DNS caches or existing connections keep both active. This is not a strict aggregate cap across the group. Zero means unlimited for that rule, preserving the existing SNI handling of user and resource limits.

Each final splitter reports its actual rule traffic. The panel deduplicates reports and accumulates traffic from old and new entrances into the root rule and its owner. Resynchronizing, enabling, failover or increasing a quota does not erase accumulated use. Quota and expiry remove only the affected hostname; other domains sharing the port keep working. Existing account restrictions still apply.

Rule and member changes save atomically. A failure during saving restores the previous roots, children and group settings. Once saving succeeds, offline hosts and failed application remain pending until they confirm the new contents. Changing or removing one domain closes its own connections; unchanged domains retain their connections and the shared listener. Removing the last rule removes that listener.

If a removal update fails and the old table still contains a disabled, deleted, quota-exhausted, expired or unauthorized hostname, the panel's existing shell channel stops that entrance's unsafe shared listener and deletes its runtime and recovery snapshots. This exceptional failure temporarily affects other hostnames sharing that port on the same entrance; successful hot updates preserve their connections. The entrance remains failed or pending until the current table is applied. The existing minimum Agent version remains 2.2.195.

When the running table is already safe but deleting the first rule leaves an old recovery snapshot containing a revoked hostname, the guard removes only that snapshot. The active listener and other domains' connections continue.

Changing a destination address or port preserves historical measurements and requires confirmation of the new splitter contents; entrance eligibility does not wait for a new destination probe. The selected entrance, its current configuration and the group domain are rechecked after the DDNS provider responds, so an intervening save cannot commit success using superseded settings. A rejected selection also triggers reconciliation of the provider record.

A hostname is unique across ports and resources on each entrance. Managed copies of the same root are legal. Ordinary forwarding and SNI cannot occupy the same business port. Unknown names, missing SNI, non-TLS traffic and incomplete handshakes are rejected. Matched TLS handshakes are forwarded unchanged.

## Copy, import and export

Select the saved host failover group and use the existing text format:

```text
API#api.example.com#203.0.113.10#443
Files#files.example.com#203.0.113.20#8443
```

Choose the common entrance port. Each item saves independently: failed items show their reasons and remain for retry, while successful items stay saved. JSON exports retain resource context, SNI hostname, entrance port, destination, rate, connection limit, quota and expiry. Confirm the destination resource when importing. Duplicate names on an entrance are rejected; they never silently become ordinary rules. Text imports contain only the four shown fields; set additional limits in the editor or JSON. Copies and newly imported rules start their own usage counters.

SNI management requires administrator access. Administrators acting for a user still obey that user's resource access, allowed port range and quota. Administrator-managed rules remain read-only for ordinary owners, and member copies are controlled through the root rule.

## Other supported resources

SNI continues to work on forwarding chains, single-host port forwarding and direct tunnels with one exit. Chains route at the entrance to their own next hop, then route again at the final exit. Their rate limits and accounting remain centralized at that exit. The host failover group's per-member final splitters are specific to that resource type.
