/**
 * High-level search/count/fetch_all over GLPI's /search/{itemtype} endpoint.
 *
 * Features:
 *   - Multi-criteria with link operator (AND / OR / AND NOT / OR NOT).
 *   - forcedisplay (choose returned columns).
 *   - Reads totalcount + Content-Range header.
 *   - fetch_all: paginates until totalcount reached, capped by maxRows.
 *   - Optional sort + order.
 */

import { GlpiHttp } from './http.js';
import { validateItemtype } from './itemtype-security.js';

export type SearchType =
  | 'contains'
  | 'notcontains'
  | 'equals'
  | 'notequals'
  | 'lessthan'
  | 'morethan'
  | 'under'
  | 'notunder'
  | 'empty'
  | 'notempty';

export type SearchLink = 'AND' | 'OR' | 'AND NOT' | 'OR NOT';

export interface SearchCriterion {
  field: number;
  searchtype: SearchType;
  value: string | number | boolean;
  /** Combination operator with the previous criterion. Ignored on the first one. */
  link?: SearchLink;
}

export interface SearchOptions {
  criteria?: SearchCriterion[];
  /** field_id list to return; if undefined, GLPI uses its default. */
  forcedisplay?: number[];
  /** First row (0-indexed). */
  start?: number;
  /** Maximum rows for this single call. */
  limit?: number;
  /** Sort by field_id (search option id). */
  sort?: number;
  order?: 'ASC' | 'DESC';
  /** If true, paginate until totalcount is reached (or maxRows is hit). */
  fetchAll?: boolean;
  /** Safety cap when fetchAll=true (default 1000). */
  maxRows?: number;
  /** Pass `expand_dropdowns=true` for resolved labels. */
  expandDropdowns?: boolean;
  /** Pass `giveItems=true` to receive raw items. */
  giveItems?: boolean;
}

export interface SearchResponse<T = Record<string, unknown>> {
  itemtype: string;
  totalcount: number;
  count: number;
  start: number;
  data: T[];
  /** Raw Content-Range header value, if present. */
  contentRange?: string;
}

const DEFAULT_PAGE = 100;
const DEFAULT_MAX_ROWS = 1000;

export class GlpiSearch {
  constructor(private http: GlpiHttp) {}

  /**
   * Execute a search call (single page or fetch_all loop).
   */
  async search<T = Record<string, unknown>>(
    itemtype: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse<T>> {
    const validItemtype = validateItemtype(itemtype);
    if (options.fetchAll) return this.fetchAll<T>(validItemtype, options);

    const start = options.start ?? 0;
    const limit = options.limit ?? DEFAULT_PAGE;
    // GLPI ranges are inclusive: "0-4" returns 5 rows.
    return this.fetchPage<T>(validItemtype, options, start, start + Math.max(1, limit) - 1);
  }

  /**
   * Return only totalcount for the given criteria. Cheap probe (range=0-0).
   */
  async count(
    itemtype: string,
    criteria: SearchCriterion[] = []
  ): Promise<number> {
    const validItemtype = validateItemtype(itemtype);
    const res = await this.fetchPage(validItemtype, { criteria }, 0, 0);
    return res.totalcount;
  }

  private async fetchPage<T>(
    itemtype: string,
    options: SearchOptions,
    start: number,
    end: number
  ): Promise<SearchResponse<T>> {
    const params = new URLSearchParams();

    (options.criteria ?? []).forEach((c, i) => {
      params.append(`criteria[${i}][field]`, String(c.field));
      params.append(`criteria[${i}][searchtype]`, c.searchtype);
      params.append(`criteria[${i}][value]`, String(c.value));
      if (i > 0 && c.link) params.append(`criteria[${i}][link]`, c.link);
    });

    (options.forcedisplay ?? []).forEach((id, i) => {
      params.append(`forcedisplay[${i}]`, String(id));
    });

    params.append('range', `${start}-${end}`);
    if (options.sort !== undefined) params.append('sort', String(options.sort));
    if (options.order) params.append('order', options.order);
    if (options.expandDropdowns) params.append('expand_dropdowns', 'true');
    if (options.giveItems) params.append('giveItems', 'true');

    const { data, headers } = await this.http.request<{
      totalcount?: number;
      count?: number;
      data?: T[];
    }>(`search/${itemtype}`, { query: params });

    const contentRange = headers.get('content-range') ?? undefined;
    let totalcount = data.totalcount ?? 0;
    if (!totalcount && contentRange) {
      // Format: "start-end/total"
      const match = contentRange.match(/\/(\d+)$/);
      if (match) totalcount = parseInt(match[1], 10);
    }

    return {
      itemtype,
      totalcount,
      count: data.count ?? (data.data?.length ?? 0),
      start,
      data: data.data ?? [],
      contentRange,
    };
  }

  private async fetchAll<T>(
    itemtype: string,
    options: SearchOptions
  ): Promise<SearchResponse<T>> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pageSize = options.limit ?? DEFAULT_PAGE;
    let cursor = options.start ?? 0;
    const collected: T[] = [];
    let totalcount = 0;
    let contentRange: string | undefined;

    while (collected.length < maxRows) {
      const remaining = maxRows - collected.length;
      const thisPage = Math.min(pageSize, remaining);
      const end = cursor + thisPage - 1;

      const page = await this.fetchPage<T>(itemtype, options, cursor, end);
      totalcount = page.totalcount;
      contentRange = page.contentRange;

      collected.push(...page.data);
      cursor += page.data.length;

      if (page.data.length === 0) break;
      if (totalcount && cursor >= totalcount) break;
    }

    return {
      itemtype,
      totalcount,
      count: collected.length,
      start: options.start ?? 0,
      data: collected,
      contentRange,
    };
  }
}
