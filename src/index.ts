#!/usr/bin/env node

/**
 * MCP Server for GLPI v3.0
 *
 * Major changes vs v2:
 *   - Unified HTTP layer with auto-reauth, structured errors, retries.
 *   - List tools accept start/limit/fetch_all/forcedisplay/criteria/sort/order
 *     (backward-compatible: `limit` alone still works).
 *   - New `glpi_count` and `glpi_search_v2` (multi-criteria, forcedisplay).
 *   - High-level `glpi_search_tickets` with friendly params (status/assigned/...).
 *   - `glpi_get_ticket_timeline` merges followups+tasks+solutions+validations.
 *   - `glpi_tickets_stats_by` ventilation by status/category/technician/entity/month.
 *   - Link, validation, document, SLA, satisfaction tools.
 *   - Field-id mapping via /listSearchOptions for resilience across GLPI versions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpSseServer } from './sse-server.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { GlpiClient, GlpiConfig, ListOptions } from './glpi-client.js';
import { GlpiError } from './http.js';
import { SearchCriterion, SearchType, SearchLink } from './search.js';
import { parseGlpiConfig } from './config.js';
import { resolveSafePath, ALLOWED_UPLOAD_MIME_TYPES } from './path-security.js';
import { validateItemtype } from './itemtype-security.js';
import {
  listArgsSchema,
  ticketReadSchema,
  ticketSearchSchema,
  ticketCreateSchema,
  ticketUpdateSchema,
  ticketDeleteSchema,
  followupCreateSchema,
  taskCreateSchema,
  solutionCreateSchema,
  ticketAssignSchema,
  linkTicketsSchema,
  uploadDocumentSchema,
  attachDocumentSchema,
  ticketValidationSchema,
  setValidationStatusSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICKET_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
};

const TICKET_URGENCY: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Very high',
};

const PROBLEM_STATUS: Record<number, string> = {
  1: 'New', 2: 'Accepted', 3: 'Planned', 4: 'Pending', 5: 'Solved', 6: 'Closed',
};

const CHANGE_STATUS: Record<number, string> = {
  1: 'New', 2: 'Evaluation', 3: 'Approval', 4: 'Accepted', 5: 'Pending',
  6: 'Test', 7: 'Qualification', 8: 'Applied', 9: 'Review', 10: 'Closed',
  11: 'Refused', 12: 'Canceled',
};

const VALIDATION_STATUS: Record<number, string> = {
  1: 'Waiting', 2: 'Granted', 3: 'Refused',
};

// Standard Ticket search-option field ids (GLPI ≥ 9.5). Fallbacks; the
// SearchOptions cache is used to resolve friendly names dynamically.
const TICKET_FIELDS = {
  id: 2,
  name: 1,
  status: 12,
  date: 15,
  date_mod: 19,
  solvedate: 17,
  closedate: 16,
  priority: 3,
  urgency: 10,
  impact: 11,
  category: 7,
  entity: 80,
  requester_user: 4,
  technician_user: 5,
  technician_group: 8,
  type: 14,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig(): GlpiConfig {
  return parseGlpiConfig(process.env);
}

/**
 * Parse common list-tool arguments into a ListOptions.
 *
 * Accepts (in order of precedence):
 *   - `range`: "START-END" string passed through as-is
 *   - `start` + `limit`: assembled into range
 *   - `limit` alone: range = "0-{limit-1}" (backward-compat with v2)
 */
function parseListArgs(args: Record<string, unknown> | undefined): ListOptions {
  const opts: ListOptions = {};
  if (!args) return { range: '0-49', expand_dropdowns: true };

  if (typeof args.range === 'string') {
    opts.range = args.range;
  } else if (args.start !== undefined || args.limit !== undefined) {
    const start = (args.start as number) ?? 0;
    const limit = (args.limit as number) ?? 50;
    opts.range = `${start}-${start + limit - 1}`;
  } else {
    opts.range = '0-49';
  }

  if (args.sort !== undefined) opts.sort = args.sort as number;
  if (args.order) opts.order = args.order as 'ASC' | 'DESC';
  if (args.is_deleted !== undefined) opts.is_deleted = args.is_deleted as boolean;
  if (args.include_deleted !== undefined) opts.is_deleted = args.include_deleted as boolean;
  // Default expand_dropdowns to true for human-readable output.
  opts.expand_dropdowns =
    args.expand_dropdowns === false ? false : true;
  return opts;
}

interface CriteriaArg {
  field: number | string;
  searchtype: SearchType;
  value: string | number | boolean;
  link?: SearchLink;
}

async function resolveCriteria(
  client: GlpiClient,
  itemtype: string,
  raw: CriteriaArg[]
): Promise<SearchCriterion[]> {
  return Promise.all(
    raw.map(async (c) => ({
      field: (await client.searchOptions.resolveField(itemtype, c.field)) ??
        (typeof c.field === 'number' ? c.field : 0),
      searchtype: c.searchtype,
      value: c.value,
      link: c.link,
    }))
  );
}

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function formatTicketSummary(t: any) {
  return {
    id: t.id,
    name: t.name,
    status: TICKET_STATUS[t.status] ?? t.status,
    urgency: TICKET_URGENCY[t.urgency] ?? t.urgency,
    priority: TICKET_URGENCY[t.priority] ?? t.priority,
    date: t.date,
    date_mod: t.date_mod,
    entities_id: t.entities_id,
    itilcategories_id: t.itilcategories_id,
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let client: GlpiClient;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const LIST_TOOL_COMMON_PROPS = {
  start: { type: 'number', description: 'Desplazamiento inicial / offset (por defecto 0)' },
  limit: { type: 'number', description: 'Cantidad máxima de registros a retornar (por defecto 50)' },
  range: { type: 'string', description: 'Rango explícito "INICIO-FIN" (anula start y limit)' },
  sort: { type: 'number', description: 'ID del campo por el cual ordenar (ID de opción de búsqueda)' },
  order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Dirección del ordenamiento (ASC o DESC)' },
  expand_dropdowns: { type: 'boolean', description: 'Resolver IDs foráneos a sus nombres legibles (por defecto true)' },
};

/** MIME types for glpi_upload_document, keyed by lowercase file extension. */
const UPLOAD_MIME_TYPES = ALLOWED_UPLOAD_MIME_TYPES;

// ---------------------------------------------------------------------------
// Tool safety annotations (MCP ToolAnnotations)
//
// Derived from the tool name so every current and future tool gets hints:
//   - list/get/search/count/stats  -> readOnlyHint
//   - delete                       -> destructiveHint (data loss possible)
//   - update/set/assign            -> destructiveHint (overwrites existing data)
//   - create/add/link/attach       -> additive write (non-destructive, non-idempotent)
// openWorldHint is false everywhere: tools only reach the configured GLPI.
// ---------------------------------------------------------------------------

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function toolAnnotations(name: string): ToolAnnotations {
  if (/^glpi_(list_|get_|search|count$|tickets_stats)/.test(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (/^glpi_delete_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (/^glpi_(update_|set_|assign_)/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  // create / add / link / attach: additive writes. Re-running duplicates data.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

function annotate<T extends { name: string }>(tool: T): T & { annotations: ToolAnnotations } {
  return { ...tool, annotations: toolAnnotations(tool.name) };
}

export const ALL_TOOLS = [
    // ============== READ — TICKETS ==============
    {
      name: 'glpi_list_tickets',
      description: 'Listar tickets de soporte. Admite filtros por estado, paginación y ordenamiento.',
      inputSchema: {
        type: 'object',
        properties: {
          ...LIST_TOOL_COMMON_PROPS,
          status: { type: 'number', description: 'Estado: 1=Nuevo, 2=Asignado, 3=Planificado, 4=Pendiente, 5=Resuelto, 6=Cerrado' },
        },
      },
    },
    {
      name: 'glpi_get_ticket',
      description: 'Obtener un ticket por ID con etiquetas de estado, urgencia y conteo de elementos vinculados.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del ticket' },
          with_logs: { type: 'boolean', description: 'Incluir historial de cambios y auditoría' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_get_ticket_timeline',
      description: 'Línea de tiempo cronológica completa de un ticket: seguimientos, tareas, soluciones y validaciones ordenados por fecha.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'ID del ticket' } },
        required: ['id'],
      },
    },
    {
      name: 'glpi_search_tickets',
      description: 'Búsqueda avanzada de tickets con filtros amigables. Usar preferentemente esta herramienta para tickets.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number', description: '1..6 (1=Nuevo, 2=Asignado, 3=Planificado, 4=Pendiente, 5=Resuelto, 6=Cerrado)' },
          assigned_user_id: { type: 'number', description: 'ID del técnico asignado' },
          assigned_group_id: { type: 'number', description: 'ID del grupo técnico asignado' },
          requester_user_id: { type: 'number', description: 'ID del usuario solicitante' },
          category_id: { type: 'number', description: 'ID de la categoría ITIL' },
          entity_id: { type: 'number', description: 'ID de la entidad' },
          priority: { type: 'number', description: 'Prioridad: 1=Muy baja .. 5=Muy alta' },
          urgency: { type: 'number', description: 'Urgencia: 1=Muy baja .. 5=Muy alta' },
          date_from: { type: 'string', description: 'Fecha inicial (formato AAAA-MM-DD HH:MM:SS)' },
          date_to: { type: 'string', description: 'Fecha final (formato AAAA-MM-DD HH:MM:SS)' },
          text_search: { type: 'string', description: 'Texto libre a buscar en el título' },
          open_only: { type: 'boolean', description: 'Solo tickets abiertos (estado < 5)' },
          start: { type: 'number', description: 'Desplazamiento inicial / offset' },
          limit: { type: 'number', description: 'Cantidad máxima de resultados' },
          fetch_all: { type: 'boolean', description: 'Paginar hasta obtener todos los resultados; limitado por max_rows (por defecto 1000)' },
          max_rows: { type: 'number', description: 'Límite máximo de filas al usar fetch_all' },
          order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Dirección del orden (ASC o DESC)' },
          sort: { type: 'number', description: 'ID del campo por el cual ordenar' },
        },
      },
    },
    {
      name: 'glpi_get_ticket_followups',
      description: 'Listar seguimientos (comentarios y respuestas) de un ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number', description: 'ID del ticket' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_tasks',
      description: 'Listar tareas técnicas registradas en un ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number', description: 'ID del ticket' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_solutions',
      description: 'Listar soluciones registradas para un ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number', description: 'ID del ticket' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_validations',
      description: 'Listar aprobaciones o solicitudes de validación de un ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number', description: 'ID del ticket' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_documents',
      description: 'Listar documentos y archivos adjuntos vinculados a un ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number', description: 'ID del ticket' } }, required: ['ticket_id'] },
    },

    // ============== WRITE — TICKETS ==============
    {
      name: 'glpi_create_ticket',
      description: 'Crear un nuevo ticket de soporte o requerimiento.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Título o asunto del ticket' },
          content: { type: 'string', description: 'Descripción detallada del ticket (admite texto o HTML)' },
          urgency: { type: 'number', description: 'Urgencia: 1=Muy baja, 2=Baja, 3=Media, 4=Alta, 5=Muy alta' },
          impact: { type: 'number', description: 'Impacto: 1=Muy bajo, 2=Bajo, 3=Medio, 4=Alto, 5=Muy alto' },
          priority: { type: 'number', description: 'Prioridad: 1=Muy baja, 2=Baja, 3=Media, 4=Alta, 5=Muy alta' },
          type: { type: 'number', description: 'Tipo: 1=Incidencia, 2=Requerimiento/Petición' },
          category_id: { type: 'number', description: 'ID de la categoría ITIL' },
          entity_id: { type: 'number', description: 'ID de la entidad (opcional)' },
          user_id_assign: { type: 'number', description: 'ID del técnico asignado' },
          group_id_assign: { type: 'number', description: 'ID del grupo técnico asignado' },
          requester_user_id: { type: 'number', description: 'ID del usuario solicitante' },
          requester_group_id: { type: 'number', description: 'ID del grupo solicitante' },
          time_to_resolve: { type: 'string', description: 'Fecha límite de resolución SLA (formato AAAA-MM-DD HH:MM:SS)' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_ticket',
      description: 'Actualizar los campos de un ticket existente.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del ticket a actualizar' },
          name: { type: 'string', description: 'Nuevo título o asunto' },
          content: { type: 'string', description: 'Nuevo contenido o descripción' },
          status: { type: 'number', description: 'Nuevo estado: 1=Nuevo, 2=Asignado, 3=Planificado, 4=Pendiente, 5=Resuelto, 6=Cerrado' },
          urgency: { type: 'number', description: 'Nueva urgencia (1..5)' },
          priority: { type: 'number', description: 'Nueva prioridad (1..5)' },
          impact: { type: 'number', description: 'Nuevo impacto (1..5)' },
          itilcategories_id: { type: 'number', description: 'Nuevo ID de categoría ITIL' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_ticket',
      description: '⚠️ DESTRUCTIVO: Eliminar un ticket. Si force=true lo purga definitivamente sin pasar por papelera.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del ticket a eliminar' },
          force: { type: 'boolean', description: 'Si es true, elimina definitivamente sin pasar por la papelera' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_add_followup',
      description: 'Agregar un seguimiento (comentario de avance o respuesta) a un ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          content: { type: 'string', description: 'Texto o descripción del seguimiento' },
          is_private: { type: 'boolean', description: 'Si es true, el seguimiento solo es visible para técnicos' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_task',
      description: 'Agregar una tarea técnica con registro de tiempo a un ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          content: { type: 'string', description: 'Descripción de la tarea a realizar' },
          actiontime: { type: 'number', description: 'Tiempo invertido en segundos' },
          is_private: { type: 'boolean', description: 'Si es true, la tarea solo es visible para técnicos' },
          state: { type: 'number', description: 'Estado: 0=Informativa, 1=Por hacer (Todo), 2=Hecha (Done)' },
          users_id_tech: { type: 'number', description: 'ID del técnico asignado a la tarea' },
          groups_id_tech: { type: 'number', description: 'ID del grupo técnico asignado' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_solution',
      description: 'Registrar una propuesta de solución para un ticket (cambia su estado a Resuelto).',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          content: { type: 'string', description: 'Descripción detallada de la solución aplicada' },
          solutiontypes_id: { type: 'number', description: 'ID del tipo de solución' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_assign_ticket',
      description: 'Asignar un ticket a un usuario o grupo técnico. Tipo: 1=solicitante, 2=técnico asignado, 3=observador.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          user_id: { type: 'number', description: 'ID del usuario a asignar' },
          group_id: { type: 'number', description: 'ID del grupo a asignar' },
          type: { type: 'number', description: 'Rol: 1=Solicitante, 2=Asignado/Técnico, 3=Observador' },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_link_tickets',
      description: 'Vincular dos tickets entre sí. link_type: 1=enlace, 2=duplicado de, 3=hijo de.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { type: 'number', description: 'ID del ticket principal o padre' },
          child_id: { type: 'number', description: 'ID del ticket secundario o hijo' },
          link_type: { type: 'number', description: 'Tipo de vínculo: 1=Enlace general, 2=Duplicado de, 3=Hijo de' },
        },
        required: ['parent_id', 'child_id'],
      },
    },
    {
      name: 'glpi_add_ticket_validation',
      description: 'Solicitar la aprobación o validación formal de un ticket a un usuario específico.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          users_id_validate: { type: 'number', description: 'ID del usuario al que se solicita la validación' },
          comment_submission: { type: 'string', description: 'Comentario o justificación de la solicitud' },
        },
        required: ['ticket_id', 'users_id_validate'],
      },
    },
    {
      name: 'glpi_set_validation_status',
      description: 'Aprobar (2) o rechazar (3) una solicitud de validación existente con comentario opcional.',
      inputSchema: {
        type: 'object',
        properties: {
          validation_id: { type: 'number', description: 'ID del registro de validación' },
          status: { type: 'number', enum: [2, 3], description: '2=Aprobada / Concedida, 3=Rechazada' },
          comment_validation: { type: 'string', description: 'Comentario justificando la decisión' },
        },
        required: ['validation_id', 'status'],
      },
    },
    {
      name: 'glpi_upload_document',
      description:
        'Subir un archivo local a GLPI como Documento. Si se indica ticket_id, se adjunta automáticamente a ese ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Ruta absoluta o relativa del archivo local en el servidor',
          },
          name: { type: 'string', description: 'Título del documento en GLPI (por defecto: nombre del archivo)' },
          ticket_id: {
            type: 'number',
            description: 'ID del ticket al que se adjuntará el documento (opcional)',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'glpi_attach_document_to_ticket',
      description: 'Vincular un documento ya existente en GLPI a un ticket específico.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number', description: 'ID del ticket' },
          document_id: { type: 'number', description: 'ID del documento' },
        },
        required: ['ticket_id', 'document_id'],
      },
    },
    {
      name: 'glpi_get_ticket_satisfaction',
      description: 'Obtener los datos de la encuesta de satisfacción (calificación y comentario) de un ticket.',
      inputSchema: {
        type: 'object',
        properties: { ticket_id: { type: 'number', description: 'ID del ticket' } },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_list_overdue_tickets',
      description: 'Listar tickets vencidos cuya fecha límite de SLA (time_to_resolve) expiró y siguen abiertos (estado < 5).',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number', description: 'Filtrar por ID de entidad' },
          limit: { type: 'number', description: 'Límite máximo de tickets a retornar' },
        },
      },
    },

    // ============== PROBLEMS / CHANGES ==============
    {
      name: 'glpi_list_problems',
      description: 'Listar problemas registrados (ITIL). Admite paginación y ordenamiento.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_problem',
      description: 'Obtener detalles de un problema por su ID con su estado.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del problema' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_problem',
      description: 'Crear un nuevo problema en GLPI.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Título o asunto del problema' },
          content: { type: 'string', description: 'Descripción detallada del problema' },
          urgency: { type: 'number', description: 'Urgencia (1..5)' },
          impact: { type: 'number', description: 'Impacto (1..5)' },
          priority: { type: 'number', description: 'Prioridad (1..5)' },
          category_id: { type: 'number', description: 'ID de la categoría ITIL' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_problem',
      description: 'Actualizar campos de un problema existente.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del problema' },
          name: { type: 'string', description: 'Nuevo título' },
          content: { type: 'string', description: 'Nueva descripción' },
          status: { type: 'number', description: 'Nuevo estado' },
          urgency: { type: 'number', description: 'Nueva urgencia' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_list_changes',
      description: 'Listar solicitudes de cambio (ITIL Changes). Admite paginación y ordenamiento.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_change',
      description: 'Obtener detalles de una solicitud de cambio por su ID con su estado.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del cambio' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_change',
      description: 'Crear una nueva solicitud de cambio.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Título del cambio' },
          content: { type: 'string', description: 'Descripción detallada del cambio' },
          urgency: { type: 'number', description: 'Urgencia (1..5)' },
          impact: { type: 'number', description: 'Impacto (1..5)' },
          priority: { type: 'number', description: 'Prioridad (1..5)' },
          category_id: { type: 'number', description: 'ID de la categoría ITIL' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_change',
      description: 'Actualizar campos de una solicitud de cambio existente.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del cambio' },
          name: { type: 'string', description: 'Nuevo título' },
          content: { type: 'string', description: 'Nueva descripción' },
          status: { type: 'number', description: 'Nuevo estado' },
        },
        required: ['id'],
      },
    },

    // ============== ASSETS ==============
    ...[
      { asset: 'computers', singular: 'computer', esSingular: 'computadora', esPlural: 'computadoras' },
      { asset: 'softwares', singular: 'software', esSingular: 'software', esPlural: 'softwares' },
      { asset: 'network_equipments', singular: 'network_equipment', esSingular: 'equipo de red', esPlural: 'equipos de red' },
      { asset: 'printers', singular: 'printer', esSingular: 'impresora', esPlural: 'impresoras' },
      { asset: 'monitors', singular: 'monitor', esSingular: 'monitor', esPlural: 'monitores' },
      { asset: 'phones', singular: 'phone', esSingular: 'teléfono', esPlural: 'teléfonos' },
    ].flatMap(({ asset, singular, esSingular, esPlural }) => {
      return [
        {
          name: `glpi_list_${asset}`,
          description: `Listar ${esPlural} del inventario. Admite paginación y ordenamiento.`,
          inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
        },
        {
          name: `glpi_get_${singular}`,
          description: `Obtener detalles de un(a) ${esSingular} por ID con sus componentes vinculados.`,
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: `ID del(a) ${esSingular}` },
              with_softwares: { type: 'boolean', description: 'Incluir softwares vinculados' },
              with_networkports: { type: 'boolean', description: 'Incluir puertos de red' },
              with_connections: { type: 'boolean', description: 'Incluir conexiones directas' },
              with_documents: { type: 'boolean', description: 'Incluir documentos adjuntos' },
            },
            required: ['id'],
          },
        },
      ];
    }),
    {
      name: 'glpi_create_computer',
      description: 'Registrar una computadora en el inventario.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del equipo' },
          serial: { type: 'string', description: 'Número de serie' },
          otherserial: { type: 'string', description: 'Número de inventario alternativo' },
          contact: { type: 'string', description: 'Contacto o responsable del equipo' },
          comment: { type: 'string', description: 'Comentario u observaciones' },
          locations_id: { type: 'number', description: 'ID de la ubicación física' },
          states_id: { type: 'number', description: 'ID del estado del equipo' },
          computertypes_id: { type: 'number', description: 'ID del tipo de computadora' },
          manufacturers_id: { type: 'number', description: 'ID del fabricante' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_computer',
      description: 'Actualizar datos de una computadora en el inventario.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID de la computadora' },
          name: { type: 'string', description: 'Nuevo nombre' },
          serial: { type: 'string', description: 'Nuevo número de serie' },
          comment: { type: 'string', description: 'Nuevos comentarios' },
          locations_id: { type: 'number', description: 'Nuevo ID de ubicación' },
          states_id: { type: 'number', description: 'Nuevo ID de estado' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_computer',
      description: '⚠️ DESTRUCTIVO: Eliminar una computadora del inventario. Si force=true purga definitivamente.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID de la computadora' },
          force: { type: 'boolean', description: 'Si es true, elimina permanentemente sin papelera' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_create_software',
      description: 'Registrar un software en el catálogo de activos.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del software' },
          comment: { type: 'string', description: 'Comentarios u observaciones' },
          manufacturers_id: { type: 'number', description: 'ID del fabricante' },
          softwarecategories_id: { type: 'number', description: 'ID de la categoría de software' },
        },
        required: ['name'],
      },
    },

    // ============== KB / CONTRACTS / SUPPLIERS / LOCATIONS / PROJECTS ==============
    {
      name: 'glpi_list_knowbase',
      description: 'Listar artículos de la base de conocimiento (KB / FAQ).',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_knowbase_item',
      description: 'Obtener un artículo de la base de conocimiento por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del artículo' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_knowbase',
      description: 'Buscar artículos en la base de conocimiento por texto libre en el título.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto o término a buscar' },
          limit: { type: 'number', description: 'Cantidad máxima de artículos' },
        },
        required: ['query'],
      },
    },
    {
      name: 'glpi_create_knowbase_item',
      description: 'Crear un artículo en la base de conocimiento.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Título o pregunta del artículo' },
          answer: { type: 'string', description: 'Contenido o respuesta del artículo' },
          is_faq: { type: 'boolean', description: 'Si es true, se publica como pregunta frecuente (FAQ pública)' },
          knowbaseitemcategories_id: { type: 'number', description: 'ID de categoría de base de conocimiento' },
        },
        required: ['name', 'answer'],
      },
    },
    {
      name: 'glpi_list_contracts',
      description: 'Listar contratos de servicios y mantenimiento.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_contract',
      description: 'Obtener un contrato por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del contrato' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_contract',
      description: 'Crear un contrato en GLPI.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del contrato' },
          num: { type: 'string', description: 'Número identificador del contrato' },
          begin_date: { type: 'string', description: 'Fecha de inicio (AAAA-MM-DD)' },
          duration: { type: 'number', description: 'Duración en meses' },
          notice: { type: 'number', description: 'Preaviso en días' },
          comment: { type: 'string', description: 'Observaciones del contrato' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_suppliers',
      description: 'Listar proveedores.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_supplier',
      description: 'Obtener un proveedor por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del proveedor' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_supplier',
      description: 'Crear un nuevo proveedor con sus datos de contacto.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre o razón social' },
          address: { type: 'string', description: 'Dirección física' },
          postcode: { type: 'string', description: 'Código postal' },
          town: { type: 'string', description: 'Ciudad' },
          country: { type: 'string', description: 'País' },
          website: { type: 'string', description: 'Sitio web' },
          phonenumber: { type: 'string', description: 'Teléfono' },
          email: { type: 'string', description: 'Correo electrónico' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_locations',
      description: 'Listar ubicaciones físicas (sedes, plantas, edificios, oficinas).',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_location',
      description: 'Obtener una ubicación por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID de la ubicación' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_location',
      description: 'Crear una nueva ubicación jerárquica en GLPI.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la ubicación' },
          address: { type: 'string', description: 'Dirección' },
          postcode: { type: 'string', description: 'Código postal' },
          town: { type: 'string', description: 'Ciudad' },
          building: { type: 'string', description: 'Edificio' },
          room: { type: 'string', description: 'Sala u oficina' },
          locations_id: { type: 'number', description: 'ID de la ubicación padre (para ubicaciones anidadas)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_projects',
      description: 'Listar proyectos registrados en GLPI.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_project',
      description: 'Obtener información detallada de un proyecto por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del proyecto' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_project',
      description: 'Crear un nuevo proyecto de TI o gestión.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del proyecto' },
          code: { type: 'string', description: 'Código identificador del proyecto' },
          content: { type: 'string', description: 'Descripción u objetivos del proyecto' },
          priority: { type: 'number', description: 'Prioridad (1..5)' },
          plan_start_date: { type: 'string', description: 'Fecha estimada de inicio' },
          plan_end_date: { type: 'string', description: 'Fecha estimada de finalización' },
          users_id: { type: 'number', description: 'ID del usuario responsable' },
          groups_id: { type: 'number', description: 'ID del grupo responsable' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_project',
      description: 'Actualizar el avance, fechas o descripción de un proyecto existente.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID del proyecto' },
          name: { type: 'string', description: 'Nuevo nombre' },
          content: { type: 'string', description: 'Nueva descripción' },
          percent_done: { type: 'number', description: 'Porcentaje de avance (0-100)' },
          real_start_date: { type: 'string', description: 'Fecha real de inicio' },
          real_end_date: { type: 'string', description: 'Fecha real de finalización' },
        },
        required: ['id'],
      },
    },

    // ============== USERS / GROUPS / CATEGORIES / ENTITIES / DOCUMENTS ==============
    {
      name: 'glpi_list_users',
      description: 'Listar usuarios del sistema. Por defecto filtra solo usuarios activos.',
      inputSchema: {
        type: 'object',
        properties: {
          ...LIST_TOOL_COMMON_PROPS,
          active_only: { type: 'boolean', description: 'Filtrar solo usuarios activos (por defecto true)' },
        },
      },
    },
    {
      name: 'glpi_get_user',
      description: 'Obtener datos de perfil y configuración de un usuario por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del usuario' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_user',
      description: 'Buscar un usuario por su nombre de usuario / login.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Nombre de usuario o login a buscar' } }, required: ['name'] },
    },
    {
      name: 'glpi_create_user',
      description: 'Registrar un nuevo usuario en GLPI.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de usuario / login' },
          password: { type: 'string', description: 'Contraseña' },
          realname: { type: 'string', description: 'Apellidos' },
          firstname: { type: 'string', description: 'Nombres' },
          email: { type: 'string', description: 'Correo electrónico' },
          phone: { type: 'string', description: 'Teléfono' },
          profiles_id: { type: 'number', description: 'ID del perfil de permisos asignado' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_groups',
      description: 'Listar grupos de usuarios / equipos de soporte.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_group',
      description: 'Obtener detalles de un grupo por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del grupo' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_group',
      description: 'Crear un nuevo grupo de trabajo en GLPI.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del grupo' },
          comment: { type: 'string', description: 'Comentarios o descripción del grupo' },
          is_requester: { type: 'boolean', description: 'Puede ser grupo solicitante en tickets' },
          is_assign: { type: 'boolean', description: 'Puede ser asignado a tickets / tareas' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_add_user_to_group',
      description: 'Asociar un usuario a un grupo de trabajo.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'number', description: 'ID del usuario' },
          group_id: { type: 'number', description: 'ID del grupo' },
          is_manager: { type: 'boolean', description: 'Indica si es responsable/líder del grupo' },
        },
        required: ['user_id', 'group_id'],
      },
    },
    {
      name: 'glpi_list_categories',
      description: 'Listar categorías de tickets (ITIL Categories).',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_list_entities',
      description: 'Listar entidades organizacionales de GLPI.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_entity',
      description: 'Obtener detalles de una entidad organizacional por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID de la entidad' } }, required: ['id'] },
    },
    {
      name: 'glpi_list_documents',
      description: 'Listar documentos registrados en el sistema.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_document',
      description: 'Obtener metadatos de un documento por su ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ID del documento' } }, required: ['id'] },
    },

    // ============== STATS ==============
    {
      name: 'glpi_get_ticket_stats',
      description: 'Conteo de tickets agrupados por estado. Filtros opcionales: entidad, fecha inicial, fecha final.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number', description: 'ID de entidad para filtrar' },
          date_from: { type: 'string', description: 'Fecha inicio (AAAA-MM-DD)' },
          date_to: { type: 'string', description: 'Fecha fin (AAAA-MM-DD)' },
        },
      },
    },
    {
      name: 'glpi_get_asset_stats',
      description: 'Conteo total de equipos por tipo de activo (Computadoras, Monitores, Impresoras, Equipos de red, Teléfonos, Softwares).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'glpi_tickets_stats_by',
      description: 'Conteo de tickets desglosado por dimensión (status/estado, category/categoría, technician/técnico, entity/entidad, month/mes).',
      inputSchema: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: ['status', 'category', 'technician', 'entity', 'month'],
            description: 'Dimensión de desglose: status, category, technician, entity, month',
          },
          date_from: { type: 'string', description: 'Fecha inicial (AAAA-MM-DD)' },
          date_to: { type: 'string', description: 'Fecha final (AAAA-MM-DD)' },
          entity_id: { type: 'number', description: 'Filtrar por ID de entidad' },
        },
        required: ['dimension'],
      },
    },

    // ============== SESSION ==============
    {
      name: 'glpi_get_session_info',
      description: 'Consultar información de la sesión GLPI: perfil activo, perfiles disponibles y entidades accesibles.',
      inputSchema: { type: 'object', properties: {} },
    },

    // ============== GENERIC SEARCH / COUNT ==============
    {
      name: 'glpi_search_v2',
      description: 'Búsqueda avanzada multicriterio en cualquier itemtype de GLPI. Admite criteria[], forcedisplay, ordenamiento y fetch_all.',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string', description: 'Tipo de elemento GLPI (ej. Ticket, Computer, User, Problem, etc.)' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { description: 'ID del campo (número) o nombre amigable resuelto vía glpi_list_search_options' },
                searchtype: {
                  type: 'string',
                  enum: ['contains', 'notcontains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder', 'empty', 'notempty'],
                  description: 'Operador de búsqueda: contains, equals, lessthan, morethan, empty, etc.',
                },
                value: { description: 'Valor a comparar' },
                link: { type: 'string', enum: ['AND', 'OR', 'AND NOT', 'OR NOT'], description: 'Operador lógico entre criterios' },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
          forcedisplay: { type: 'array', items: { type: 'number' }, description: 'IDs de campos adicionales a mostrar' },
          start: { type: 'number', description: 'Desplazamiento inicial / offset' },
          limit: { type: 'number', description: 'Cantidad máxima de resultados por página' },
          sort: { type: 'number', description: 'ID del campo por el cual ordenar' },
          order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Dirección del orden (ASC o DESC)' },
          fetch_all: { type: 'boolean', description: 'Si es true, pagina hasta traer todos los resultados (hasta max_rows)' },
          max_rows: { type: 'number', description: 'Límite de seguridad de filas para fetch_all' },
          expand_dropdowns: { type: 'boolean', description: 'Resolver IDs a nombres legibles (por defecto true)' },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_count',
      description: 'Retorna el totalcount de registros de un itemtype que cumplen los criterios (conteo ultrarrápido con range=0-0).',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string', description: 'Tipo de elemento GLPI (ej. Ticket, Computer)' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { description: 'ID de campo' },
                searchtype: { type: 'string', description: 'Tipo de búsqueda' },
                value: { description: 'Valor' },
                link: { type: 'string', description: 'Enlace lógico (AND, OR)' },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_list_search_options',
      description: 'Descubrir todos los campos buscables de un itemtype (retorna field_id → nombre/uid/tipo de dato). Útil para armar criterios en glpi_search_v2.',
      inputSchema: {
        type: 'object',
        properties: { itemtype: { type: 'string', description: 'Tipo de elemento GLPI (ej. Ticket, Computer, Software)' } },
        required: ['itemtype'],
      },
    },

    // ============== legacy compat: keep glpi_search (mono-criterion) as deprecated alias ==============
    {
      name: 'glpi_search',
      description: '[OBSOLETO — preferir glpi_search_v2] Búsqueda simple de criterio único mantenida por compatibilidad previa.',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string', description: 'Tipo de elemento GLPI' },
          field: { type: 'number', description: 'ID del campo a buscar' },
          searchtype: { type: 'string', description: 'Tipo de búsqueda' },
          value: { type: 'string', description: 'Valor buscado' },
        },
        required: ['itemtype', 'field', 'searchtype', 'value'],
      },
    },
  ].map(annotate);

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function executeTool(name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      // ==== TICKETS — read ====
      case 'glpi_list_tickets': {
        const validated = listArgsSchema.parse(args);
        const opts = parseListArgs(validated);
        let tickets = await client.getTickets({ ...opts, order: opts.order ?? 'DESC' });
        if (typeof validated.status === 'number') {
          tickets = tickets.filter((t: any) => t.status === validated.status);
        }
        return text(tickets.map(formatTicketSummary));
      }

      case 'glpi_get_ticket': {
        const validated = ticketReadSchema.parse(args);
        const { id, with_logs } = validated;
        const [ticket, followups, tasks, solutions] = await Promise.all([
          client.getTicket(id, { with_logs }),
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
        ]);
        return text({
          ...ticket,
          status_label: TICKET_STATUS[(ticket as any).status],
          urgency_label: TICKET_URGENCY[(ticket as any).urgency],
          priority_label: TICKET_URGENCY[(ticket as any).priority],
          counts: {
            followups: followups.length,
            tasks: tasks.length,
            solutions: solutions.length,
          },
        });
      }

      case 'glpi_get_ticket_timeline': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        const [followups, tasks, solutions, validations] = await Promise.all([
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
          client.getTicketValidations(id),
        ]);
        const timeline = [
          ...followups.map((f: any) => ({ kind: 'followup', date: f.date_creation ?? f.date, ...f })),
          ...tasks.map((t: any) => ({ kind: 'task', date: t.date_creation ?? t.date, ...t })),
          ...solutions.map((s: any) => ({ kind: 'solution', date: s.date_creation ?? s.date, ...s })),
          ...validations.map((v: any) => ({
            kind: 'validation',
            date: v.submission_date ?? v.date_creation ?? v.date,
            status_label: VALIDATION_STATUS[v.status] ?? v.status,
            ...v,
          })),
        ].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
        return text({ ticket_id: id, count: timeline.length, timeline });
      }

      case 'glpi_search_tickets': {
        ticketSearchSchema.parse(args);
        const criteria: SearchCriterion[] = [];
        const push = (c: SearchCriterion) => {
          if (criteria.length > 0 && !c.link) c.link = 'AND';
          criteria.push(c);
        };
        if (args.status !== undefined) push({ field: TICKET_FIELDS.status, searchtype: 'equals', value: args.status as number });
        if (args.assigned_user_id !== undefined) push({ field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: args.assigned_user_id as number });
        if (args.assigned_group_id !== undefined) push({ field: TICKET_FIELDS.technician_group, searchtype: 'equals', value: args.assigned_group_id as number });
        if (args.requester_user_id !== undefined) push({ field: TICKET_FIELDS.requester_user, searchtype: 'equals', value: args.requester_user_id as number });
        if (args.category_id !== undefined) push({ field: TICKET_FIELDS.category, searchtype: 'equals', value: args.category_id as number });
        if (args.entity_id !== undefined) push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.priority !== undefined) push({ field: TICKET_FIELDS.priority, searchtype: 'equals', value: args.priority as number });
        if (args.urgency !== undefined) push({ field: TICKET_FIELDS.urgency, searchtype: 'equals', value: args.urgency as number });
        if (args.date_from) push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string });
        if (args.date_to) push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string });
        if (args.text_search) push({ field: TICKET_FIELDS.name, searchtype: 'contains', value: args.text_search as string });
        if (args.open_only) push({ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 });

        const result = await client.search.search('Ticket', {
          criteria,
          start: (args.start as number) ?? 0,
          limit: (args.limit as number) ?? 50,
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          sort: args.sort as number,
          order: (args.order as 'ASC' | 'DESC') ?? 'DESC',
          expandDropdowns: true,
        });

        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      case 'glpi_get_ticket_followups': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketFollowups(id));
      }
      case 'glpi_get_ticket_tasks': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketTasks(id));
      }
      case 'glpi_get_ticket_solutions': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSolutions(id));
      }
      case 'glpi_get_ticket_validations': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketValidations(id));
      }
      case 'glpi_get_ticket_documents': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketDocuments(id));
      }

      // ==== TICKETS — write ====
      case 'glpi_create_ticket': {
        const validated = ticketCreateSchema.parse(args);
        const result = await client.createTicket({
          name: validated.name,
          content: validated.content,
          urgency: validated.urgency ?? 3,
          impact: (args.impact as number) ?? validated.urgency ?? 3,
          priority: validated.priority,
          type: validated.type ?? 1,
          itilcategories_id: validated.itilcategories_id ?? (args.category_id as number),
          entities_id: validated.entities_id ?? (args.entity_id as number),
          _users_id_assign: validated.users_id_assign ?? (args.user_id_assign as number),
          _groups_id_assign: validated.groups_id_assign ?? (args.group_id_assign as number),
          _users_id_requester: args.requester_user_id as number,
          _groups_id_requester: args.requester_group_id as number,
          time_to_resolve: args.time_to_resolve as string,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_update_ticket': {
        const validated = ticketUpdateSchema.parse(args);
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateTicket(validated.id, updates as any);
        return text({ success: true, id: validated.id });
      }

      case 'glpi_delete_ticket': {
        const validated = ticketDeleteSchema.parse(args);
        await client.deleteTicket(validated.id, validated.force);
        return text({ success: true, id: validated.id, purged: !!validated.force });
      }

      case 'glpi_add_followup': {
        const validated = followupCreateSchema.parse(args);
        const result = await client.addTicketFollowup(validated.ticket_id, validated.content, validated.is_private);
        return text({ success: true, followup_id: result.id });
      }

      case 'glpi_add_task': {
        const validated = taskCreateSchema.parse(args);
        const result = await client.addTicketTask(validated.ticket_id, validated.content, {
          is_private: validated.is_private,
          actiontime: validated.actiontime,
          state: validated.state,
          users_id_tech: validated.users_id_tech,
          groups_id_tech: validated.groups_id_tech,
        });
        return text({ success: true, task_id: result.id });
      }

      case 'glpi_add_solution': {
        const validated = solutionCreateSchema.parse(args);
        const result = await client.addTicketSolution(validated.ticket_id, validated.content, validated.solutiontypes_id);
        return text({ success: true, solution_id: result.id });
      }

      case 'glpi_assign_ticket': {
        const validated = ticketAssignSchema.parse(args);
        const result = await client.assignTicket(validated.ticket_id, {
          users_id: validated.user_id,
          groups_id: validated.group_id,
          type: validated.type,
        });
        return text({ success: true, assignment_id: result.id });
      }

      case 'glpi_link_tickets': {
        const validated = linkTicketsSchema.parse(args);
        const result = await client.linkTickets(validated.parent_id, validated.child_id, validated.link_type);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_add_ticket_validation': {
        const validated = ticketValidationSchema.parse(args);
        const result = await client.addTicketValidation(validated.ticket_id, {
          users_id_validate: validated.users_id_validate,
          comment_submission: validated.comment_submission,
        });
        return text({ success: true, validation_id: result.id });
      }

      case 'glpi_set_validation_status': {
        const validated = setValidationStatusSchema.parse(args);
        await client.setTicketValidationStatus(
          validated.validation_id,
          validated.status,
          validated.comment_validation
        );
        return text({ success: true, validation_id: validated.validation_id, status_label: VALIDATION_STATUS[validated.status] });
      }

      case 'glpi_upload_document': {
        const validated = uploadDocumentSchema.parse(args);
        const safeFile = await resolveSafePath(validated.file_path);
        let data: Uint8Array;
        try {
          data = await readFile(safeFile.resolvedPath);
        } catch (err) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `cannot read file "${validated.file_path}": ${err instanceof Error ? err.message : err}`
          );
        }
        const document = await client.uploadDocument({
          filename: safeFile.filename,
          data,
          name: validated.name,
          mimeType: safeFile.mimeType,
          ...(validated.ticket_id ? { itemtype: 'Ticket', items_id: validated.ticket_id } : {}),
        });
        return text({
          success: true,
          document_id: document.id,
          ...(validated.ticket_id ? { ticket_id: validated.ticket_id } : {}),
        });
      }

      case 'glpi_attach_document_to_ticket': {
        const validated = attachDocumentSchema.parse(args);
        const result = await client.attachDocumentToTicket(validated.ticket_id, validated.document_id);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_get_ticket_satisfaction': {
        const ticket_id = args.ticket_id as number;
        if (!ticket_id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSatisfaction(ticket_id));
      }

      case 'glpi_list_overdue_tickets': {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const criteria: SearchCriterion[] = [
          { field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 },
          // time_to_resolve search-option id is typically 18; fall back to 18.
          { field: 18, searchtype: 'lessthan', value: now, link: 'AND' },
          { field: 18, searchtype: 'notempty', value: '', link: 'AND' },
        ];
        if (args.entity_id !== undefined) {
          criteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
        }
        const result = await client.search.search('Ticket', {
          criteria,
          limit: (args.limit as number) ?? 50,
          expandDropdowns: true,
          order: 'ASC',
          sort: 18,
        });
        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      // ==== PROBLEMS / CHANGES ====
      case 'glpi_list_problems': {
        const list = await client.getProblems({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((p: any) => ({
          id: p.id, name: p.name,
          status: PROBLEM_STATUS[p.status] ?? p.status,
          urgency: TICKET_URGENCY[p.urgency] ?? p.urgency,
          date: p.date,
        })));
      }
      case 'glpi_get_problem': {
        const id = args.id as number;
        const p = await client.getProblem(id);
        return text({
          ...p,
          status_label: PROBLEM_STATUS[(p as any).status],
          urgency_label: TICKET_URGENCY[(p as any).urgency],
        });
      }
      case 'glpi_create_problem': {
        const result = await client.createProblem({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_problem': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProblem(id, updates as any);
        return text({ success: true, id });
      }

      case 'glpi_list_changes': {
        const list = await client.getChanges({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((c: any) => ({
          id: c.id, name: c.name,
          status: CHANGE_STATUS[c.status] ?? c.status,
          urgency: TICKET_URGENCY[c.urgency] ?? c.urgency,
          date: c.date,
        })));
      }
      case 'glpi_get_change': {
        const id = args.id as number;
        const c = await client.getChange(id);
        return text({
          ...c,
          status_label: CHANGE_STATUS[(c as any).status],
          urgency_label: TICKET_URGENCY[(c as any).urgency],
        });
      }
      case 'glpi_create_change': {
        const result = await client.createChange({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_change': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateChange(id, updates as any);
        return text({ success: true, id });
      }

      // ==== ASSETS ====
      case 'glpi_list_computers':
        return text(await client.getComputers(parseListArgs(args)));
      case 'glpi_get_computer':
        return text(await client.getComputer(args.id as number, {
          with_softwares: args.with_softwares as boolean,
          with_connections: args.with_connections as boolean,
          with_networkports: args.with_networkports as boolean,
          with_documents: args.with_documents as boolean,
        }));
      case 'glpi_create_computer':
        return text({ success: true, ...(await client.createComputer(args)) });
      case 'glpi_update_computer': {
        const id = args.id as number;
        const updates = { ...args }; delete (updates as any).id;
        await client.updateComputer(id, updates as any);
        return text({ success: true, id });
      }
      case 'glpi_delete_computer':
        await client.deleteComputer(args.id as number, args.force as boolean);
        return text({ success: true, id: args.id, purged: !!args.force });

      case 'glpi_list_softwares':
        return text(await client.getSoftwares(parseListArgs(args)));
      case 'glpi_get_software':
        return text(await client.getSoftware(args.id as number));
      case 'glpi_create_software':
        return text({ success: true, ...(await client.createSoftware(args)) });

      case 'glpi_list_network_equipments':
        return text(await client.getNetworkEquipments(parseListArgs(args)));
      case 'glpi_get_network_equipment':
        return text(await client.getNetworkEquipment(args.id as number, {
          with_networkports: args.with_networkports as boolean,
        }));

      case 'glpi_list_printers':
        return text(await client.getPrinters(parseListArgs(args)));
      case 'glpi_get_printer':
        return text(await client.getPrinter(args.id as number));

      case 'glpi_list_monitors':
        return text(await client.getMonitors(parseListArgs(args)));
      case 'glpi_get_monitor':
        return text(await client.getMonitor(args.id as number));

      case 'glpi_list_phones':
        return text(await client.getPhones(parseListArgs(args)));
      case 'glpi_get_phone':
        return text(await client.getPhone(args.id as number));

      // ==== KB / CONTRACTS / SUPPLIERS / LOCATIONS / PROJECTS ====
      case 'glpi_list_knowbase':
        return text(await client.getKnowbaseItems(parseListArgs(args)));
      case 'glpi_get_knowbase_item':
        return text(await client.getKnowbaseItem(args.id as number));
      case 'glpi_search_knowbase':
        return text(await client.searchKnowbase(args.query as string, (args.limit as number) ?? 50));
      case 'glpi_create_knowbase_item': {
        const result = await client.createKnowbaseItem({
          name: args.name as string,
          answer: args.answer as string,
          is_faq: args.is_faq ? 1 : 0,
          knowbaseitemcategories_id: args.knowbaseitemcategories_id as number,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_list_contracts':
        return text(await client.getContracts(parseListArgs(args)));
      case 'glpi_get_contract':
        return text(await client.getContract(args.id as number));
      case 'glpi_create_contract':
        return text({ success: true, ...(await client.createContract(args)) });

      case 'glpi_list_suppliers':
        return text(await client.getSuppliers(parseListArgs(args)));
      case 'glpi_get_supplier':
        return text(await client.getSupplier(args.id as number));
      case 'glpi_create_supplier':
        return text({ success: true, ...(await client.createSupplier(args)) });

      case 'glpi_list_locations':
        return text(await client.getLocations(parseListArgs(args)));
      case 'glpi_get_location':
        return text(await client.getLocation(args.id as number));
      case 'glpi_create_location':
        return text({ success: true, ...(await client.createLocation(args)) });

      case 'glpi_list_projects':
        return text(await client.getProjects(parseListArgs(args)));
      case 'glpi_get_project':
        return text(await client.getProject(args.id as number));
      case 'glpi_create_project':
        return text({ success: true, ...(await client.createProject(args)) });
      case 'glpi_update_project': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'percent_done', 'real_start_date', 'real_end_date'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProject(id, updates as any);
        return text({ success: true, id });
      }

      // ==== USERS / GROUPS ====
      case 'glpi_list_users':
        return text(await client.getUsers({
          ...parseListArgs(args),
          is_active: args.active_only === false ? false : true,
        }));
      case 'glpi_get_user':
        return text(await client.getUser(args.id as number));
      case 'glpi_search_user':
        return text(await client.getUserByName(args.name as string));
      case 'glpi_create_user':
        return text({ success: true, ...(await client.createUser({
          name: args.name as string,
          password: args.password as string,
          realname: args.realname as string,
          firstname: args.firstname as string,
          email: args.email as string,
          phone: args.phone as string,
          profiles_id: args.profiles_id as number,
        })) });

      case 'glpi_list_groups':
        return text(await client.getGroups(parseListArgs(args)));
      case 'glpi_get_group':
        return text(await client.getGroup(args.id as number));
      case 'glpi_create_group':
        return text({ success: true, ...(await client.createGroup({
          name: args.name as string,
          comment: args.comment as string,
          is_requester: args.is_requester ? 1 : 0,
          is_assign: args.is_assign ? 1 : 0,
        })) });
      case 'glpi_add_user_to_group':
        return text({ success: true, ...(await client.addUserToGroup(
          args.user_id as number,
          args.group_id as number,
          args.is_manager as boolean
        )) });

      case 'glpi_list_categories':
        return text(await client.getCategories(parseListArgs(args)));
      case 'glpi_list_entities':
        return text(await client.getEntities(parseListArgs(args)));
      case 'glpi_get_entity':
        return text(await client.getEntity(args.id as number));
      case 'glpi_list_documents':
        return text(await client.getDocuments(parseListArgs(args)));
      case 'glpi_get_document':
        return text(await client.getDocument(args.id as number));

      // ==== STATS ====
      case 'glpi_get_ticket_stats': {
        const stats = await client.getTicketStats({
          entity_id: args.entity_id as number,
          date_from: args.date_from as string,
          date_to: args.date_to as string,
        });
        return text({
          ...stats,
          summary: `${stats.total} tickets — new:${stats.new} processing:${stats.processing} pending:${stats.pending} solved:${stats.solved} closed:${stats.closed}`,
        });
      }

      case 'glpi_get_asset_stats': {
        const stats = await client.getAssetStats();
        return text({ ...stats, total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones });
      }

      case 'glpi_tickets_stats_by': {
        const dimension = args.dimension as 'status' | 'category' | 'technician' | 'entity' | 'month';
        const base: SearchCriterion[] = [];
        if (args.entity_id !== undefined) base.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.date_from) base.push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string, link: 'AND' });
        if (args.date_to) base.push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string, link: 'AND' });

        const counts: Record<string, number> = {};

        if (dimension === 'status') {
          for (const [statusId, label] of Object.entries(TICKET_STATUS)) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.status, searchtype: 'equals', value: Number(statusId) },
              ...base.map((b, i) => ({ ...b, link: 'AND' as const })),
            ];
            counts[label] = await client.search.count('Ticket', c);
          }
        } else if (dimension === 'category') {
          const cats = await client.getCategories({ range: '0-199' });
          for (const cat of cats as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.category, searchtype: 'equals', value: cat.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[cat.completename ?? cat.name] = n;
          }
        } else if (dimension === 'technician') {
          const users = await client.getUsers({ range: '0-199', is_active: true });
          for (const u of users) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: u.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[`${u.firstname ?? ''} ${u.realname ?? ''} (${u.name})`.trim()] = n;
          }
        } else if (dimension === 'entity') {
          const entities = await client.getEntities({ range: '0-99' });
          for (const e of entities as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.entity, searchtype: 'equals', value: e.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[e.completename ?? e.name] = n;
          }
        } else if (dimension === 'month') {
          // Compute monthly buckets between date_from and date_to (or last 6 months).
          const to = args.date_to ? new Date(args.date_to as string) : new Date();
          const from = args.date_from ? new Date(args.date_from as string) : new Date(to.getFullYear(), to.getMonth() - 5, 1);
          const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
          while (cursor <= to) {
            const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
            const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            const fmt = (d: Date) => d.toISOString().slice(0, 10) + ' 00:00:00';
            const monthCriteria: SearchCriterion[] = [
              { field: TICKET_FIELDS.date, searchtype: 'morethan', value: fmt(monthStart) },
              { field: TICKET_FIELDS.date, searchtype: 'lessthan', value: fmt(monthEnd), link: 'AND' },
            ];
            if (args.entity_id !== undefined) {
              monthCriteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
            }
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            counts[key] = await client.search.count('Ticket', monthCriteria);
            cursor.setMonth(cursor.getMonth() + 1);
          }
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unknown dimension: ${dimension}`);
        }

        return text({ dimension, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) });
      }

      // ==== SESSION ====
      case 'glpi_get_session_info': {
        const [profile, profiles, entities] = await Promise.all([
          client.getActiveProfile(),
          client.getMyProfiles(),
          client.getMyEntities(),
        ]);
        return text({ active_profile: profile, available_profiles: profiles, entities });
      }

      // ==== SEARCH ====
      case 'glpi_search_v2': {
        const rawItemtype = args.itemtype as string;
        if (!rawItemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const itemtype = validateItemtype(rawItemtype);
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const result = await client.search.search(itemtype, {
          criteria,
          forcedisplay: args.forcedisplay as number[],
          start: args.start as number,
          limit: args.limit as number,
          sort: args.sort as number,
          order: args.order as 'ASC' | 'DESC',
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          expandDropdowns: args.expand_dropdowns !== false,
        });
        return text(result);
      }

      case 'glpi_count': {
        const rawItemtype = args.itemtype as string;
        if (!rawItemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const itemtype = validateItemtype(rawItemtype);
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const totalcount = await client.search.count(itemtype, criteria);
        return text({ itemtype, totalcount });
      }

      case 'glpi_list_search_options': {
        const rawItemtype = args.itemtype as string;
        if (!rawItemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const itemtype = validateItemtype(rawItemtype);
        const cat = await client.searchOptions.get(itemtype);
        const entries = Array.from(cat.byId.values()).map((o) => ({
          id: o.id, name: o.name, uid: o.uid, table: o.table,
          field: o.field, datatype: o.datatype,
          available_searchtypes: o.available_searchtypes,
        }));
        return text({ itemtype, count: entries.length, options: entries });
      }

      // legacy
      case 'glpi_search': {
        const rawItemtype = args.itemtype as string;
        const field = args.field as number;
        const searchtype = args.searchtype as SearchType;
        const value = args.value as string;
        if (!rawItemtype || field === undefined || !searchtype || value === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'itemtype, field, searchtype, value required');
        }
        const itemtype = validateItemtype(rawItemtype);
        const result = await client.search.search(itemtype, {
          criteria: [{ field, searchtype, value }],
          expandDropdowns: true,
        });
        return text(result);
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}: ${issues}`);
    }
    if (error instanceof GlpiError) {
      const detail = error.glpiCode
        ? `${error.glpiCode}${error.glpiMessage ? ' — ' + error.glpiMessage : ''}`
        : error.message;
      throw new McpError(
        ErrorCode.InternalError,
        `GLPI API error on ${name} (HTTP ${error.status}): ${detail}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const ALL_RESOURCES = [
  { uri: 'glpi://tickets/open', name: 'Tickets Abiertos', description: 'Tickets con estado menor a 5 (no resueltos ni cerrados)', mimeType: 'application/json' },
  { uri: 'glpi://tickets/recent', name: 'Tickets Recientes', description: 'Últimos 20 tickets actualizados o creados', mimeType: 'application/json' },
  { uri: 'glpi://problems/open', name: 'Problemas Abiertos', description: 'Problemas activos no cerrados', mimeType: 'application/json' },
  { uri: 'glpi://changes/pending', name: 'Cambios Pendientes', description: 'Solicitudes de cambio en proceso', mimeType: 'application/json' },
  { uri: 'glpi://computers', name: 'Computadoras', description: 'Inventario de computadoras', mimeType: 'application/json' },
  { uri: 'glpi://groups', name: 'Grupos', description: 'Grupos y equipos de trabajo', mimeType: 'application/json' },
  { uri: 'glpi://categories', name: 'Categorías', description: 'Categorías ITIL para tickets', mimeType: 'application/json' },
  { uri: 'glpi://stats/tickets', name: 'Estadísticas de Tickets', description: 'Conteo de tickets por estado', mimeType: 'application/json' },
  { uri: 'glpi://stats/assets', name: 'Estadísticas de Activos', description: 'Conteo de equipos por tipo de activo', mimeType: 'application/json' },
];

export async function executeResource(uri: string) {
  try {
    switch (uri) {
      case 'glpi://tickets/open': {
        const result = await client.search.search('Ticket', {
          criteria: [{ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 }],
          limit: 100,
          order: 'DESC',
          sort: TICKET_FIELDS.date_mod,
          expandDropdowns: true,
        });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }] };
      }
      case 'glpi://tickets/recent': {
        const tickets = await client.getTickets({ range: '0-19', order: 'DESC', expand_dropdowns: true });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tickets, null, 2) }] };
      }
      case 'glpi://problems/open': {
        const problems = await client.getProblems({ range: '0-99' });
        const open = (problems as any[]).filter((p) => p.status < 5);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(open, null, 2) }] };
      }
      case 'glpi://changes/pending': {
        const changes = await client.getChanges({ range: '0-99' });
        const pending = (changes as any[]).filter((c) => c.status < 8);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(pending, null, 2) }] };
      }
      case 'glpi://computers':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getComputers({ range: '0-99', is_deleted: false }), null, 2) }] };
      case 'glpi://groups':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getGroups({ range: '0-99' }), null, 2) }] };
      case 'glpi://categories':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getCategories({ range: '0-99' }), null, 2) }] };
      case 'glpi://stats/tickets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getTicketStats(), null, 2) }] };
      case 'glpi://stats/assets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getAssetStats(), null, 2) }] };
      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error reading resource: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function registerHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[MCP] Request 'tools/list' received -> responding with ${ALL_TOOLS.length} tools`);
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: argsRaw } = request.params;
    const args = (argsRaw ?? {}) as Record<string, unknown>;
    console.error(`[MCP] Request 'tools/call' received -> tool: ${name}`);
    return executeTool(name, args);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ALL_RESOURCES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return executeResource(request.params.uri);
  });
}

export async function handleJsonRpcMessage(glpiClient: GlpiClient, message: any): Promise<any> {
  client = glpiClient;
  const id = message?.id ?? null;
  const method = message?.method;
  const params = message?.params ?? {};

  console.error(`[MCP-HTTP] Handling JSON-RPC method '${method}' (id: ${id})`);

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: 'mcp-glpi',
              version: '3.4.0',
            },
          },
        };

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        console.error(`[MCP-HTTP] Responding to tools/list with ${ALL_TOOLS.length} tools`);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: ALL_TOOLS,
          },
        };

      case 'tools/call': {
        const toolName = params.name;
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        console.error(`[MCP-HTTP] Calling tool '${toolName}'`);
        const result = await executeTool(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      }

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: ALL_RESOURCES,
          },
        };

      case 'resources/read': {
        const uri = params.uri;
        const result = await executeResource(uri);
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      }

      default:
        console.error(`[MCP-HTTP] Unknown method '${method}'`);
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    console.error(`[MCP-HTTP ERROR] in method '${method}':`, error);
    const code = error instanceof McpError ? error.code : -32603;
    const message = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    };
  }
}

export function createMcpServer(glpiClient: GlpiClient): Server {
  client = glpiClient;
  const server = new Server(
    { name: 'mcp-glpi', version: '3.4.0' },
    { capabilities: { tools: {}, resources: {} } }
  );
  registerHandlers(server);
  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    const config = getConfig();
    client = new GlpiClient(config);

    const isSse = !!process.env.PORT || process.env.MCP_TRANSPORT === 'sse';
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

    console.error('====================================================');
    console.error('🚀 MCP GLPI Server v3.4.0');
    console.error(`📡 Mode: ${isSse ? `HTTP/SSE on port ${port}` : 'stdio'}`);
    console.error(`🔗 GLPI URL: ${config.url}`);
    console.error(`🔒 HTTPS Enforcement: ${config.url.startsWith('http://') ? 'DISABLED (Insecure HTTP permitted via GLPI_ALLOW_HTTP)' : 'ACTIVE (HTTPS required)'}`);
    console.error(`🔑 Authentication: ${config.userToken ? 'User Token configured' : 'Username/Password configured'}`);
    if (config.appToken) console.error('🏷️  App Token: Configured');
    console.error(`🛡️  MCP Auth Token: ${process.env.MCP_AUTH_TOKEN ? 'PROTECTED (Bearer token configured)' : 'OPEN (No MCP_AUTH_TOKEN configured)'}`);
    console.error('----------------------------------------------------');
    console.error(`⏳ Connecting to GLPI at ${config.url}...`);

    // Try to open the session eagerly, but don't die if GLPI is momentarily
    // unreachable: the HTTP layer re-authenticates lazily on first request.
    try {
      const sessionToken = await client.initSession();
      console.error('✅ [GLPI CONNECTED] Successfully authenticated to GLPI!');
      console.error(`   Session Token: ${sessionToken ? sessionToken.slice(0, 8) + '...' : 'active'}`);
    } catch (error) {
      console.error('❌ [GLPI CONNECTION FAILED]');
      console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof GlpiError) {
        console.error(`   HTTP Status: ${error.status}`);
        if (error.glpiCode) console.error(`   GLPI Code: ${error.glpiCode}`);
        if (error.glpiMessage) console.error(`   GLPI Message: ${error.glpiMessage}`);
      }
      console.error('   ⚠️ Note: The server will remain up, and will retry authentication when requests are executed.');
    }
    console.error('====================================================');

    if (isSse) {
      const sseServer = createHttpSseServer(client, () => createMcpServer(client), {
        port,
        authToken: process.env.MCP_AUTH_TOKEN,
        handleJsonRpc: (msg) => handleJsonRpcMessage(client, msg),
      });
      await sseServer.start();

      const shutdown = async () => {
        try {
          await sseServer.close();
          await client.killSession();
        } catch (error) {
          console.error('Warning during shutdown:', error instanceof Error ? error.message : error);
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } else {
      const server = createMcpServer(client);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error('MCP GLPI Server v3.4.0 running on stdio');

      const shutdown = async () => {
        try {
          await client.killSession();
        } catch (error) {
          console.error('Warning: killSession failed during shutdown:', error instanceof Error ? error.message : error);
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

const isTesting =
  process.env.NODE_TEST_CONTEXT !== undefined ||
  process.argv.some((a) => a.includes('test') || a.includes('tsx'));

if (!isTesting) {
  main();
}
