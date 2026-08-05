/**
 * GLPI REST API Client v3.0
 *
 * Thin orchestrator on top of:
 *   - GlpiHttp (unified request layer with re-auth + error structuring)
 *   - GlpiSearch (multi-criteria search, count, fetch_all)
 *   - SearchOptionsCache (/listSearchOptions/{itemtype} catalogue)
 *
 * Domain methods keep their v2 names for compatibility, but their behaviour
 * has been hardened:
 *   - All list endpoints accept `range`, `sort`, `order`, `expand_dropdowns`.
 *   - Reading endpoints default to `expand_dropdowns=true` so foreign-key IDs
 *     come back resolved (technician name, category label, entity, ...).
 *   - Bug fixes from v2 audit: is_active filter, group assignment, stats.
 */

import { GlpiHttp, GlpiHttpConfig } from './http.js';
import { GlpiSearch, SearchCriterion } from './search.js';
import { SearchOptionsCache } from './search-options.js';

// ============================================================================
// CONFIG / INTERFACES
// ============================================================================

export interface GlpiConfig extends GlpiHttpConfig {}

export interface GlpiTicket {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  priority: number;
  impact: number;
  type: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  users_id_lastupdater: number;
  itilcategories_id: number;
  entities_id: number;
  time_to_resolve?: string;
  actiontime: number;
}

export interface GlpiUser {
  id: number;
  name: string;
  realname: string;
  firstname: string;
  email: string;
  phone: string;
  mobile: string;
  is_active: number;
  locations_id: number;
  profiles_id: number;
}

export interface GlpiGroup {
  id: number;
  name: string;
  completename: string;
  comment: string;
  entities_id: number;
  is_recursive: number;
}

export interface GlpiCategory {
  id: number;
  name: string;
  completename: string;
  itilcategories_id: number;
  level: number;
}

export interface GlpiComputer {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  operatingsystems_id: number;
  locations_id: number;
  states_id: number;
  computertypes_id: number;
  manufacturers_id: number;
  computermodels_id: number;
  uuid: string;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiSoftware {
  id: number;
  name: string;
  comment: string;
  locations_id: number;
  users_id_tech: number;
  groups_id_tech: number;
  is_helpdesk_visible: number;
  manufacturers_id: number;
  softwarecategories_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiProblem {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  impact: number;
  priority: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  itilcategories_id: number;
  entities_id: number;
}

export interface GlpiChange {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  impact: number;
  priority: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  itilcategories_id: number;
  entities_id: number;
}

export interface GlpiKnowbaseItem {
  id: number;
  name: string;
  answer: string;
  is_faq: number;
  view: number;
  date: string;
  date_mod: string;
  users_id: number;
  knowbaseitemcategories_id: number;
}

export interface GlpiContract {
  id: number;
  name: string;
  num: string;
  contracttypes_id: number;
  begin_date: string;
  duration: number;
  notice: number;
  periodicity: number;
  billing: number;
  comment: string;
  renewal: number;
  entities_id: number;
}

export interface GlpiSupplier {
  id: number;
  name: string;
  suppliertypes_id: number;
  address: string;
  postcode: string;
  town: string;
  state: string;
  country: string;
  website: string;
  phonenumber: string;
  fax: string;
  email: string;
  comment: string;
  entities_id: number;
}

export interface GlpiLocation {
  id: number;
  name: string;
  completename: string;
  locations_id: number;
  address: string;
  postcode: string;
  town: string;
  country: string;
  building: string;
  room: string;
  entities_id: number;
}

export interface GlpiNetworkEquipment {
  id: number;
  name: string;
  ram: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  date_mod: string;
  comment: string;
  locations_id: number;
  networks_id: number;
  networkequipmenttypes_id: number;
  networkequipmentmodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiPrinter {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  have_serial: number;
  have_parallel: number;
  have_usb: number;
  have_wifi: number;
  have_ethernet: number;
  comment: string;
  date_mod: string;
  locations_id: number;
  printertypes_id: number;
  printermodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiMonitor {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  size: number;
  have_micro: number;
  have_speaker: number;
  have_subd: number;
  have_bnc: number;
  have_dvi: number;
  have_pivot: number;
  have_hdmi: number;
  have_displayport: number;
  locations_id: number;
  monitortypes_id: number;
  monitormodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiPhone {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  locations_id: number;
  phonetypes_id: number;
  phonemodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
  firmware: string;
  number_line: string;
  have_headset: number;
  have_hp: number;
}

export interface GlpiEntity {
  id: number;
  name: string;
  completename: string;
  entities_id: number;
  level: number;
  comment: string;
  address: string;
  postcode: string;
  town: string;
  country: string;
  website: string;
  phonenumber: string;
  fax: string;
  email: string;
}

export interface GlpiProject {
  id: number;
  name: string;
  code: string;
  priority: number;
  content: string;
  comment: string;
  date: string;
  date_mod: string;
  plan_start_date: string;
  plan_end_date: string;
  real_start_date: string;
  real_end_date: string;
  percent_done: number;
  projectstates_id: number;
  projecttypes_id: number;
  users_id: number;
  groups_id: number;
  entities_id: number;
}

export interface GlpiDocument {
  id: number;
  name: string;
  filename: string;
  filepath: string;
  mime: string;
  date_mod: string;
  comment: string;
  sha1sum: string;
  documentcategories_id: number;
  users_id: number;
  entities_id: number;
}

// ============================================================================
// LIST / GET OPTIONS
// ============================================================================

export interface ListOptions {
  /** "START-END" range, e.g. "0-49". Default: "0-49". */
  range?: string;
  /** Field id to sort by. */
  sort?: number;
  order?: 'ASC' | 'DESC';
  is_deleted?: boolean;
  expand_dropdowns?: boolean;
  with_networkports?: boolean;
  with_infocoms?: boolean;
  with_contracts?: boolean;
  with_documents?: boolean;
  with_tickets?: boolean;
  with_problems?: boolean;
  with_changes?: boolean;
  with_logs?: boolean;
  /** Free-text "searchText[field]=value" filters. */
  searchText?: Record<string, string>;
}

export interface GetOptions {
  expand_dropdowns?: boolean;
  with_networkports?: boolean;
  with_infocoms?: boolean;
  with_contracts?: boolean;
  with_documents?: boolean;
  with_tickets?: boolean;
  with_problems?: boolean;
  with_changes?: boolean;
  with_logs?: boolean;
  with_softwares?: boolean;
  with_connections?: boolean;
  with_disks?: boolean;
}

// ============================================================================
// CLIENT
// ============================================================================

export class GlpiClient {
  readonly http: GlpiHttp;
  readonly search: GlpiSearch;
  readonly searchOptions: SearchOptionsCache;

  constructor(config: GlpiConfig) {
    this.http = new GlpiHttp(config);
    this.search = new GlpiSearch(this.http);
    this.searchOptions = new SearchOptionsCache(this.http);
  }

  // ---- session ----

  async initSession() {
    return this.http.initSession();
  }

  async killSession() {
    return this.http.killSession();
  }

  // ---- generic CRUD helpers ----

  private toQuery(o: ListOptions | GetOptions): Record<string, string> {
    const q: Record<string, string> = {};
    if ('range' in o && o.range) q.range = o.range;
    if ('sort' in o && o.sort !== undefined) q.sort = String(o.sort);
    if ('order' in o && o.order) q.order = o.order;
    if ('is_deleted' in o && o.is_deleted !== undefined) {
      q.is_deleted = o.is_deleted ? '1' : '0';
    }
    if (o.expand_dropdowns) q.expand_dropdowns = 'true';
    if (o.with_networkports) q.with_networkports = 'true';
    if (o.with_infocoms) q.with_infocoms = 'true';
    if (o.with_contracts) q.with_contracts = 'true';
    if (o.with_documents) q.with_documents = 'true';
    if (o.with_tickets) q.with_tickets = 'true';
    if (o.with_problems) q.with_problems = 'true';
    if (o.with_changes) q.with_changes = 'true';
    if (o.with_logs) q.with_logs = 'true';
    if ('with_softwares' in o && o.with_softwares) q.with_softwares = 'true';
    if ('with_connections' in o && o.with_connections) q.with_connections = 'true';
    if ('with_disks' in o && o.with_disks) q.with_disks = 'true';
    return q;
  }

  async getItems<T>(itemtype: string, options: ListOptions = {}): Promise<T[]> {
    const params = new URLSearchParams(this.toQuery(options));
    if (options.searchText) {
      for (const [k, v] of Object.entries(options.searchText)) {
        params.append(`searchText[${k}]`, v);
      }
    }
    const { data } = await this.http.request<T[]>(itemtype, { query: params });
    return data ?? [];
  }

  async getItem<T>(itemtype: string, id: number, options: GetOptions = {}): Promise<T> {
    // Default expand_dropdowns=true on detail views for human-readable output.
    const opts = { expand_dropdowns: true, ...options };
    const { data } = await this.http.request<T>(`${itemtype}/${id}`, {
      query: this.toQuery(opts),
    });
    return data;
  }

  async createItem(
    itemtype: string,
    payload: Record<string, unknown>
  ): Promise<{ id: number; message?: string }> {
    const { data } = await this.http.request<{ id: number; message?: string } | Array<{ id: number; message?: string }>>(
      itemtype,
      { method: 'POST', json: { input: payload } }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  async updateItem(
    itemtype: string,
    id: number,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    await this.http.request(`${itemtype}/${id}`, {
      method: 'PUT',
      json: { input: payload },
    });
    return true;
  }

  async deleteItem(
    itemtype: string,
    id: number,
    force: boolean = false,
    history: boolean = true
  ): Promise<boolean> {
    const params = new URLSearchParams();
    if (force) params.append('force_purge', '1');
    if (!history) params.append('history', '0');
    await this.http.request(`${itemtype}/${id}`, { method: 'DELETE', query: params });
    return true;
  }

  // ---- TICKETS ----

  async getTickets(options: ListOptions = {}) {
    return this.getItems<GlpiTicket>('Ticket', options);
  }

  async getTicket(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiTicket>('Ticket', id, options);
  }

  async createTicket(ticket: {
    name: string;
    content: string;
    urgency?: number;
    priority?: number;
    impact?: number;
    type?: number;
    itilcategories_id?: number;
    entities_id?: number;
    _users_id_assign?: number;
    _groups_id_assign?: number;
    _users_id_requester?: number;
    _groups_id_requester?: number;
    time_to_resolve?: string;
  }) {
    return this.createItem('Ticket', ticket);
  }

  async updateTicket(id: number, updates: Partial<GlpiTicket>) {
    return this.updateItem('Ticket', id, updates);
  }

  async deleteTicket(id: number, force: boolean = false) {
    return this.deleteItem('Ticket', id, force);
  }

  async addTicketFollowup(
    ticketId: number,
    content: string,
    isPrivate: boolean = false
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'ITILFollowup',
      {
        method: 'POST',
        json: {
          input: {
            itemtype: 'Ticket',
            items_id: ticketId,
            content,
            is_private: isPrivate ? 1 : 0,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  async addTicketTask(
    ticketId: number,
    content: string,
    options: {
      is_private?: boolean;
      actiontime?: number;
      state?: number;
      users_id_tech?: number;
      groups_id_tech?: number;
      begin?: string;
      end?: string;
    } = {}
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'TicketTask',
      {
        method: 'POST',
        json: {
          input: {
            tickets_id: ticketId,
            content,
            is_private: options.is_private ? 1 : 0,
            actiontime: options.actiontime ?? 0,
            state: options.state ?? 1,
            users_id_tech: options.users_id_tech,
            groups_id_tech: options.groups_id_tech,
            begin: options.begin,
            end: options.end,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  async addTicketSolution(
    ticketId: number,
    content: string,
    solutiontypes_id?: number
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'ITILSolution',
      {
        method: 'POST',
        json: {
          input: {
            itemtype: 'Ticket',
            items_id: ticketId,
            content,
            solutiontypes_id: solutiontypes_id ?? 0,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  async getTicketFollowups(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(`Ticket/${ticketId}/ITILFollowup`);
    return data ?? [];
  }

  async getTicketTasks(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(`Ticket/${ticketId}/TicketTask`);
    return data ?? [];
  }

  async getTicketSolutions(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(`Ticket/${ticketId}/ITILSolution`);
    return data ?? [];
  }

  async getTicketValidations(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(
      `Ticket/${ticketId}/TicketValidation`
    );
    return data ?? [];
  }

  async getTicketDocuments(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(`Ticket/${ticketId}/Document_Item`);
    return data ?? [];
  }

  /**
   * Assign ticket to user OR group. F12 fix: groups_id was silently dropped in v2.
   */
  async assignTicket(
    ticketId: number,
    options: {
      users_id?: number;
      groups_id?: number;
      /** 1=requester, 2=assigned, 3=observer */
      type?: number;
    }
  ): Promise<{ id: number }> {
    if (!options.users_id && !options.groups_id) {
      throw new Error('assignTicket requires users_id or groups_id');
    }

    const type = options.type ?? 2;

    if (options.users_id) {
      const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
        'Ticket_User',
        {
          method: 'POST',
          json: { input: { tickets_id: ticketId, users_id: options.users_id, type } },
        }
      );
      return Array.isArray(data) ? data[0] : data;
    }

    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'Group_Ticket',
      {
        method: 'POST',
        json: { input: { tickets_id: ticketId, groups_id: options.groups_id, type } },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  // ---- PROBLEMS ----

  async getProblems(options: ListOptions = {}) {
    return this.getItems<GlpiProblem>('Problem', options);
  }
  async getProblem(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiProblem>('Problem', id, options);
  }
  async createProblem(problem: {
    name: string;
    content: string;
    urgency?: number;
    impact?: number;
    priority?: number;
    itilcategories_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Problem', problem);
  }
  async updateProblem(id: number, updates: Partial<GlpiProblem>) {
    return this.updateItem('Problem', id, updates);
  }

  // ---- CHANGES ----

  async getChanges(options: ListOptions = {}) {
    return this.getItems<GlpiChange>('Change', options);
  }
  async getChange(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiChange>('Change', id, options);
  }
  async createChange(change: {
    name: string;
    content: string;
    urgency?: number;
    impact?: number;
    priority?: number;
    itilcategories_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Change', change);
  }
  async updateChange(id: number, updates: Partial<GlpiChange>) {
    return this.updateItem('Change', id, updates);
  }

  // ---- USERS ----

  /**
   * F10 fix: filter active users via the /search endpoint (criteria field=8, equals)
   * rather than searchText, which was doing a LIKE on the wrong column.
   */
  async getUsers(options: ListOptions & { is_active?: boolean } = {}) {
    if (options.is_active === undefined) {
      return this.getItems<GlpiUser>('User', options);
    }
    // Use search to apply a proper equals filter on is_active.
    const result = await this.search.search<GlpiUser>('User', {
      criteria: [
        {
          field: 8, // standard "is_active" search option id for User
          searchtype: 'equals',
          value: options.is_active ? 1 : 0,
        },
      ],
      start: options.range ? parseInt(options.range.split('-')[0] ?? '0', 10) : 0,
      limit: options.range
        ? parseInt(options.range.split('-')[1] ?? '49', 10) -
          parseInt(options.range.split('-')[0] ?? '0', 10) +
          1
        : 50,
      expandDropdowns: options.expand_dropdowns ?? true,
    });
    return result.data;
  }

  async getUser(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiUser>('User', id, options);
  }

  async getUserByName(name: string): Promise<GlpiUser | null> {
    const users = await this.getItems<GlpiUser>('User', { searchText: { name } });
    return users.length > 0 ? users[0] : null;
  }

  async createUser(user: {
    name: string;
    password?: string;
    realname?: string;
    firstname?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    profiles_id?: number;
    entities_id?: number;
    is_active?: number;
  }) {
    return this.createItem('User', user);
  }

  async updateUser(id: number, updates: Partial<GlpiUser>) {
    return this.updateItem('User', id, updates);
  }

  // ---- GROUPS ----

  async getGroups(options: ListOptions = {}) {
    return this.getItems<GlpiGroup>('Group', options);
  }
  async getGroup(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiGroup>('Group', id, options);
  }
  async createGroup(group: {
    name: string;
    comment?: string;
    entities_id?: number;
    is_recursive?: number;
    is_requester?: number;
    is_assign?: number;
    is_notify?: number;
  }) {
    return this.createItem('Group', group);
  }
  async addUserToGroup(
    userId: number,
    groupId: number,
    isManager: boolean = false
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'Group_User',
      {
        method: 'POST',
        json: {
          input: {
            users_id: userId,
            groups_id: groupId,
            is_manager: isManager ? 1 : 0,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  // ---- COMPUTERS ----

  async getComputers(options: ListOptions = {}) {
    return this.getItems<GlpiComputer>('Computer', options);
  }
  async getComputer(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiComputer>('Computer', id, options);
  }
  async createComputer(computer: Record<string, unknown>) {
    return this.createItem('Computer', computer);
  }
  async updateComputer(id: number, updates: Partial<GlpiComputer>) {
    return this.updateItem('Computer', id, updates);
  }
  async deleteComputer(id: number, force: boolean = false) {
    return this.deleteItem('Computer', id, force);
  }

  // ---- SOFTWARE ----

  async getSoftwares(options: ListOptions = {}) {
    return this.getItems<GlpiSoftware>('Software', options);
  }
  async getSoftware(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiSoftware>('Software', id, options);
  }
  async createSoftware(software: Record<string, unknown>) {
    return this.createItem('Software', software);
  }
  async updateSoftware(id: number, updates: Partial<GlpiSoftware>) {
    return this.updateItem('Software', id, updates);
  }
  async deleteSoftware(id: number, force: boolean = false) {
    return this.deleteItem('Software', id, force);
  }

  // ---- NETWORK EQUIPMENT ----

  async getNetworkEquipments(options: ListOptions = {}) {
    return this.getItems<GlpiNetworkEquipment>('NetworkEquipment', options);
  }
  async getNetworkEquipment(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiNetworkEquipment>('NetworkEquipment', id, options);
  }
  async createNetworkEquipment(equipment: Record<string, unknown>) {
    return this.createItem('NetworkEquipment', equipment);
  }
  async updateNetworkEquipment(id: number, updates: Partial<GlpiNetworkEquipment>) {
    return this.updateItem('NetworkEquipment', id, updates);
  }
  async deleteNetworkEquipment(id: number, force: boolean = false) {
    return this.deleteItem('NetworkEquipment', id, force);
  }

  // ---- PRINTERS / MONITORS / PHONES ----

  async getPrinters(options: ListOptions = {}) {
    return this.getItems<GlpiPrinter>('Printer', options);
  }
  async getPrinter(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiPrinter>('Printer', id, options);
  }
  async createPrinter(printer: Record<string, unknown>) {
    return this.createItem('Printer', printer);
  }
  async updatePrinter(id: number, updates: Partial<GlpiPrinter>) {
    return this.updateItem('Printer', id, updates);
  }
  async deletePrinter(id: number, force: boolean = false) {
    return this.deleteItem('Printer', id, force);
  }

  async getMonitors(options: ListOptions = {}) {
    return this.getItems<GlpiMonitor>('Monitor', options);
  }
  async getMonitor(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiMonitor>('Monitor', id, options);
  }
  async updateMonitor(id: number, updates: Partial<GlpiMonitor>) {
    return this.updateItem('Monitor', id, updates);
  }
  async deleteMonitor(id: number, force: boolean = false) {
    return this.deleteItem('Monitor', id, force);
  }

  async getPhones(options: ListOptions = {}) {
    return this.getItems<GlpiPhone>('Phone', options);
  }
  async getPhone(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiPhone>('Phone', id, options);
  }
  async updatePhone(id: number, updates: Partial<GlpiPhone>) {
    return this.updateItem('Phone', id, updates);
  }
  async deletePhone(id: number, force: boolean = false) {
    return this.deleteItem('Phone', id, force);
  }

  // ---- KNOWLEDGE BASE ----

  async getKnowbaseItems(options: ListOptions = {}) {
    return this.getItems<GlpiKnowbaseItem>('KnowbaseItem', options);
  }
  async getKnowbaseItem(id: number, options: GetOptions = {}) {
    return this.getItem<GlpiKnowbaseItem>('KnowbaseItem', id, options);
  }
  async createKnowbaseItem(item: {
    name: string;
    answer: string;
    is_faq?: number;
    knowbaseitemcategories_id?: number;
  }) {
    return this.createItem('KnowbaseItem', item);
  }

  /**
   * Robust KB search: resolves the "name" field id via SearchOptions instead of
   * hardcoding `6` (which varies across GLPI versions).
   */
  async searchKnowbase(query: string, limit: number = 50): Promise<GlpiKnowbaseItem[]> {
    const fieldId = (await this.searchOptions.resolveField('KnowbaseItem', 'name')) ?? 6;
    const result = await this.search.search<GlpiKnowbaseItem>('KnowbaseItem', {
      criteria: [{ field: fieldId, searchtype: 'contains', value: query }],
      limit,
      expandDropdowns: true,
    });
    return result.data;
  }

  // ---- CONTRACTS / SUPPLIERS / LOCATIONS / ENTITIES / PROJECTS / DOCUMENTS / CATEGORIES ----

  async getContracts(options: ListOptions = {}) { return this.getItems<GlpiContract>('Contract', options); }
  async getContract(id: number, options: GetOptions = {}) { return this.getItem<GlpiContract>('Contract', id, options); }
  async createContract(contract: Record<string, unknown>) { return this.createItem('Contract', contract); }

  async getSuppliers(options: ListOptions = {}) { return this.getItems<GlpiSupplier>('Supplier', options); }
  async getSupplier(id: number, options: GetOptions = {}) { return this.getItem<GlpiSupplier>('Supplier', id, options); }
  async createSupplier(supplier: Record<string, unknown>) { return this.createItem('Supplier', supplier); }

  async getLocations(options: ListOptions = {}) { return this.getItems<GlpiLocation>('Location', options); }
  async getLocation(id: number, options: GetOptions = {}) { return this.getItem<GlpiLocation>('Location', id, options); }
  async createLocation(location: Record<string, unknown>) { return this.createItem('Location', location); }

  async getEntities(options: ListOptions = {}) { return this.getItems<GlpiEntity>('Entity', options); }
  async getEntity(id: number, options: GetOptions = {}) { return this.getItem<GlpiEntity>('Entity', id, options); }

  async getProjects(options: ListOptions = {}) { return this.getItems<GlpiProject>('Project', options); }
  async getProject(id: number, options: GetOptions = {}) { return this.getItem<GlpiProject>('Project', id, options); }
  async createProject(project: Record<string, unknown>) { return this.createItem('Project', project); }
  async updateProject(id: number, updates: Partial<GlpiProject>) { return this.updateItem('Project', id, updates); }

  async getDocuments(options: ListOptions = {}) { return this.getItems<GlpiDocument>('Document', options); }
  async getDocument(id: number, options: GetOptions = {}) { return this.getItem<GlpiDocument>('Document', id, options); }

  async getCategories(options: ListOptions = {}) { return this.getItems<GlpiCategory>('ITILCategory', options); }

  // ---- VALIDATIONS ----

  async addTicketValidation(
    ticketId: number,
    options: {
      users_id_validate: number;
      comment_submission?: string;
      submission_date?: string;
    }
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'TicketValidation',
      {
        method: 'POST',
        json: {
          input: {
            tickets_id: ticketId,
            users_id_validate: options.users_id_validate,
            comment_submission: options.comment_submission ?? '',
            submission_date:
              options.submission_date ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
            status: 1, // 1=Waiting
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  /** Approve or refuse a validation. status: 2=granted, 3=refused */
  async setTicketValidationStatus(
    validationId: number,
    status: 2 | 3,
    comment_validation?: string
  ): Promise<boolean> {
    await this.http.request(`TicketValidation/${validationId}`, {
      method: 'PUT',
      json: {
        input: {
          id: validationId,
          status,
          comment_validation: comment_validation ?? '',
          validation_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      },
    });
    return true;
  }

  // ---- DOCUMENT ATTACHMENT ----

  /**
   * Upload a file as a GLPI Document (multipart POST /Document).
   * GLPI matches the file part against the manifest's `_filename` entry,
   * so `filename` must be identical in both parts.
   *
   * To link the document to an item in the same call, pass `itemtype` +
   * `items_id` — GLPI creates the Document_Item itself. This also works for
   * restricted profiles (e.g. Self-Service ticket requesters) that are not
   * allowed to POST Document_Item directly.
   */
  async uploadDocument(options: {
    /** File name as stored in GLPI (e.g. "screenshot.png"). */
    filename: string;
    /** Raw file content. */
    data: Uint8Array;
    /** Document title (defaults to `filename`). */
    name?: string;
    mimeType?: string;
    /** Item to link the document to on creation (e.g. "Ticket"). */
    itemtype?: string;
    items_id?: number;
  }): Promise<{ id: number }> {
    const { filename, data, name, mimeType, itemtype, items_id } = options;
    const manifest = JSON.stringify({
      input: {
        name: name ?? filename,
        _filename: [filename],
        ...(itemtype && items_id ? { itemtype, items_id } : {}),
      },
    });
    const form = new FormData();
    // Append as a plain string field: parts with a filename land in PHP's
    // $_FILES, and GLPI reads the manifest from $_POST.
    form.append('uploadManifest', manifest);
    form.append(
      'filename[0]',
      new Blob([data], { type: mimeType ?? 'application/octet-stream' }),
      filename
    );
    const { data: res } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'Document',
      { method: 'POST', form }
    );
    return Array.isArray(res) ? res[0] : res;
  }

  /**
   * Attach an existing document (by id) to a ticket via Document_Item.
   * Use this after uploading the file via /Document.
   */
  async attachDocumentToTicket(
    ticketId: number,
    documentId: number
  ): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'Document_Item',
      {
        method: 'POST',
        json: {
          input: {
            documents_id: documentId,
            itemtype: 'Ticket',
            items_id: ticketId,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  // ---- SATISFACTION ----

  async getTicketSatisfaction(ticketId: number) {
    const { data } = await this.http.request<unknown[]>(
      `Ticket/${ticketId}/TicketSatisfaction`
    );
    return data ?? [];
  }

  // ---- LINKS ----

  /** Link two tickets. linkType: 1=link, 2=duplicate, 3=parent (link), 4=son (linked) */
  async linkTickets(parentId: number, childId: number, linkType: number = 1): Promise<{ id: number }> {
    const { data } = await this.http.request<{ id: number } | Array<{ id: number }>>(
      'Ticket_Ticket',
      {
        method: 'POST',
        json: {
          input: {
            tickets_id_1: parentId,
            tickets_id_2: childId,
            link: linkType,
          },
        },
      }
    );
    return Array.isArray(data) ? data[0] : data;
  }

  // ---- STATISTICS (F9 fix: use count probes instead of fetching all then filtering) ----

  async getTicketStats(filters: {
    entity_id?: number;
    date_from?: string;
    date_to?: string;
  } = {}): Promise<{
    total: number;
    new: number;
    processing: number;
    pending: number;
    solved: number;
    closed: number;
  }> {
    const baseCriteria: SearchCriterion[] = [];
    if (filters.entity_id !== undefined) {
      baseCriteria.push({ field: 80, searchtype: 'equals', value: filters.entity_id, link: 'AND' });
    }
    if (filters.date_from) {
      baseCriteria.push({ field: 15, searchtype: 'morethan', value: filters.date_from, link: 'AND' });
    }
    if (filters.date_to) {
      baseCriteria.push({ field: 15, searchtype: 'lessthan', value: filters.date_to, link: 'AND' });
    }

    const counts: Record<string, number> = {};
    for (const [label, statusId] of Object.entries({
      new: 1,
      processing_assigned: 2,
      processing_planned: 3,
      pending: 4,
      solved: 5,
      closed: 6,
    })) {
      const criteria: SearchCriterion[] = [
        { field: 12, searchtype: 'equals', value: statusId },
        ...baseCriteria.map((c, i) => ({ ...c, link: i === 0 ? 'AND' as const : c.link })),
      ];
      counts[label] = await this.search.count('Ticket', criteria);
    }

    const total = await this.search.count(
      'Ticket',
      baseCriteria.length > 0 ? baseCriteria : []
    );

    return {
      total,
      new: counts.new ?? 0,
      processing: (counts.processing_assigned ?? 0) + (counts.processing_planned ?? 0),
      pending: counts.pending ?? 0,
      solved: counts.solved ?? 0,
      closed: counts.closed ?? 0,
    };
  }

  async getAssetStats(): Promise<{
    computers: number;
    monitors: number;
    printers: number;
    networkEquipments: number;
    phones: number;
    softwares: number;
  }> {
    const [computers, monitors, printers, networkEquipments, phones, softwares] =
      await Promise.all([
        this.search.count('Computer'),
        this.search.count('Monitor'),
        this.search.count('Printer'),
        this.search.count('NetworkEquipment'),
        this.search.count('Phone'),
        this.search.count('Software'),
      ]);
    return { computers, monitors, printers, networkEquipments, phones, softwares };
  }

  // ---- SESSION INFO ----

  async getMyProfiles() {
    const { data } = await this.http.request<unknown[]>('getMyProfiles');
    return data ?? [];
  }
  async getActiveProfile() {
    const { data } = await this.http.request<unknown>('getActiveProfile');
    return data;
  }
  async getMyEntities() {
    const { data } = await this.http.request<unknown[]>('getMyEntities');
    return data ?? [];
  }
  async getFullSession() {
    const { data } = await this.http.request<unknown>('getFullSession');
    return data;
  }
}
