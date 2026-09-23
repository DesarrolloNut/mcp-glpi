# Changelog

## 3.4.0 — 2026-09-23

### Added

- **Enterprise Security Hardening**:
  - **Upload Path Sandbox (`src/path-security.ts`)**: restricts `glpi_upload_document` to `GLPI_ALLOWED_UPLOAD_DIR` (or local working directory). Canonical `realpath` resolution prevents path traversal (`../`) and symlink directory escapes. Strict blocklist for hidden files (`.env`, `.git`) and sensitive credentials (SSH keys, AWS credentials), plus an allowlist of permitted business file extensions (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.txt`, `.csv`, `.xlsx`, `.docx`, `.zip`).
  - **Generic Itemtype Sanitization (`src/itemtype-security.ts`)**: strict validation (`/^[a-zA-Z0-9_]{1,100}$/`) on user-supplied entity/itemtype inputs preventing endpoint injection and directory traversal attacks.
  - **HTTPS Transport Enforcement (`src/config.ts`)**: mandates `https://` for `GLPI_URL` to protect authentication tokens and credentials in transit. Requires explicit `GLPI_ALLOW_HTTP=true` for unencrypted local development/testing.
  - **Mutation Input Validation (`src/schemas.ts`)**: strict Zod validation schemas applied to all mutating operations (tickets, followups, tasks, solutions, assignments, document links, validations) with bounded string lengths and type coercion.
- **Native HTTP/SSE Remote Server (`src/sse-server.ts`)**:
  - Dual-transport architecture: automatic HTTP/SSE listener when `PORT` or `MCP_TRANSPORT=sse` is configured, with zero breaking changes to existing local `stdio` usage.
  - Built exclusively with native Node.js (`node:http`) without third-party web frameworks, adhering to native code standards.
  - Endpoints: `GET /sse`, `GET /mcp`, and `GET /` for SSE connection negotiation; `POST /messages` for JSON-RPC dispatch; `GET /health` for container and reverse-proxy health checks.
  - Perimeter authentication: optional `MCP_AUTH_TOKEN` protecting SSE and message endpoints via `Authorization: Bearer <token>` or `?token=<token>`.
  - Full CORS headers support for browser-based and remote AI web interfaces (LibreChat, Open WebUI, Dify, custom agent dashboards).
- **Production Containerization**:
  - Multi-stage `Dockerfile` (`builder` and `runner` using `node:22-alpine`).
  - Runs under unprivileged non-root user (`USER node`).
  - Dedicated `/app/uploads` sandbox directory.
  - Built-in `HEALTHCHECK` probe targeting `http://127.0.0.1:3000/health`.
  - Comprehensive `.dockerignore` for minimal, secure image footprints.
- **Automated Security & Transport Test Suite**:
  - 4 new test suites: `test/security-path.test.ts`, `test/security-itemtype.test.ts`, `test/security-config.test.ts`, and `test/security-sse.test.ts`. Total test coverage increased to 35 passing tests.

## 3.3.0 — 2026-08-05

### Added

- **`glpi_upload_document`**: upload a local file as a GLPI Document via
  multipart `POST /Document` (`uploadManifest` + `filename[0]`), with an
  optional `ticket_id` that links the document to the ticket in the same
  call. The link is declared inside the manifest (`itemtype`/`items_id`) so
  it also works for restricted profiles (e.g. Self-Service requesters) that
  cannot `POST Document_Item` directly. MIME type is derived from the file
  extension.
- `form` option in the HTTP layer (`GlpiHttp.request`) for multipart bodies:
  the JSON `Content-Type` is omitted so `fetch` can set the boundary. Note
  the manifest must be appended as a plain string field — parts carrying a
  filename land in PHP's `$_FILES` and GLPI reads the manifest from `$_POST`.
- Tests: multipart header handling, manifest/file pair building, manifest
  item linking, and default document naming (`test/upload.test.ts`).

## 3.2.0 — 2026-07-04

### Added

- **MCP tool safety annotations** on all 84 tools (fixes #3, AgentSeal findings):
  - `readOnlyHint: true` on every list/get/search/count/stats tool (56 tools).
  - `destructiveHint: true` on delete/update/set/assign tools (9 tools) —
    agents now get an explicit signal before invoking `glpi_delete_ticket`,
    `glpi_delete_computer`, `glpi_update_*`, etc.
  - `idempotentHint` and `openWorldHint: false` everywhere (tools only reach
    the configured GLPI instance).
  - Annotations are derived from the tool name, so future tools are
    annotated automatically.
- **Live smoke test** (`npm run smoke`, `npm run smoke -- --write`):
  23 checks against a real instance — session, SearchOptions cache, field
  resolution, count/search/stats, timeline, users/computers/groups/entities,
  and an optional write cycle (create test ticket → followup → rename →
  soft delete → verify trash). Reads credentials from env or `.env`
  (gitignored). Validated against GLPI 11 (French locale).

### Fixed

- **Search off-by-one**: `search()` passed `limit` as the range end, but GLPI
  ranges are inclusive — `limit: 5` returned 6 rows. Affected `glpi_search_v2`,
  `glpi_search_tickets`, `glpi_count`-adjacent paths and the active-users
  filter. Found by the live smoke test.
- **`resolveField` failed on localized instances**: friendly-name resolution
  only matched the translated label ("Statut" on a French GLPI), so
  `resolveField('Ticket', 'status')` returned undefined. Resolution now tries,
  in order: explicit uid → canonical own-table uid (`Ticket.status`) →
  localized label → raw SQL column name, with own-table priority on column
  collisions (e.g. `name` exists on both glpi_tickets and joined glpi_users).

## 3.1.0 — 2026-07-04

Reliability hardening after the v3.0.0 audit.

### Added

- **Request timeouts**: every HTTP call (including `initSession`) is wrapped in
  an `AbortController` with a configurable timeout (`GLPI_TIMEOUT_MS`, default
  15 s). A hung GLPI backend can no longer block the MCP server indefinitely.
- **Retry on `429` and network errors**: rate-limited responses honour the
  `Retry-After` header; transient network failures (ECONNRESET, timeouts) are
  retried with the same exponential backoff as `5xx`.
- **Runtime input validation (zod)** on ticket tools (`glpi_list_tickets`,
  `glpi_get_ticket`, `glpi_search_tickets`): invalid arguments now return a
  clear `InvalidParams` MCP error instead of failing downstream in GLPI.
- **Differentiated MCP errors**: zod validation → `InvalidParams`;
  `GlpiError` → message with HTTP status + GLPI code; everything else →
  `InternalError`.
- **Config validation at startup**: `GLPI_URL` must be a valid URL and an
  authentication method must be configured — fail fast with a clear message.
- **Debug logging** (`GLPI_DEBUG=1`): retries, re-authentication and
  rate-limiting events are logged to stderr (stdout stays reserved for the MCP
  stdio transport).
- **Resilient startup**: if GLPI is unreachable when the server starts, a
  warning is logged and the session is established lazily on the first request
  (previously the server exited immediately).
- New env vars: `GLPI_TIMEOUT_MS`, `GLPI_MAX_RETRIES`, `GLPI_DEBUG`.
- 3 new HTTP-layer tests (timeout abort, 429 retry, network-error retry) — 7 total.

## 3.0.0 — 2026-06-08

Major overhaul focused on the foundations and on ITSM/reporting coverage.

### Added

- **Unified HTTP layer** (`src/http.ts`) with:
  - Automatic re-authentication on `401` (expired `session_token`).
  - Exponential-backoff retry on `5xx`.
  - Structured `GlpiError` exposing HTTP status + GLPI error code/message + body.
- **Multi-criteria search** via the new high-level `GlpiSearch` (`src/search.ts`):
  - Array of criteria with `link` operator (`AND` / `OR` / `AND NOT` / `OR NOT`).
  - `forcedisplay` to choose returned columns.
  - Pagination via `start`/`limit`, `fetch_all` with `max_rows` safety cap (default 1000).
  - Reads `totalcount` and `Content-Range` header.
- **`SearchOptionsCache`** (`src/search-options.ts`): caches
  `/listSearchOptions/{itemtype}` (TTL 1h) so high-level tools translate
  friendly names ↔ `field_id` resilient to GLPI version drift.
- **New MCP tools**:
  - `glpi_count` — cheap totalcount probe (range=0-0) with criteria.
  - `glpi_search_v2` — multi-criteria search; `glpi_search` kept as deprecated alias.
  - `glpi_list_search_options` — discover field ids of an itemtype.
  - `glpi_search_tickets` — friendly params (status, assigned_user/group,
    requester, category, entity, priority, urgency, date_from/to, text_search,
    open_only) translated to criteria internally.
  - `glpi_get_ticket_timeline` — merged followups + tasks + solutions +
    validations, sorted chronologically.
  - `glpi_tickets_stats_by(dimension, period)` — counts ventilated by
    status / category / technician / entity / month.
  - `glpi_link_tickets` — Ticket_Ticket relations (link / duplicate / parent).
  - `glpi_add_ticket_validation`, `glpi_set_validation_status`,
    `glpi_get_ticket_validations`.
  - `glpi_attach_document_to_ticket`, `glpi_get_ticket_documents`.
  - `glpi_get_ticket_satisfaction`, `glpi_list_overdue_tickets`.
  - `glpi_get_ticket_solutions`.
  - Symmetric `update`/`delete` on Monitor, Phone, Printer, Software,
    NetworkEquipment (parity with Computer).
- **`expand_dropdowns=true` by default** on all detail reads — foreign-key IDs
  come back resolved (technician name, category label, entity, etc.) while raw
  IDs remain available alongside.
- **Tests**: minimal integration tests using `node --test` + `tsx` (HTTP layer,
  re-auth, retry, error parsing).

### Fixed

- **F9** — Ticket and asset stats no longer fetch up to 9999 rows just to count
  them: they now use criteria + `range=0-0` totalcount probes. Accurate beyond
  10 k tickets, much faster.
- **F10** — `glpi_list_users` `active_only` filter previously used `searchText`
  (LIKE on a label column), which silently mismatched. Now uses the search
  endpoint with `criteria=is_active equals 1`.
- **F12** — `glpi_assign_ticket` ignored `group_id`. It now routes to
  `Group_Ticket` when a group is provided, and `Ticket_User` for a user.
- `glpi_search_knowbase` no longer hard-codes `field=6` for the title; the
  field id is resolved via `listSearchOptions/KnowbaseItem`.

### Changed (breaking)

- **`GlpiClient` constructor**: same shape (`GlpiConfig`) but the internal
  fetch/session/error layer is now `GlpiHttp`. Public domain methods keep
  their v2 names; their behaviour is hardened (see Fixed).
- **`glpi_list_*` tools**: now accept `start`, `range`, `sort`, `order`,
  `expand_dropdowns`. The previous `limit`-only form still works.
- **`glpi_search`**: marked deprecated. Prefer `glpi_search_v2`.
- **Build target**: `strict` TypeScript already, with `tsx` instead of
  `jest`/`ts-node` for test execution.

### Removed

- `eslint` was referenced in `package.json` scripts but never installed; the
  unused script is removed to avoid confusion. Linting can be reintroduced
  alongside tests if needed.
