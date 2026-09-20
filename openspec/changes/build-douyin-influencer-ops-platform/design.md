## Context

See `proposal.md` for the product motivation and scope. The current repository is a single CommonJS Playwright script that searches fixed Douyin keywords, keeps one local browser profile, and writes CSV, JSON, HTML, and screenshots to the operator's computer. It has no shared identity, database, API, background jobs, or durable review workflow.

The target environment consists of an Ubuntu 24.04 server with 2 CPU cores, 4 GB memory, and 1 Mbps public bandwidth, an Alibaba Cloud RDS MySQL 8.0 instance, a private Alibaba Cloud OSS bucket, a company domain, and Windows operator computers. Douyin login state and recommendation profiles are device-local and may require visible human interaction for login or CAPTCHA.

The implementation must therefore separate browser collection from shared operations, keep server resource usage modest, avoid routing large media through the server, and remain useful when Douyin parsing is temporarily unavailable.

## Goals / Non-Goals

**Goals:**

- Define a modular architecture that can be delivered incrementally without discarding the useful parsing and Playwright behavior in the current script.
- Keep Douyin credentials, cookies, and recommendation-feed profiles on operator computers while centralizing normalized public observations and evidence without exposing one operator's working set to another.
- Give every screening run a reproducible rule snapshot, idempotent ingestion, and auditable human decisions.
- Fit the central application and worker comfortably on the existing 2-core/4-GB host by relying on RDS and OSS for state and storage.
- Isolate platform-specific code so later adapters do not force a rewrite of the core domain.

**Non-Goals:**

- Running authenticated Douyin browsers on the Ubuntu server.
- Hiding automation from Douyin, bypassing CAPTCHA, or automating likes, follows, comments, private messages, or “not interested” actions.
- Building a general-purpose CRM, a public multi-tenant SaaS product, or a video archive in the first version.
- Treating missing or unparseable public data as verified facts or automatic rejection grounds.

## Decisions

### 1. Use a TypeScript modular monolith with a separate local collector

The repository will become an npm-workspaces project with four primary units:

- `apps/web`: a React management interface built as static assets.
- `apps/api`: a Fastify HTTP API that serves domain operations and authentication.
- `apps/worker`: a separate Node.js process importing the same domain services for durable maintenance tasks such as media cleanup.
- `apps/collector`: a Windows-oriented Node.js/Playwright companion that opens visible Chrome with a per-profile persistent data directory and exposes a small local control/status page.
- `packages/contracts`, `packages/domain`, and `packages/platform-douyin`: shared schemas, business logic, and the Douyin adapter boundary.

The production web assets are served by the reverse proxy, while API and worker run as separate containers with explicit memory and concurrency limits. The collector is distributed as a versioned Windows bundle with its own Node runtime and launcher so colleagues do not need to configure a development checkout.

This keeps one language across existing Playwright code, API contracts, validation, and UI while avoiding the memory overhead and deployment complexity of separate microservices. A desktop-only application was rejected because it cannot provide a reliable shared source of truth. Server-side Playwright was rejected because it centralizes sensitive login state, loses each operator's recommendation profile, and makes manual CAPTCHA handling awkward. Electron was rejected for the first collector release because a local control page and visible Chrome meet the need with a smaller package and lower idle memory.

### 2. Keep the central platform authoritative, but require local human start for collection

An administrator or operator creates a screening campaign and a run in the web application. An authorized collector polls for compatible ready runs, but it does not start browsing remotely. The local operator chooses a browser profile and explicitly starts the run. This preserves human control over the account currently being trained and prevents an unattended server action from operating a Douyin account.

The collector obtains only the immutable run configuration and upload grants it needs. It submits observations in batches with a device ID, run ID, client-generated idempotency key, collector version, and parser version. The API acknowledges individual records, allowing safe retry after network loss. Cookies, local-storage state, browser-profile files, and passwords are excluded from every request schema and log field.

A fully push-controlled collector was rejected because it could operate the wrong local account or run when no human is available to handle a platform prompt.

### 3. Model screening configuration as versioned, typed rules

Reusable templates and campaigns store rules as validated JSON with a schema version. Creating a run copies the effective configuration into an immutable rule-version record. The first template contains:

- hard rules: follower range 0–5,000; at least one observed post published within the rolling prior 15 days with at least 10,000 likes;
- optional manual content-fit checks, with no default content-category restriction;
- run safety settings: maximum feed items, maximum creator profiles, pacing range, and maximum duration.

The rule engine returns `pass`, `fail`, or `unknown` per rule plus machine-readable evidence. Missing or unparseable values produce `unknown`, never zero. Manual checks may rank or annotate a candidate but cannot silently delete it. Evaluation records point to the exact rule version and observation IDs used.

Hardcoding fields in database columns was rejected because the user's screening criteria will change. Unvalidated arbitrary JSON was rejected because it makes old runs impossible to interpret consistently. A versioned schema permits new rule types and migrations while preserving history.

### 4. Store canonical identities separately from append-only observations

All shared business rows carry a `workspace_id`, even though the first deployment bootstraps one company workspace. The central data model is organized as follows:

- access: `workspaces`, `users`, `invitations`, `memberships`, `sessions`, `devices`, and `audit_events`;
- screening: `campaign_templates`, `campaigns`, `campaign_rule_versions`, `collection_runs`, and `run_devices`;
- public source data: `creators`, `creator_observations`, `posts`, and `post_observations`;
- decisions: `campaign_candidates`, `rule_evaluations`, `manual_reviews`, `outreach_records`, and `candidate_events`;
- infrastructure: `media_objects` and `ingestion_keys`.

`creators` and `posts` use unique `(platform, platform_object_id)` identities. Mutable public counts and profile text live in timestamped observations rather than overwriting the canonical row. A campaign candidate is unique by campaign and creator, but may have many source runs and evidence links. This lets the team deduplicate one creator without losing when, where, or why the creator was rediscovered.

Canonical identity is not an authorization boundary. Candidate visibility is derived from durable source relationships between observations, runs, devices, and the device owner, plus explicit candidate assignment. A creator may therefore have one canonical row while being visible to multiple operators through separate ownership relationships. Operator-facing queries and mutations restrict observations, sources, evidence, outreach data, exports, and signed media access to the caller's relationship; administrators can inspect the merged history.

Deleting a campaign removes its associations according to retention policy but does not erase a canonical creator, shared observation, audit event, or media still referenced elsewhere. Sensitive outreach fields receive stricter role checks than public creator metadata.

An overwrite-only creator table was rejected because like and follower changes would destroy the evidence behind an earlier decision. Copying a complete creator per campaign was rejected because it fragments team knowledge and contact history.

### 5. Upload evidence directly to private OSS

The API creates short-lived, object-specific signed PUT grants after validating the device, run, MIME type, and maximum size. The collector uploads screenshots directly to private OSS and then confirms the object key, checksum, byte size, and related observation. The API issues short-lived signed GET URLs only after an authenticated authorization check.

Object keys use opaque workspace/run identifiers rather than usernames or captions. Database records, not bucket listing, are the source of truth. Lifecycle rules remove unconfirmed uploads and later archive or expire evidence according to a configurable retention period. Full video upload is excluded.

Proxying screenshots through the 1 Mbps server was rejected because it would consume the host's narrow public bandwidth and increase request timeouts. Public-readable OSS objects were rejected because screenshots can contain personal information and internal annotations.

### 6. Use invite-only web sessions and scoped device credentials

The first administrator is created by an explicit bootstrap command. Further users join through expiring, single-use invitations; there is no public registration route. Passwords use Argon2id, browser sessions use secure, HTTP-only, same-site cookies, state-changing browser requests require CSRF protection, and authorization is enforced in domain services rather than only in the UI.

Collectors pair through a short-lived code shown to a signed-in operator. The resulting device token is displayed once, stored locally with operating-system file permissions, and stored only as a hash on the server. It is scoped to collector APIs, revocable, rotatable, and never accepted as a browser session. Administrator, operator, and read-only roles are checked at both route and record-field level. Important access, configuration, review, outreach, export, and credential events create append-only audit records.

Reusing user passwords or long-lived browser cookies in the collector was rejected because compromise of one operator computer would expose broader account access.

### 7. Isolate Douyin behavior behind a confidence-aware platform adapter

The Douyin package owns selectors, URL normalization, count parsing, observation mapping, and parser diagnostics. The collector captures a feed item, opens its creator profile when needed to verify follower and recent-post evidence, paces navigation within the run limits, and emits only normalized observations plus bounded diagnostic metadata.

If required page structure is unknown or parsing confidence falls below the adapter threshold, the collector does not guess missing values and does not submit that page. A recommendation-feed pass that temporarily finds no new post or author is treated as the same configurable parsing/no-progress condition rather than a separate fixed pause threshold. The local operator can choose to pause after N consecutive unrecognized or low-confidence passes or to keep scrolling and skipping them indefinitely; only discovering a previously unseen post resets the no-progress count.

Under the never-pause policy, sustained no-progress first scrolls the actual scrollable content ancestor (falling back to the document scroller) instead of assuming a mouse wheel event reached the feed. If no unseen post appears after a bounded number of passes, the collector reloads only the current Douyin recommendation page and retries with a capped progressive backoff. Existing post IDs remain deduplicated across recovery attempts, so reloading cannot fabricate progress or duplicate observations. Login/CAPTCHA prompts, explicit abnormal pages, non-Douyin navigation, and platform limits still pause immediately and are never bypassed.

The collector persists bounded local diagnostics and exposes the consecutive failure count, total skipped count, latest reason, and recovery status. DOM fixtures and sanitized stored HTML fragments support parser tests without live requests. Platform-neutral contracts keep later Xiaohongshu or Kuaishou adapters separate from screening and review logic.

Creator-profile verification captures public post-list responses emitted while the visible profile page loads and normalizes `aweme_id`, `statistics.digg_count`, and `create_time` through the Douyin adapter. It merges that evidence with DOM-extracted post cards by stable post ID, preferring non-null API metrics while retaining DOM captions and links as a fallback. Response parsing is restricted to the expected Douyin origin and profile-post endpoint; malformed, cancelled, or structurally unknown responses are ignored. When neither source provides a trustworthy like count or publication time, the field remains unknown rather than being inferred from the post ID or visual position.

Each active browser context keeps one dedicated visible creator-verification tab alongside the recommendation-feed tab. The collector navigates that same tab to each next creator URL and brings it to the foreground after navigation so an operator can watch profiles change without repeatedly selecting newly created tabs. It creates a replacement only if the operator manually closes the verification tab, and closes both tabs only with the surrounding browser context.

Submitting observations after selector failures was rejected because plausible but incorrect counts would poison the shared candidate library. Always pausing after the first isolated low-confidence profile was also rejected because one unusual account would unnecessarily stop an unattended run even when later pages remain parseable.

### 8. Deploy a small-container topology on the existing Ubuntu server

Production uses Docker Compose with a TLS reverse proxy, API container, worker container, and static web assets. RDS and OSS remain managed external services. The collector never runs in these containers. Configuration and secrets are provided through protected environment files or a secret manager; images contain no production credentials.

The reverse proxy terminates HTTPS, applies request-size and basic rate limits, and exposes only ports 80 and 443. If the server and RDS can share a VPC, the application uses the RDS private endpoint. Otherwise, the RDS public endpoint is temporarily restricted to the server's stable egress IP, TLS is required, and the database account is limited to the application schema. RDS is never opened to all source addresses.

Health endpoints distinguish process liveness from readiness of MySQL and OSS. Structured logs include request, run, device, and candidate correlation IDs without secrets. Database migrations run as a controlled release step, not automatically from every replica. RDS backups and OSS versioning/lifecycle policy are complemented by a documented restore drill.

Vercel was rejected for this version because the workflow includes durable workers and large direct-upload coordination, while access to an allowlisted public RDS from changing serverless egress would add cost or network complexity. A single non-containerized process was rejected because API and worker failures and resource limits would be harder to isolate and roll back.

### 9. Protect concurrent human work with optimistic versioning and event history

Candidate review and outreach records include a version number. Mutations require the last-read version and return a conflict with the current record when another operator has updated it. Status changes append an event containing actor, previous and next status, timestamp, and changed fields. Notes are additive entries instead of one shared free-text blob.

Silent last-write-wins behavior was rejected because multiple colleagues can review or contact the same creator at the same time.

### 10. Separate canonical deduplication from member-scoped creator views

The platform keeps one canonical creator and append-only observation history, but resolves an explicit record scope for every candidate operation. Administrators receive the workspace-wide scope. Operators and read-only members receive the union of creators collected by devices they own and creators explicitly assigned to them; read-only members keep the same row scope but cannot mutate records. This scope is applied in domain queries used by lists, counters, details, exports, media grants, reviews, and outreach mutations so a guessed identifier cannot bypass the UI.

For an operator, the stable classification date is the earliest source observation attributable to that operator, not the latest global observation. For an assigned-only creator it is the assignment time. Administrator views can group by the selected operator's corresponding date. The API exposes bounded date-range filters and cursor pagination; the web UI provides today, yesterday, recent-range, and custom-range controls and groups the returned page in the business timezone. This prevents old creators from jumping to the newest group after recollection and avoids loading an unbounded library.

Duplicating the full creator row per operator was rejected because it would fragment identities and evidence. Using only the latest observation's device owner was rejected because ownership would flip whenever another operator recollects the account. Filtering only in React was rejected because direct detail, export, media, and mutation endpoints would still leak data.

### 11. Preview private evidence inside an accessible zoomable lightbox

After an authorized member requests the existing short-lived signed GET address, the creator detail page renders the evidence screenshot as an interactive preview. Activating it opens a viewport-sized modal that supports bounded zoom in/out, reset, mouse-wheel zoom, Escape/backdrop close, and keyboard-operable controls. Opening the preview reuses the already authorized short-lived address; the UI neither persists a permanent OSS URL nor broadens the media authorization boundary.

Opening a raw image in a new browser tab was rejected because it breaks review context and makes repeated evidence inspection cumbersome. Adding a large image-processing dependency was rejected because client-side display scaling is sufficient and keeps the web bundle and attack surface smaller.

## Risks / Trade-offs

- [Douyin changes page structure or limits automated browsing] → Keep selectors in one adapter, pace conservatively, test against fixtures, fail closed, surface parser/version diagnostics, and require human handling of platform prompts.
- [Platform terms or account-safety rules constrain collection] → Collect only publicly visible data under authenticated human control, forbid automated interaction and CAPTCHA bypass, expose run limits, and let the operator stop immediately. The company remains responsible for confirming permitted use.
- [The 2-core/4-GB/1-Mbps host becomes constrained] → Keep browsers off-server, upload directly to OSS, start with low worker concurrency and container limits, and measure latency, memory, and disk before scaling.
- [RDS public access expands attack surface] → Prefer a same-VPC private endpoint; until then use a narrow IP allowlist, TLS, least-privilege credentials, audit, and an explicit deployment check that rejects an unrestricted allowlist.
- [A lost operator computer exposes collection access] → Scope and hash device tokens, support immediate revocation, exclude browser cookies from sync, and audit device activity.
- [Old collectors submit incompatible payloads] → Version contracts and parsers, advertise minimum supported versions, reject unsafe incompatibilities with an upgrade message, and allow backward-compatible server changes during staged rollout.
- [Observation and screenshot retention grows indefinitely] → Configure retention and OSS lifecycle rules, deduplicate by checksum where safe, and report storage growth before deletion jobs run.
- [Two operators overwrite review or outreach work] → Use optimistic versions, additive notes, and append-only transition history.
- [A member accesses another operator's creator through a guessed ID or secondary endpoint] → Resolve record scope in shared domain authorization and apply it consistently to list, detail, export, media, review, and outreach paths; cover every path with cross-member tests.

## Migration Plan

1. Convert the repository to the workspace layout while preserving the existing script and its output directories as a legacy tool until collector parity is verified.
2. Add versioned MySQL migrations and seed the single workspace, role definitions, default screening template, and first administrator bootstrap path in a non-production database.
3. Configure private OSS CORS, lifecycle rules, service credentials, and signed upload/download flows; verify that media traffic does not traverse the application server.
4. Deploy reverse proxy, web, API, and worker containers to a staging hostname; connect to RDS with TLS and preferably its private address; run security, backup, and restore smoke tests.
5. Pair one Windows collector, import or reference its persistent browser profile, and run an internal dry run with strict item/time limits. Compare collected counts and evidence against manual inspection.
6. Pilot with a small operator group, verify administrator-wide and member-scoped record access, then enable invitations, scoped review, outreach tracking, and exports for the wider team.
7. Optionally import existing JSON/CSV results and screenshots as a clearly labeled legacy run; missing fields remain unknown and no conclusion is fabricated.
8. Remove the legacy script from the normal workflow only after the central candidate count, evidence links, pause/resume behavior, and retry recovery have passed acceptance checks.

Rollback keeps the previous container images and reverse-proxy configuration available. Application rollback is permitted only while its code remains compatible with the applied database migration. Database migrations use expand/migrate/contract sequencing; destructive contract steps occur in a later release after rollback data has been backed up. Collector rollout is staged, and the server supports the immediately previous compatible protocol during transition.

## Open Questions

- Whether the Ubuntu server and RDS instance can communicate through the same Alibaba Cloud VPC; this determines private versus tightly allowlisted public database addressing, not the application architecture.
- The production domain, OSS region/bucket, RDS endpoint, and certificate/DNS values to insert into deployment configuration.
- The desired evidence retention duration and the approximate initial number of operators, which tune lifecycle and concurrency defaults without changing the workflow.
