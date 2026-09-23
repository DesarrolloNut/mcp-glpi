# MCP Server for GLPI (v3.4)

A Model Context Protocol (MCP) server that exposes GLPI (IT Service
Management) to AI assistants like Claude, LibreChat, Open WebUI, and Dify.

Supports both **Local CLI / Stdio** and **Remote HTTP / SSE** deployment modes with enterprise-grade security hardening.

See [CHANGELOG.md](./CHANGELOG.md) for detailed version history.

## What's New in v3.4

- **Enterprise Security Hardening**:
  - Sandboxed file uploads (`GLPI_ALLOWED_UPLOAD_DIR`) with directory traversal (`../`) and symlink escape defenses.
  - Alphanumeric sanitization on dynamic itemtypes.
  - Mandatory HTTPS for GLPI API communication (`GLPI_ALLOW_HTTP=true` for local test bypass).
  - Strict Zod validation schemas for all write mutations and input boundaries.
- **Native Remote HTTP/SSE Transport**:
  - Exposes standard Server-Sent Events endpoints (`/sse`, `/mcp`, `/`) and message dispatcher (`/messages`).
  - Zero external web framework dependencies (built purely with native Node.js `node:http`).
  - Perimeter Bearer token authentication (`MCP_AUTH_TOKEN`) via headers or URL query parameter.
  - Built-in `/health` status endpoint for container orchestrators.
- **Cloud & Container Ready (Easypanel / Docker)**:
  - Multi-stage `Dockerfile` (`node:22-alpine`) running under an unprivileged `node` user.
  - Native Docker and Easypanel healthchecks.
- **Full ITIL & ITSM Tool Suite (84 Tools)**:
  - Tickets, problems, changes, assets (computers, network equipment, printers, monitors, software), documents, knowledge base, users, groups, and advanced reporting.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `GLPI_URL` | yes | Base URL of the GLPI instance (HTTPS required by default) |
| `GLPI_APP_TOKEN` | no | Application token (Setup → General → API) |
| `GLPI_USER_TOKEN` | no\* | User API token |
| `GLPI_USERNAME` | no\* | Login (when not using user token) |
| `GLPI_PASSWORD` | no\* | Password (when not using user token) |
| `GLPI_TIMEOUT_MS` | no | HTTP request timeout in ms (default `15000`) |
| `GLPI_MAX_RETRIES` | no | Max retries on 5xx / 429 / network errors (default `2`) |
| `GLPI_ALLOWED_UPLOAD_DIR` | no | Sandbox root path for `glpi_upload_document` (default: project working directory) |
| `GLPI_ALLOW_HTTP` | no | Set to `true` to allow unencrypted `http://` URLs for local testing |
| `PORT` | no | HTTP port to listen on for SSE transport (e.g. `3000`) |
| `MCP_TRANSPORT` | no | Set to `sse` to enable HTTP/SSE server (enabled automatically when `PORT` is defined) |
| `MCP_AUTH_TOKEN` | no | Secret Bearer token required for remote clients connecting via `/sse` |
| `GLPI_DEBUG` | no | Set to any value to log HTTP retries/re-auth to stderr |

\* either `GLPI_USER_TOKEN` or `GLPI_USERNAME`+`GLPI_PASSWORD` is required.

### Security & Hardening

1. **Encrypted Transport (HTTPS Enforced):** `GLPI_URL` must use `https://` to protect tokens and credentials in transit. Unencrypted `http://` connections are blocked by default and require `GLPI_ALLOW_HTTP=true`.
2. **File Upload Sandboxing (`glpi_upload_document`):** File uploads are restricted to `GLPI_ALLOWED_UPLOAD_DIR` (or working directory). Path traversal (`../`), symlink escapes, hidden files, sensitive credentials (`.env`, SSH keys), and unauthorized file extensions are strictly blocked.
3. **Itemtype Sanitization:** Entity and object type arguments are strictly validated against `/^[a-zA-Z0-9_]+$/` to prevent path traversal and endpoint tampering.
4. **Zod Strict Schemas:** All mutations and input parameters are validated against strict Zod schemas with defined boundaries.
5. **Perimeter Authentication:** When running over HTTP/SSE, `MCP_AUTH_TOKEN` protects `/sse` from unauthorized internet access.

### Client Configuration

#### Local (Claude Desktop via Stdio)

```json
{
  "mcpServers": {
    "glpi": {
      "command": "npx",
      "args": ["mcp-glpi"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_APP_TOKEN": "...",
        "GLPI_USER_TOKEN": "..."
      }
    }
  }
}
```

#### Remote / Web (Easypanel, LibreChat, Open WebUI, Dify, Claude Code Remote via SSE)

Connect using Server-Sent Events (SSE):

* **SSE Endpoint:** `https://mcp-glpi.yourdomain.com/sse`
* **Health Check:** `https://mcp-glpi.yourdomain.com/health`
* **Authorization:** Header `Authorization: Bearer <MCP_AUTH_TOKEN>` (or query parameter `?token=<MCP_AUTH_TOKEN>`)

```json
{
  "mcpServers": {
    "glpi-remote": {
      "url": "https://mcp-glpi.yourdomain.com/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

## Deployment on Easypanel / Docker

This server is packaged with a multi-stage Docker build ready to run on [Easypanel](https://easypanel.io/) or any Docker container orchestrator.

### 1. Create Service in Easypanel
1. Inside your project, click **+ Service** → **App**.
2. **Source**: Select **GitHub** and connect `DesarrolloNut/mcp-glpi` (or your repository fork).
3. **Branch**: `main`.
4. **Build Type**: `Dockerfile` (automatically detected).

### 2. Configure Environment Variables
In the **Environment** tab, set the following variables:

| Variable | Value Example | Notes |
|---|---|---|
| `GLPI_URL` | `https://glpi.nutriciosa.local` | GLPI instance URL (requires `https://` or `GLPI_ALLOW_HTTP=true`) |
| `GLPI_APP_TOKEN` | `your_app_token` | GLPI Application Token |
| `GLPI_USER_TOKEN` | `your_user_token` | GLPI User API Token (or configure `GLPI_USERNAME` + `GLPI_PASSWORD`) |
| `PORT` | `3000` | Port for the HTTP/SSE server |
| `MCP_TRANSPORT` | `sse` | Activates SSE transport mode |
| `MCP_AUTH_TOKEN` | `sk-mcp-glpi-secret...` | (Recommended) Secret token required by MCP clients to connect |
| `GLPI_ALLOW_HTTP` | `true` | (Optional) Set to `true` if your GLPI backend is on local unencrypted HTTP |

### 3. Domains & Port Forwarding
In the **Domains** tab:
- Add your domain: e.g. `mcp-glpi.nutriciosa.local`.
- Ensure the destination port is set to **`3000`**.

### 4. Healthcheck & Monitoring
Easypanel automatically monitors the container via the Dockerfile's built-in probe:
- **Healthcheck URL**: `http://127.0.0.1:3000/health`
- Returns: `{"status":"ok","service":"mcp-glpi","uptime":...,"activeSessions":...}`

---

## Tool catalogue

### Tickets — read

| Tool | Description |
|---|---|
| `glpi_list_tickets` | List with `start`/`limit`/`range`/`sort`/`order`/`status` |
| `glpi_get_ticket` | Detail + status/urgency labels + counts of linked items |
| `glpi_get_ticket_timeline` | Followups + tasks + solutions + validations, chronological |
| `glpi_search_tickets` | High-level search (status, assigned, requester, dates, ...) |
| `glpi_get_ticket_followups` | Followups of a ticket |
| `glpi_get_ticket_tasks` | Tasks |
| `glpi_get_ticket_solutions` | Solutions |
| `glpi_get_ticket_validations` | Validations (approvals) |
| `glpi_get_ticket_documents` | Linked documents |
| `glpi_get_ticket_satisfaction` | Satisfaction survey result |
| `glpi_list_overdue_tickets` | Tickets whose SLA deadline has passed |

### Tickets — write

| Tool | Description |
|---|---|
| `glpi_create_ticket` | Create a ticket |
| `glpi_update_ticket` | Update fields |
| `glpi_delete_ticket` | ⚠️ Delete (force=true purges) |
| `glpi_add_followup` | Add a followup |
| `glpi_add_task` | Add a task with time tracking |
| `glpi_add_solution` | Add a solution |
| `glpi_assign_ticket` | Assign to user OR group |
| `glpi_link_tickets` | link / duplicate / parent |
| `glpi_add_ticket_validation` | Request a validation |
| `glpi_set_validation_status` | Approve (2) or refuse (3) |
| `glpi_upload_document` | Upload a local file as a Document; `ticket_id` attaches it in the same call |
| `glpi_attach_document_to_ticket` | Link an uploaded document to a ticket |

### Problems & Changes

| Tool | Description |
|---|---|
| `glpi_list_problems` / `glpi_get_problem` / `glpi_create_problem` / `glpi_update_problem` | Problem management |
| `glpi_list_changes` / `glpi_get_change` / `glpi_create_change` / `glpi_update_change` | Change management |

### Assets

| Tool family | Notes |
|---|---|
| Computer, Software, NetworkEquipment, Printer, Monitor, Phone | `list_*`, `get_*`, plus `create`/`update`/`delete` symmetry |

### Knowledge base, contracts, suppliers, locations, projects, documents

`glpi_list_*`, `glpi_get_*`, and `glpi_create_*` where the GLPI API allows it.
`glpi_search_knowbase` performs a free-text search on the title (field id
resolved dynamically — no longer hard-coded).

### Users, groups, categories, entities

`glpi_list_users` filters active users via the search endpoint (not
`searchText`); `glpi_create_user`/`glpi_create_group`/`glpi_add_user_to_group`
cover provisioning.

### Statistics

| Tool | Description |
|---|---|
| `glpi_get_ticket_stats` | Counts by status (optional entity / date filters) |
| `glpi_get_asset_stats` | Total counts per asset type |
| `glpi_tickets_stats_by` | Ventilation by `status` / `category` / `technician` / `entity` / `month`, optional period |

### Generic / introspection

| Tool | Description |
|---|---|
| `glpi_search_v2` | Multi-criteria search (`criteria[]`, `forcedisplay`, `fetch_all`, ...) |
| `glpi_count` | Cheap totalcount probe with criteria |
| `glpi_list_search_options` | Catalogue of searchable fields for an itemtype |
| `glpi_get_session_info` | Active profile + available profiles + entities |
| `glpi_search` | **Deprecated**: single-criterion alias kept for backward compat |

### Resources

`glpi://tickets/open`, `glpi://tickets/recent`, `glpi://problems/open`,
`glpi://changes/pending`, `glpi://computers`, `glpi://groups`,
`glpi://categories`, `glpi://stats/tickets`, `glpi://stats/assets`.

## Reference

### Ticket status

| ID | Label |
|---|---|
| 1 | New |
| 2 | Processing (assigned) |
| 3 | Processing (planned) |
| 4 | Pending |
| 5 | Solved |
| 6 | Closed |

### Validation status

| ID | Label |
|---|---|
| 1 | Waiting |
| 2 | Granted |
| 3 | Refused |

### Urgency / impact / priority

| ID | Label |
|---|---|
| 1 | Very low |
| 2 | Low |
| 3 | Medium |
| 4 | High |
| 5 | Very high |

### Change status

| ID | Label |
|---|---|
| 1 | New |
| 2 | Evaluation |
| 3 | Approval |
| 4 | Accepted |
| 5 | Pending |
| 6 | Test |
| 7 | Qualification |
| 8 | Applied |
| 9 | Review |
| 10 | Closed |
| 11 | Refused |
| 12 | Canceled |

## Development

```bash
git clone https://github.com/DesarrolloNut/mcp-glpi.git
cd mcp-glpi
npm install
npm run build
npm test          # node --test via tsx, mocked fetch
```

Run locally:

```bash
export GLPI_URL="https://glpi.example.com"
export GLPI_USER_TOKEN="..."
npm start
```

## Troubleshooting / FAQ

### "El servidor MCP respondió exitosamente pero no expone ninguna herramienta actualmente (tools/list retornó vacío)"
Si al conectar tu cliente MCP (por ejemplo, desde un panel web de agentes IA) recibes este mensaje:

1. **Reconstruye el despliegue en Easypanel:**
   - Asegúrate de que los cambios más recientes del repositorio hayan sido enviados a GitHub (`git push`).
   - En Easypanel, ve a tu servicio y pulsa **Deploy / Redéploy** para que reconstruya la imagen Docker con el código y handlers actualizados.
2. **Verifica la URL del Endpoint:**
   - La mayoría de clientes esperan la ruta completa de Server-Sent Events: `http://mcp-glpi.nutriciosa.local/sse`.
   - Nuestro servidor también responde en la raíz `http://mcp-glpi.nutriciosa.local` y en `/mcp`. Si tu cliente falló en la raíz, prueba especificando `/sse`.
3. **Verifica el estado del servicio (`/health`):**
   - Abre en tu navegador o terminal: `http://mcp-glpi.nutriciosa.local/health`.
   - Debes obtener una respuesta JSON con `{"status":"ok","service":"mcp-glpi", ...}`. Si obtienes error de conexión o 404, el contenedor no está activo o la configuración de dominio en Easypanel no está apuntando al puerto `3000`.
4. **Headers de Autenticación (`MCP_AUTH_TOKEN`):**
   - Si configuraste `MCP_AUTH_TOKEN` en las variables de entorno, asegúrate de proveer el JSON de autenticación en el cliente:
     ```json
     {"Authorization": "Bearer tu_token_secreto"}
     ```
   - Si el token no coincide, las peticiones a `/sse` y `/messages` retornarán `401 Unauthorized`.

### "GLPI_URL must use HTTPS"
Por motivos de seguridad y protección de credenciales, el servidor bloquea conexiones `http://` por defecto. Si tu entorno de GLPI es local y no cuenta con certificado SSL, añade la variable de entorno:
```bash
GLPI_ALLOW_HTTP=true
```

## License

MIT

## Links

- [GLPI Project](https://glpi-project.org/)
- [GLPI High-Level API](https://glpi-user-documentation.readthedocs.io/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [NPM Package](https://www.npmjs.com/package/mcp-glpi)
