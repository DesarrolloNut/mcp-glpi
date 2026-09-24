/**
 * SearchOptions cache + helpers.
 *
 * GLPI exposes `/listSearchOptions/{itemtype}` which returns the catalogue of
 * searchable fields for an itemtype. Each entry is keyed by a numeric field_id
 * and carries human-readable metadata (name, table, datatype, available_searchtypes).
 *
 * We cache the catalogue per itemtype (TTL configurable, default 1h) so that:
 *   - high-level tools can translate friendly param names → criteria field_id
 *   - list/search responses can be enriched with field labels
 */

import { GlpiHttp } from './http.js';
import { validateItemtype } from './itemtype-security.js';

export interface SearchOption {
  id: number;
  name: string;
  table?: string;
  field?: string;
  datatype?: string;
  uid?: string;
  available_searchtypes?: string[];
  /** Raw entry from GLPI, kept for debugging / advanced cases. */
  raw: Record<string, unknown>;
}

export interface SearchOptionsCatalogue {
  itemtype: string;
  fetchedAt: number;
  byId: Map<number, SearchOption>;
  byUid: Map<string, SearchOption>;
  byName: Map<string, SearchOption>;
  /** Keyed by raw SQL column name (locale-independent). Own-table options win collisions. */
  byField: Map<string, SearchOption>;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class SearchOptionsCache {
  private cache: Map<string, SearchOptionsCatalogue> = new Map();
  private ttlMs: number;

  constructor(private http: GlpiHttp, ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(itemtype: string): Promise<SearchOptionsCatalogue> {
    const validItemtype = validateItemtype(itemtype);
    const cached = this.cache.get(validItemtype);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;

    const { data } = await this.http.request<Record<string, unknown>>(
      `listSearchOptions/${validItemtype}`
    );

    const catalogue = this.parse(validItemtype, data);
    this.cache.set(validItemtype, catalogue);
    return catalogue;
  }

  /** Invalidate cache for one itemtype, or all if no argument. */
  invalidate(itemtype?: string) {
    if (itemtype) this.cache.delete(validateItemtype(itemtype));
    else this.cache.clear();
  }

  /**
   * Resolve a friendly name to a field_id.
   *
   * Lookup order (most to least precise):
   *   1. numeric id passed through
   *   2. explicit uid ("Ticket.status")
   *   3. canonical own-table uid built as "{itemtype}.{ref}" — locale-independent
   *   4. localized label ("Statut", "Status", ...)
   *   5. raw SQL column name ("status") — locale-independent fallback
   */
  async resolveField(itemtype: string, ref: string | number): Promise<number | undefined> {
    if (typeof ref === 'number') return ref;
    if (/^\d+$/.test(ref)) return parseInt(ref, 10);

    const cat = await this.get(itemtype);
    const direct =
      cat.byUid.get(ref) ??
      cat.byUid.get(`${itemtype}.${ref}`) ??
      cat.byName.get(ref.toLowerCase()) ??
      cat.byField.get(ref.toLowerCase());
    return direct?.id;
  }

  /**
   * Normalize a single search result row by translating numeric field IDs to canonical field names.
   */
  async normalizeRow(
    itemtype: string,
    rawRow: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const cat = await this.get(itemtype);
    return this.normalizeRowWithCatalogue(cat, rawRow);
  }

  /**
   * Normalize multiple search result rows using the cached catalogue for the itemtype.
   */
  async normalizeRows(
    itemtype: string,
    rows: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    if (!rows || rows.length === 0) return [];
    const cat = await this.get(itemtype);
    return rows.map((r) => this.normalizeRowWithCatalogue(cat, r));
  }

  /**
   * Internal helper to normalize a row given an already fetched catalogue.
   */
  normalizeRowWithCatalogue(
    cat: SearchOptionsCatalogue,
    rawRow: Record<string, unknown>
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(rawRow)) {
      const fieldId = parseInt(key, 10);
      if (Number.isNaN(fieldId)) {
        // Already a named property (not numeric search-option ID)
        normalized[key] = value;
        continue;
      }

      const opt = cat.byId.get(fieldId);
      if (!opt) {
        normalized[key] = value;
        continue;
      }

      const canonicalField = opt.field?.toLowerCase();
      const isDirectOwnTable = opt.uid === `${cat.itemtype}.${opt.field}`;

      let propName: string;
      if (canonicalField && isDirectOwnTable && !(canonicalField in normalized)) {
        propName = canonicalField;
      } else if (canonicalField && !(canonicalField in normalized)) {
        propName = canonicalField;
      } else {
        const cleanName = opt.name
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (cleanName && !(cleanName in normalized)) {
          propName = cleanName;
        } else if (canonicalField) {
          propName = `${canonicalField}_${fieldId}`;
        } else {
          propName = `field_${fieldId}`;
        }
      }

      normalized[propName] = value;
    }

    return normalized;
  }

  private parse(itemtype: string, data: Record<string, unknown>): SearchOptionsCatalogue {
    const byId = new Map<number, SearchOption>();
    const byUid = new Map<string, SearchOption>();
    const byName = new Map<string, SearchOption>();
    const byField = new Map<string, SearchOption>();

    for (const [key, value] of Object.entries(data)) {
      const id = parseInt(key, 10);
      if (Number.isNaN(id)) continue; // skip metadata entries like "common"
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;

      const option: SearchOption = {
        id,
        name: typeof entry.name === 'string' ? entry.name : String(id),
        table: typeof entry.table === 'string' ? entry.table : undefined,
        field: typeof entry.field === 'string' ? entry.field : undefined,
        datatype: typeof entry.datatype === 'string' ? entry.datatype : undefined,
        uid: typeof entry.uid === 'string' ? entry.uid : undefined,
        available_searchtypes: Array.isArray(entry.available_searchtypes)
          ? (entry.available_searchtypes as string[])
          : undefined,
        raw: entry,
      };

      byId.set(id, option);
      if (option.uid && !byUid.has(option.uid)) byUid.set(option.uid, option);
      if (option.name && !byName.has(option.name.toLowerCase())) {
        byName.set(option.name.toLowerCase(), option);
      }
      // The same column name can appear via joined tables (e.g. "name" on
      // glpi_tickets AND glpi_users for requester/technician). The option
      // whose uid is exactly "{itemtype}.{field}" (own table) always wins.
      if (option.field) {
        const fieldKey = option.field.toLowerCase();
        const isCanonical = option.uid === `${itemtype}.${option.field}`;
        if (isCanonical || !byField.has(fieldKey)) byField.set(fieldKey, option);
      }
    }

    return { itemtype, fetchedAt: Date.now(), byId, byUid, byName, byField };
  }
}
