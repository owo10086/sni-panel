# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [Unreleased]

## [3.3.0] - 2026-10-10

### Features and configuration

- Integrates the final upstream v2.3.282 increment while retaining SNI splitting, shared ports, exit accounting, firewall cleanup and bulk operations.
- SNI follows upstream managed-rule permissions, including existing rate-limited rules. Ordinary owners have read-only access; this supersedes the v3.2.5 toggle/delete policy. Administrator statistics resets also reset logical rule quota counters and can resume quota-exhausted rules without resetting account usage or balance.

- Add an administrator-controlled sign-in/sign-up human-verification switch, enabled by default. Disabling it hides the widgets and skips only CAPTCHA checks on the server, preserving passwords, sign-in rate limits, email verification and 2FA. Include Chinese/English UI and HTTP compatibility guidance.

- Provide complete Chinese/English changelog histories and include both languages automatically in GitHub Releases, with checks for missing release sections or translations.
- Reorganize deployment and usage documentation into Docker, local installation, databases, HTTPS, paths/logs, account recovery, migration and development guides. Update both READMEs, move AI and per-rule quota documentation to their own sections, and correct outdated commands, container environment handling, installer configuration preservation and consistent SQLite backups.
- Add optional Google registration and sign-in, disabled by default. Administrators configure a Web OAuth client and callback in Settings; users can explicitly link accounts, confirm unlinking with a password, and set a password for a new Google-only account. Preserve registration controls, email allowlists, ordinary-user permissions, disabled-account checks, 2FA and session policies; never automatically merge accounts with matching emails. Protect flows with one-time browser-bound state, PKCE, signature/audience/nonce checks, request timeouts and rate limits. Keep secrets out of browser responses and plaintext audit logs, with Chinese/English UI and setup documentation.
- Support per-rule quotas for rules owned by administrators themselves, including rules shared with other people without separate user accounts. Add regression coverage for ordinary administrator-owned rules, generated group members, independent usage accounting and recovery; administrator privileges do not bypass these limits.
- Add dynamic AI parameter buttons: after specifying a target, choose an authorized tunnel, forwarding chain or forwarding group, with pagination, random/manual entry ports and TCP/UDP choices. Preserve the target and unfinished steps across restarts, invalidate stale buttons, recheck permissions, and require final confirmation. Known settings with a missing on/off value also offer buttons in Telegram and Discord.
- Show usage, quota, remaining allowance and counting mode for administrator-managed rules in user cards and lists. Persist managed ownership: users may view but cannot edit, enable/disable, delete, sort or reset these rules. Clearing limits does not remove the read-only restriction; ordinary self-created rules are unaffected. Apply the same permissions to bots and batch operations.
- Add a collapsed per-rule configuration section for administrators: speed limits, traffic quotas, outbound-only/combined/maximum-direction accounting, editable creation and expiry dates using the calendar, and optional time values. Quota/expiry suspensions cover generated group members and tunnel endpoints without changing the configured enabled switch. Removing the restriction restores service; ordinary users cannot modify limits or reset restricted usage. Establish a baseline from cumulative ingress counters, then persist logical-rule usage transactionally so resource switches, member rebuilds and creation-date edits do not clear it. Include Chinese/English UI and controlled AI queries/updates.
- Expand controlled AI tools to cover rule editing and resource-specific creation, upcoming account/host/subscription expiry, system/protocol/menu switches, host traffic and renewal configuration, tunnels/groups, user quotas and resource permissions, plans/subscriptions, usage billing and announcements. Reuse web validation and permissions; preview and confirm each write step. Keep unfinished parameters through restarts and expired confirmations, preserve unspecified fields, and reject stale previews after concurrent changes. Credentials, database migration, upgrades and arbitrary commands remain outside natural-language write tools.

### Fixes and improvements

- Rebuild bot AI operations around intent, minimal authorized context, structured plans, business validation and step-by-step confirmation. Persist parameters, missing inputs, remaining steps and progress; resume with “continue” after restart or confirmation expiry. Isolate channels, users and chats, prevent duplicate execution, and stop automatic retries when an outcome is uncertain. Fix renewal dates being overwritten by entitlement synchronization and bound model response-body time and size.
- Fix manual latency batches being claimed too early, losing partial results or failing to aggregate after panel restart. Persist complete tunnel/chain jobs before dispatch, keep original requests/results, make duplicate reports idempotent and prevent old batches overwriting new ones. Retries do not extend the original timeout; add overall deadlines and stale-state recovery.
- Correct manual probe topology and aggregation for multiple entries/exits and standby relays. Evaluate complete available paths instead of treating alternatives as serial hops; background probes no longer overwrite active manual tests. Keep completed segment results, show request/refresh/deadline failures, and clarify that a TCP connection is not an authenticated application handshake. Do not change normal forwarding state.
- Improve Chinese/English layouts: sliding tabs reserve translated text, icon and count widths, scroll locally when needed and track actual label sizes. Allow long labels and action bars to wrap in tabs, dialogs, hosts, rules, links and users. Shorten English navigation/action text and adapt notification forms, binding status and plugin dialogs without dropping explanations or changing business behavior.
- Let installers choose the initial setup language with --language zh-CN|en|auto for Docker/local deployments. Chinese and English README commands pass their respective language; upgrades preserve it. The wizard switches language without losing form inputs, manual browser choices take priority, and normal automatic detection resumes after initialization.
- Add Discord Bot notifications as an alternative to Telegram, which remains the default. Switching preserves each channel's configuration and bindings. Support private binding/unbinding, announcement subscriptions, usage/rules, one-time web login, administrator actions, AI queries/confirmations and host/traffic/expiry/group-switch/rule-error notifications. Adapt Slash Commands, buttons, message limits and rate limits; validate Bot identity before saving, bound interaction queues and reconnect Gateway sessions on timeout. Never reuse Telegram credentials; report private-message delivery failures explicitly.
- Fix forwarding self-tests clearing tunnel runtime status, causing unnecessary reapplication and delaying probes. Probe-only refresh preserves runtime state and configuration versions; configuration edits still use the reapply path. Pending probes retain fast-heartbeat retries during recovery without bypassing readiness checks or hiding failures with longer timeouts.
- Add Simplified Chinese/English UI selection in account menus, login and initial setup. Automatic mode prioritizes browser language, then existing IP-country hints or trusted-proxy country data, without new visitor-location requests. Persist manual browser preferences and localize dates/currency. Add an English README with cross-links; preserve user content and raw diagnostics.
- Fix newly added GOST forwarding-chain rules restarting shared host runtimes and interrupting other chains. The new Agent adds listeners/dependencies through a root-private Unix socket while keeping unchanged rules running. Port conflicts or apply failures roll back only the addition, without restarting the shared process. Initial API activation requires one service restart; edits, deletions and runtime failures retain existing recovery behavior. Older Agents remain compatible.
- Add optional seamless panel migration through the old URL: freeze writes, export a consistent snapshot, preserve IDs/Tokens/ports/runtime state and suppress rebuild/cleanup actions during verification. Do not require Agent/runtime restarts; retain the old database read-only and persist resumable migration state. Both panels must use the same version and database type, the destination must have no business data, and the old URL/forwarding service must remain available. Seamless incremental merging is unsupported.
- Fix standalone host monitoring (default /dev) not requesting live metrics, stalled refresh after hanging requests and transient failures appearing as missing pages. Add isolated requests/timeouts, visibility/network recovery, last-refresh time and manual retry. Preserve previous data on errors, prioritize current metrics in details and avoid excessive chart parameters with long ranges/many services.
- Fix rule category/link filtering shrinking the “All” count and zeroing unrelated badges. Compute category counts independently of category/link selection within the current user/search scope; pagination and summaries still follow the selected link. Keep complete counts during loading rather than estimating from one page.
- Fix probe failure rates being inflated by throttled successful reports. Agents retain bounded cumulative counters; the panel uses monotonic snapshot deltas and ignores duplicate/out-of-order reports. Hop caches still inform health, but are not independent failure samples.
- Distinguish Ping packet loss, TCP connection failures and hop-probe failures with explicit coverage. Do not use legacy sampled rows for accurate failure rates or stability scores; retain their latency curves. Chart smoothing no longer changes stability statistics, and compressed multi-batch counters are no longer truncated.

### Versions and upgrade notes

- Panel, Agent and ForwardX FXP runtime: `3.3.0`. Android and Apple platform integration and package releases are cancelled for this release; existing Android versions are retained.
- Back up databases and custom deployment configuration before upgrading. Google sign-in is disabled by default; Telegram remains the default bot channel. Seamless migration requires the old URL and forwarding service to stay running.
- Upgrade Agents to use incremental GOST additions. Initial API activation restarts the shared runtime once; subsequent additions can retain unchanged listeners. Edits, deletions and recovery may still rebuild runtimes.


## [3.2.5] - 2026-10-07

### Fixes and changes

- Integrate all upstream v2.3.281 product changes while retaining sni-panel installation/update sources and the independent version line.
- Add optional host traffic failover with a 1–100% threshold. Temporarily exclude exhausted hosts from affected paths; restore their original members and ports after a traffic reset or disabling failover. Pause paths with unavailable fixed relays/exits while other healthy SNI domains continue serving.
- Keep pages, static assets and login cookies available during database outages, show sanitized causes and troubleshooting advice, and recover automatically when connectivity returns. Schema/storage failures require repair and restart. Cache verified HTTPS settings in a restricted configuration file so database outages do not make startup fall back to HTTP.
- Make administrator rule creation, copies and imports follow the selected user; “All users” defaults to the administrator. Administrators manage SNI configuration; ordinary owners may toggle/delete their root rules or templates, subject to current eligibility and quotas when re-enabling.
- Count a shared SNI port once. Restoring an existing rule at full quota does not consume another port. Preserve per-item bulk results and prevent bulk edits from bypassing SNI configuration permissions.
- Reset all statistics across every page for the selected user, regardless of search, link filters or selections. Preserve account plan usage, balances and billing records. Available-port hints follow the server's effective policy.
- Retain bounded CAPTCHA/2FA cleanup and adopt upstream regression cases. Failed iperf3 installation only disables network tests, allowing Agent installation to continue. Keep toast colors consistent after theme changes.
- Stop automatically maintaining source-IP allowlists for SNI chain exits and tunnel SNI exits. After an entry IP changes, reachable valid routes no longer wait for the panel to learn the new address and update an exit allowlist.
- Remain compatible with existing Agents/FXP. Normal configuration delivery removes old SNI-marked allow/drop rules from nftables, iptables and ip6tables, including retired ports; verify cleanup and retry failures while retaining unrelated firewall, forwarding and accounting rules.
- Behavior change: any reachable source may directly access an exit's configured SNI domain. SNI domain names do not authenticate clients. Unknown domains and connections without SNI remain rejected; rate limits, connection limits and exit accounting remain active. External direct probes may also increase exit unmatched counters.

### Versions

- Panel/APK release: `3.2.5`; Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.98`.
- Only the panel needs upgrading; existing 3.2.0 Agent/FXP binaries remain compatible.
- Android source advanced to `2.3.98`, but no release APK was produced because the original signing configuration was missing. Panel and amd64 runtime assets were published.

## [3.2.4] - 2026-09-18

### Features and changes

- Add inline rule selection in table and card views, including whole SNI/classification groups. Bulk-replace entry resources (port forwarding, tunnels, chains or groups) and exit targets/ports, or delete selected rules. Entry replacement keeps the original port when possible and fails that item on conflicts, avoiding silent separation of SNI rules sharing one entry port.

### Versions

- Panel/APK release: `3.2.4`; Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.97`.

## [3.2.3] - 2026-09-17

### Features and changes

- Let chain entry dispatchers choose each domain's next hop. Different chains may share one entry host/port; hot additions preserve existing connections on that port.
- Show entry/exit dispatcher state, configuration versions, unmatched connections and errors separately. Chain SNI rules become running only after every related entry and exit confirms the domain is active.
- Add a read-only SNI entry overview grouped by host/port, showing domains, chains, exit hosts, mismatched domain sets and insufficient Agent versions. Panel upgrade confirmation reuses it for entry-Agent version checks.
- Upgrading switches existing chain SNI listeners to entry dispatchers, interrupting current connections on each affected port once. Subsequent routing-table updates remain hot.
- Stop delivering chain entry dispatchers to Agents below the required version and remove old listeners using the Agent's reported local identity/protocol. Kernel forwarding with `both` removes TCP and UDP rules. Deliver enabled entry configurations again after the version requirement is met.

### Versions

- Panel/APK release: `3.2.3`; Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.97`.

## [3.2.2] - 2026-09-15

### Features and changes

- Add a manual Docker upgrade choice with complete commands that preserve existing Compose configuration. Copy the currently selected upgrade method's command.
- Explain that installer upgrades regenerate deployment `docker-compose.yml` and `.env` files.

### Versions

- Panel/APK release: `3.2.2`; Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.97`.

## [3.2.1] - 2026-09-15

### Features and changes

- Add an administrator-only SNI forwarding switch between protocol and source port. Enabling it defaults the entry port to 443, requires an SNI domain, locks TCP and exposes rate/connection limits; disabling it hides the domain field.
- Skip port-occupancy probing while SNI is enabled because rules in one dispatcher share the port. Validate domain uniqueness on the entry host after the domain is entered.
- Allow changing the default entry port when 443 is outside the host policy, occupied by the panel, or an existing dispatcher uses another port. Editing an existing SNI rule preserves its port.
- Disable the switch with an explanation for unsupported resources: forwarding groups, multi-exit/load-balanced tunnels and non-host or multi-host port-forwarding resources. Ordinary users cannot see the switch.
- Default SNI bulk imports to source port 443, with an editable value.

### Versions

- Panel/APK release: `3.2.1`; Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.97`.

## [3.2.0] - 2026-09-14

### Fixes and changes

- Have Agents verify only entry ports used by enabled rules and report each verified port/protocol. Unrelated listeners no longer invalidate the entire occupancy check.
- Correct SNI tunnel exit port lists/listeners and clear occupancy warnings after disabling/deleting rules. Bound listener entries per port and report size.
- Remove host occupancy checks from rule creation, editing, enabling and bulk imports. Show kernel-forwarding conflicts as warnings and user-space bind conflicts as runtime failures.
- Upgrade Agents together with the panel; affected hosts do not show occupancy warnings until upgraded.

### Versions

- Panel/APK release, Agent and ForwardX FXP runtime: `3.2.0`; Android app: `2.3.97`.

## [3.1.0] - 2026-09-13

### Features and fixes

- Have Agents report host listener snapshots. Verify port occupancy when creating, updating or enabling forwarding rules. Kernel forwarding can proceed after confirming a warning; user-space bind conflicts block submission.
- Continuously check existing rule entry ports, show separate card warnings and send enabled Telegram notifications when occupancy appears, changes or clears.
- Show managed-runtime bind failures, avoid known occupied ports during random allocation, and apply the same checks to bulk imports.
- Verify managed listener instances, retain shared SNI entry ports and fix missed kernel-forwarding occupancy reports.

### Versions

- Panel/APK release, Agent and ForwardX FXP runtime: `3.1.0`; Android app: `2.3.97`.

## [3.0.0] - 2026-09-13

### Changes

- Begin independent releases. Installations, upgrades, version checks and GitHub acceleration use `owo10086/sni-panel` assets instead of upstream `poouo/Forwardx` releases.
- Reset panel, Agent and ForwardX FXP runtime versions to `3.0.0`. Panel-only changes advance its patch version; Agent changes advance the panel/Agent minor version together. FXP always follows the Agent.
- Enforce matching panel/Agent major and minor versions and identical Agent/FXP versions in version checks.
- Publish only `linux/amd64` server assets. **arm64 hosts cannot install the Agent**, and the panel image no longer contains arm64 assets.

### Versions

- Panel/APK release, Agent and ForwardX FXP runtime: `3.0.0`; Android app: `2.3.97`.

## [2.3.281] - 2026-09-13

### Fixes and improvements

- Fix dispatchers rejecting TLS ClientHello messages that include ECH while retaining a readable plaintext SNI.
- Include dual-architecture Agent, ForwardX FXP and GOST runtime assets in panel packages, allowing Agents to obtain matching assets from the panel during upgrades.

### Versions

- Panel/APK release: `2.3.281`; Agent: `2.2.195`; ForwardX FXP runtime: `2.2.118`; Android: `2.3.97`.

## [2.3.280] - 2026-09-08

### Fixes and improvements

- Fix two-level link filtering and the main rule list disappearing when opening batch management.
- Improve latency statistics, tunnel port allocation, group member limits and Agent runtime recovery.
- Improve Agent/panel diagnostics and traffic reporting for long-running stability.

### Versions

- Panel/APK release: 2.3.280; Agent: 2.2.195; ForwardX FXP runtime: 2.2.118; Android: 2.3.97.

## [2.3.279] - 2026-09-03

### Fixes and improvements

- Improve heartbeat, traffic, recovery and diagnostic logs across the panel, Agent and FXP, reducing CPU/memory/event-loop pressure during failures.
- Add backpressure, timeouts, deduplication and bounds to SSE, support bundles, logs, caches and queues.
- Optimize SQLite metrics/history cleanup, Agent registration/upgrades and Realm-compatible asset fallback.
- Prevent old failover groups silently inheriting tool or PROXY settings during upgrades; preserve existing member runtime settings.

### Versions

- Panel/APK release: 2.3.279; Agent: 2.2.193; ForwardX FXP runtime: 2.2.117; Android: 2.3.97.

## [2.3.278] - 2026-08-30

### Fixes and improvements

- Fix FXP multi-exit failover, connection limits and tunnel recovery so one problematic entry does not affect an entire path.
- Fix forwarding-group tool/PROXY inheritance and stale nftables/iptables cleanup when switching tools.
- Improve asset/runtime installation and upgrade validation for Agent/FXP and Realm/GOST/Nginx, preserving working binaries when candidates fail.
- Stop generating obsolete transport options incompatible with Realm 2.9.x.
- Improve latency details, local development and Agent/FXP state synchronization.

### Versions

- Panel/APK release: 2.3.278; Agent: 2.2.192; ForwardX FXP runtime: 2.2.116; Android: 2.3.97.

## [2.3.277] - 2026-08-23

### Fixes and improvements

- Fix local development proxies, automatic sign-in and shutdown cleanup to reduce disconnect noise.
- Improve Agent/FXP state, traffic/connection counters and rule recovery.
- Fix whitelist-plugin nftables error handling; improve login challenges and installation/upgrade scripts.

### Versions

- Panel/APK release: 2.3.277; Agent: 2.2.191; ForwardX FXP runtime: 2.2.115; Android: 2.3.97.

## [2.3.276] - 2026-08-14

### Added

- Add interactive local/container administrator password-reset commands that revoke existing sessions.

### Fixes and improvements

- Harden disabled accounts, 2FA, Telegram login, payment callbacks, billing and concurrent port allocation.
- Optimize port policies, logs, state caches and Agent/FXP scheduling to reduce CPU, memory and process use.
- Fix traffic-cycle boundaries, multi-range port policies, loopback validation, custom HTML, Markdown links and capacity display.

### Versions

- Panel/APK release: 2.3.276; Agent: 2.2.190; ForwardX FXP runtime: 2.2.114; Android: 2.3.97.

## [2.3.275] - 2026-08-13

### Fixes and improvements

- Restore failover members by priority and switch back to higher-priority recovered members.
- Preserve previous state during rule-page refresh and fix ordinary-user entry-domain inconsistencies.
- Add GitHub download acceleration, installer support, deployment documentation and upgrade verification.

### Versions

- Panel/APK release: 2.3.275; Agent: 2.2.189; ForwardX FXP runtime: 2.2.113; Android: 2.3.97.

## [2.3.274] - 2026-08-09

### Added

- Support multiple simultaneous plans, combined entitlements and separate plan/manual/add-on traffic display.

### Fixes and improvements

- Fix resource reclamation, cycle display and Agent refresh after plan expiry, resets and renewals.
- Fix Agent/FXP traffic/connection accounting and improve UDP buffer cleanup and offline heartbeat retries.

### Versions

- Panel/APK release: 2.3.274; Agent: 2.2.188; ForwardX FXP runtime: 2.2.113; Android: 2.3.97.

## [2.3.273] - 2026-08-07

### Added

- Add resource speed limits to port forwarding, chains and groups across GOST, ForwardX, iptables, nftables, Realm, Socat and Nginx.

### Fixed

- Fix Agent offline decisions and DDNS failover delays, with bounded retries on failed transitions.
- Fix listener handover, restart recovery and state synchronization for ForwardX, mimic and failover.
- Fix monthly plan reset days, subsequent traffic cycles and recovery after over-quota suspension.
- Fix truncated long-range host latency charts, shifted time axes and initial display state.
- Allow deleting saved AI API keys.

### Versions

- Panel/APK release: 2.3.273; Agent: 2.2.187; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.272] - 2026-08-04

### Fixed

- Fix a WireGuard UDP shutdown deadlock between queue cleanup and the write loop.
- Fix older nftables parsing, forwarding-chain accepts and missing fallback after MASQUERADE failure.

### Versions

- Panel/APK release: 2.3.272; Agent: 2.2.186; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.271] - 2026-08-04

### Fixed

- Fix incomplete signed paths under mounted Agent/FXP report routes causing repeated 401 responses, and lost forced refreshes during busy probes.
- Repair confirmable historical group child/member/deletion leftovers that hide rules or block host deletion.
- Fix tunnel probe success reported with only exit results, stale results for missing first hops, tunnel timeout state and total latency display.
- Fix the WireGuard UDP queue-cleanup/write-loop shutdown deadlock.
- Fix older nftables parsing, forwarding-chain accepts and missing MASQUERADE fallback.

### Versions

- Panel/APK release: 2.3.271; Agent: 2.2.186; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.270] - 2026-08-04

### Fixed

- Stop reusing stale Agent/FXP processes after upgrades/configuration changes when forwarding works but traffic reports do not.
- Fix missing short-lived GOST/process connections leaving 24-hour counts at zero.
- Add FXP traffic-report throttling diagnostics and idempotent failed-batch retries.
- Fix early GOST/ForwardX UDP session closure and interrupted rebuilt sessions; reduce high-packet-rate overhead and bound queues/fragments.
- Use one bounded heartbeat retry queue and cancel retries immediately after any successful heartbeat.
- Fix pending-cleanup rules blocking Token deletion; show owning users for genuine rule conflicts.

### Versions

- Panel/APK release: 2.3.270; Agent: 2.2.184; ForwardX FXP runtime: 2.2.112; Android: 2.3.97.

## [2.3.269] - 2026-08-02

### Fixed

- Fix ordinary-user group traffic/connection ownership and cumulative Agent/FXP connection counts.
- Fix repeated restarts or counting interruptions during access-limit and TCP/UDP counting-chain recovery.
- Fix entry-port false conflicts and concurrent allocation during batch imports, copies and cross-group moves.
- Fix misleading “waiting for probe” tunnel segments and exit-group wording.

### Versions

- Panel/APK release: 2.3.269; Agent: 2.2.183; ForwardX FXP runtime: 2.2.111; Android: 2.3.97.

## [2.3.268] - 2026-08-01

### Added

- Separate plan and usage-billed traffic statistics and reset display baselines.
- Add custom-menu panel routes, embedded pages and new-window modes.
- Add tunnel/multi-entry latency details and troubleshooting screenshots.

### Fixed

- Fix Agent/FXP recovery/listener validation after restarts, upgrades and V1/V2/WireGuard/GOST transitions.
- Preserve firewall counters and avoid duplicate cleanup/count loss during recovery and rule repair.
- Fix topology matching, concurrent refresh, timeouts and stale-result reuse in tunnel/chain/multi-entry probes.
- Fix latency-node attribution, ordinary-user traffic display and custom-menu embedding.

### Versions

- Panel/APK release: 2.3.268; Agent: 2.2.182; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.267] - 2026-08-01

### Fixed

- Prevent payment callbacks reactivating closed orders, and enable PostgreSQL TLS certificate validation.

### Versions

- Panel/APK release: 2.3.267; Agent: 2.2.181; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.266] - 2026-07-30

### Added

- Allow correcting host cumulative traffic to a specified actual value.

### Fixed

- Fix six native GOST transports, UDP-only rule protocols and multi-hop relay authentication.
- Fix stale FXP state/authentication after switching to GOST, with transactional handover, rollback and recovery.
- Fix ordinary-user rule isolation and returning from empty filtered results.

### Improved

- Adjust host card/list actions, remove instantaneous traffic animations and clarify Token creation times.

### Versions

- Panel/APK release: 2.3.266; Agent: 2.2.181; ForwardX FXP runtime: 2.2.110; Android: 2.3.97.

## [2.3.265] - 2026-07-30

### Fixed

- Stabilize Agent handover, listener readiness and recovery between ForwardX V1/V2, WireGuard and GOST/Nginx.
- Support independent host port ranges per chain member; fix synchronization rollback, probes and traffic ownership.
- Verify Docker images and running versions before reporting a successful upgrade.
- Build/verify native amd64/arm64 images before merging manifests to avoid missing ARM64 images after QEMU failures.
- Fix occasional duplicate tunnel-latency queries at timeout boundaries.

### Versions

- Panel/APK release: 2.3.265; Agent: 2.2.180; ForwardX FXP runtime: 2.2.110; Android: 2.3.96.

## [2.3.264] - 2026-07-29

### Added

- Support drag/drop or multi-file upload of Nginx Stream PEM certificate chains and private keys.

### Fixed

- Fix memory, connection and stale-state cleanup for V1/V2 sessions, queues, handshakes and rule replacement.
- Fix Nginx Stream TCP long-connection timeouts, entry certificates and stale-certificate cleanup; add session diagnostics.

### Improved

- Optimize large merged V1/V2 entry configurations to reduce Agent CPU/GC overhead.
- Improve Token notes and standardize tunnel probe timeout messages.

### Validation

- Type checks, frontend build, Agent/FXP tests, race tests and go vet passed.

### Versions

- Panel/APK release: 2.3.264; Agent: 2.2.179; ForwardX FXP runtime: 2.2.110; Android: 2.3.96.

## [2.3.263] - 2026-07-29

### Fixed

- Fix stale state, incorrect cleanup and unready WireGuard peers with FXP multi-entry and mixed V1/V2.
- Stabilize group health switching against brief timeouts and panel communication fluctuations.
- Fix inconsistent permissions during revocation, migration and usage billing, and prevent stale cleanup deleting a new rule on the same port.
- Separate port-forwarding and network-test host permissions; hide unauthorized underlying hosts.
- Preserve last valid domain addresses on expiry/DNS failures to avoid repeated resolution and runtime churn.
- Fix duplicate, mixed or missing traffic accounting across iptables, nftables, Realm, Socat, GOST, Nginx and ForwardX.
- Reduce firewall counter scanning/rebuilds with large rule sets, DNS changes and Agent restarts; support Alpine/BusyBox.

### Validation

- Server tests 427/427, Agent/FXP tests, types, production and documentation builds passed. Docker builds were not run.

### Versions

- Panel/APK release: 2.3.263; Agent: 2.2.178; ForwardX FXP runtime: 2.2.109; Android: 2.3.96.
