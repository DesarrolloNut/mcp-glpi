import { z } from 'zod';

export const listArgsSchema = z.object({
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  range: z.string().optional(),
  sort: z.union([z.number().int(), z.string()]).optional(),
  order: z.enum(['ASC', 'DESC']).optional(),
  expand_dropdowns: z.boolean().optional(),
  criteria: z.array(z.unknown()).optional(),
  fetch_all: z.boolean().optional(),
}).passthrough();

export const ticketReadSchema = z.object({
  id: z.number().int().positive(),
  with_logs: z.boolean().optional(),
}).passthrough();

export const ticketSearchSchema = z.object({
  status: z.number().int().min(1).max(6).optional(),
  assigned_user_id: z.number().int().positive().optional(),
  assigned_group_id: z.number().int().positive().optional(),
  requester_user_id: z.number().int().positive().optional(),
  category_id: z.number().int().positive().optional(),
  entity_id: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  urgency: z.number().int().min(1).max(5).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  text_search: z.string().max(500).optional(),
  open_only: z.boolean().optional(),
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
}).passthrough();

export const ticketCreateSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(100_000),
  urgency: z.number().int().min(1).max(5).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  itilcategories_id: z.number().int().positive().optional(),
  type: z.number().int().min(1).max(2).optional(),
  entities_id: z.number().int().min(0).optional(),
  users_id_assign: z.number().int().positive().optional(),
  groups_id_assign: z.number().int().positive().optional(),
}).passthrough();

export const ticketUpdateSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255).optional(),
  content: z.string().min(1).max(100_000).optional(),
  status: z.number().int().min(1).max(6).optional(),
  urgency: z.number().int().min(1).max(5).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  itilcategories_id: z.number().int().positive().optional(),
}).passthrough();

export const ticketDeleteSchema = z.object({
  id: z.number().int().positive(),
  force: z.boolean().optional().default(false),
}).passthrough();

export const followupCreateSchema = z.object({
  ticket_id: z.number().int().positive(),
  content: z.string().min(1).max(100_000),
  is_private: z.boolean().optional().default(false),
}).passthrough();

export const taskCreateSchema = z.object({
  ticket_id: z.number().int().positive(),
  content: z.string().min(1).max(100_000),
  is_private: z.boolean().optional().default(false),
  actiontime: z.number().int().min(0).optional(),
  state: z.number().int().min(0).max(2).optional(),
  users_id_tech: z.number().int().positive().optional(),
  groups_id_tech: z.number().int().positive().optional(),
}).passthrough();

export const solutionCreateSchema = z.object({
  ticket_id: z.number().int().positive(),
  content: z.string().min(1).max(100_000),
  solutiontypes_id: z.number().int().positive().optional(),
}).passthrough();

export const ticketAssignSchema = z
  .object({
    ticket_id: z.number().int().positive(),
    user_id: z.number().int().positive().optional(),
    group_id: z.number().int().positive().optional(),
    type: z.number().int().min(1).max(3).optional(),
  })
  .passthrough()
  .refine((data) => data.user_id !== undefined || data.group_id !== undefined, {
    message: 'user_id or group_id required',
  });

export const linkTicketsSchema = z.object({
  parent_id: z.number().int().positive(),
  child_id: z.number().int().positive(),
  link_type: z.number().int().positive().optional().default(1),
}).passthrough();

export const uploadDocumentSchema = z.object({
  file_path: z.string().min(1, 'file_path required'),
  name: z.string().max(255).optional(),
  ticket_id: z.number().int().positive().optional(),
}).passthrough();

export const attachDocumentSchema = z.object({
  ticket_id: z.number().int().positive(),
  document_id: z.number().int().positive(),
}).passthrough();

export const ticketValidationSchema = z.object({
  ticket_id: z.number().int().positive(),
  users_id_validate: z.number().int().positive(),
  comment_submission: z.string().max(100_000).optional(),
}).passthrough();

export const setValidationStatusSchema = z.object({
  validation_id: z.number().int().positive(),
  status: z.union([z.literal(2), z.literal(3)]),
  comment_validation: z.string().max(100_000).optional(),
}).passthrough();
