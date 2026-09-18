import { request } from "node:https";
import type { RequestScope } from "./auth.js";

export interface PdmConfig { url: URL; tokenId: string; tokenSecret: string; tlsInsecure: boolean; timeoutMs: number }
export type PdmRecord = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined;
export interface PdmHttpRequest { method: "GET"; url: URL; authorization: string; rejectUnauthorized: boolean; timeoutMs: number }
export interface PdmHttpResponse { status: number; body: string }
export type PdmExecutor = (request: PdmHttpRequest) => Promise<PdmHttpResponse>;
export interface ResourceFilters { remote?: string; resourceType?: string; node?: string; name?: string; vmid?: number; status?: string; maxAge?: number }
export interface GuestFilters { remote?: string; node?: string; name?: string; status?: string }
export interface StorageFilters { remote?: string; node?: string; type?: string }
export interface TaskFilters { remote: string; node?: string; vmid?: number; errorsOnly?: boolean; limit?: number }
export type GuestView = "summary" | "hardware" | "runtime" | "full";
export type NodeView = "summary" | "capacity" | "runtime" | "full";
export type StorageView = "summary" | "capacity" | "full";
export type ResourceView = "summary" | "full";
export type TaskView = "summary" | "full";
interface PdmResponse { data: unknown }

export function loadConfig(env = process.env): PdmConfig {
  const url = env.PDM_URL;
  const tokenId = env.PDM_TOKEN_ID;
  const tokenSecret = env.PDM_TOKEN_SECRET;
  if (!url || !tokenId || !tokenSecret) throw new Error("PDM_URL, PDM_TOKEN_ID and PDM_TOKEN_SECRET are required.");

  let parsedUrl: URL;
  try { parsedUrl = new URL(url); }
  catch { throw new Error("PDM_URL must be an absolute URL, for example https://pdm.example.com:8443."); }
  if (parsedUrl.protocol !== "https:") throw new Error("PDM_URL must use HTTPS.");

  const timeoutMs = Number(env.PDM_TIMEOUT_MS ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("PDM_TIMEOUT_MS must be a positive integer.");
  return { url: parsedUrl, tokenId, tokenSecret, tlsInsecure: env.PDM_TLS_INSECURE === "true", timeoutMs };
}

export function pdmAuthorization(config: PdmConfig): string { return `PDMAPIToken ${config.tokenId}:${config.tokenSecret}`; }
export function encodePathSegment(value: string): string { return encodeURIComponent(value); }
export function remoteListPath(): string { return "/api2/json/remotes/remote"; }
export const DEFAULT_RESOURCE_MAX_AGE = 300;

export function pveRemotePath(remote: string, suffix = ""): string {
  if (suffix && !suffix.startsWith("/")) throw new Error("PVE remote path suffix must start with /.");
  return `/api2/json/pve/remotes/${encodePathSegment(remote)}${suffix}`;
}

async function httpsExecutor(options: PdmHttpRequest): Promise<PdmHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(options.url, {
      method: options.method,
      headers: { Authorization: options.authorization },
      rejectUnauthorized: options.rejectUnauthorized,
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`request timed out after ${options.timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export async function pdmRequest(
  config: PdmConfig,
  method: "GET",
  path: string,
  query: Record<string, QueryValue> = {},
  executor: PdmExecutor = httpsExecutor,
): Promise<unknown> {
  if (!path.startsWith("/api2/json/")) throw new Error("PDM API path must start with /api2/json/.");
  const url = new URL(path, config.url);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.append(key, String(value));

  let response: PdmHttpResponse;
  try {
    response = await executor({ method, url, authorization: pdmAuthorization(config), rejectUnauthorized: !config.tlsInsecure, timeoutMs: config.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown network error";
    throw new Error(`PDM request to ${method} ${path} failed: ${message}.`);
  }

  if (response.status < 200 || response.status >= 300) {
    const detail = response.status === 401 ? "Authentication against PDM failed"
      : response.status === 403 ? "PDM rejected the request due to insufficient permissions"
        : response.status === 404 ? "PDM API endpoint not found"
          : response.status >= 500 ? "PDM server returned an internal error" : "PDM request failed";
    throw new Error(`${detail}: ${method} ${path} returned HTTP ${response.status}.`);
  }

  try { return (JSON.parse(response.body) as PdmResponse).data; }
  catch { throw new Error(`PDM request to ${method} ${path} returned invalid JSON.`); }
}

function isRecord(value: unknown): value is PdmRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecords(data: unknown, path: string): PdmRecord[] {
  if (!Array.isArray(data) || data.some(item => !isRecord(item))) throw new Error(`PDM request to ${path} returned an unexpected response.`);
  return data;
}
function asRecord(data: unknown, path: string): PdmRecord {
  if (!isRecord(data)) throw new Error(`PDM request to ${path} returned an unexpected response.`);
  return data;
}
function value(record: PdmRecord, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}
function numberValue(record: PdmRecord, ...keys: string[]): number | undefined {
  const candidate = value(record, ...keys);
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
function equals(actual: unknown, expected: string | number | undefined): boolean {
  return expected === undefined || String(actual ?? "").toLowerCase() === String(expected).toLowerCase();
}
function includes(actual: unknown, expected: string | undefined): boolean {
  return expected === undefined || String(actual ?? "").toLowerCase().includes(expected.toLowerCase());
}

export function filterResources(resources: PdmRecord[], filters: ResourceFilters): PdmRecord[] {
  return resources.filter(resource => equals(value(resource, "remote"), filters.remote)
    && equals(value(resource, "type", "resource-type"), filters.resourceType)
    && equals(value(resource, "node"), filters.node)
    && includes(value(resource, "name", "hostname", "storage"), filters.name)
    && equals(value(resource, "vmid"), filters.vmid)
    && equals(value(resource, "status"), filters.status));
}

function withRemote(records: PdmRecord[], remote: string): PdmRecord[] {
  return records.map(record => record.remote === undefined ? { remote, ...record } : record);
}

function flattenGlobalResources(records: PdmRecord[]): PdmRecord[] {
  return records.flatMap(record => {
    if (!Array.isArray(record.resources)) return [record];
    const remote = typeof record.remote === "string" ? record.remote : undefined;
    return record.resources.filter(isRecord).map(resource => remote && resource.remote === undefined ? { remote, ...resource } : resource);
  });
}

const sensitiveKey = /(password|passwd|secret|token|cipassword|ssh-?keys?)/i;
export function sanitizeSecrets(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sanitizeSecrets);
  if (isRecord(input)) return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : sanitizeSecrets(item)]));
  if (typeof input === "string") return input.replace(/((?:password|passwd|secret|token|cipassword)\s*=\s*)[^,\s]+/gi, "$1[REDACTED]");
  return input;
}

export function roundMetric(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function bytesToGiB(bytes: number | undefined): number | undefined {
  return bytes === undefined ? undefined : roundMetric(bytes / 1024 ** 3, 2);
}

export function ratioToPercent(ratio: number | undefined): number | undefined {
  return ratio === undefined ? undefined : roundMetric(ratio * 100, 1);
}

function compact(record: PdmRecord): PdmRecord {
  return Object.fromEntries(Object.entries(record).filter(([, item]) => item !== undefined && item !== null));
}

function compactDeep(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(compactDeep);
  if (isRecord(input)) return Object.fromEntries(Object.entries(input)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => [key, compactDeep(item)]));
  return input;
}

function guestIdentity(record: PdmRecord): PdmRecord {
  return compact({
    remote: value(record, "remote"),
    node: value(record, "node"),
    vmid: value(record, "vmid"),
    name: value(record, "name", "hostname"),
    status: value(record, "status"),
  });
}

export function projectGuest(record: PdmRecord, view: GuestView): PdmRecord {
  if (view === "full") return compactDeep(sanitizeSecrets(record)) as PdmRecord;
  const identity = guestIdentity(record);
  if (view === "summary") return identity;
  if (view === "hardware") return compact({
    ...identity,
    vcpus: numberValue(record, "cpus", "maxcpu"),
    ram_gib: bytesToGiB(numberValue(record, "maxmem")),
    disk_gib: bytesToGiB(numberValue(record, "maxdisk")),
  });
  const usedMemory = numberValue(record, "mem", "memory");
  const maxMemory = numberValue(record, "maxmem");
  return compact({
    ...identity,
    cpu_pct: ratioToPercent(numberValue(record, "cpu")),
    ram_used_gib: bytesToGiB(usedMemory),
    ram_pct: usedMemory !== undefined && maxMemory ? ratioToPercent(usedMemory / maxMemory) : undefined,
    uptime_seconds: numberValue(record, "uptime"),
  });
}

function nodeIdentity(record: PdmRecord): PdmRecord {
  return compact({ remote: value(record, "remote"), node: value(record, "node", "name"), status: value(record, "status") });
}

export function projectNode(record: PdmRecord, view: NodeView): PdmRecord {
  if (view === "full") return compactDeep(sanitizeSecrets(record)) as PdmRecord;
  const identity = nodeIdentity(record);
  if (view === "summary") return identity;
  if (view === "capacity") return compact({
    ...identity,
    cpu_cores: numberValue(record, "maxcpu", "cpus"),
    ram_total_gib: bytesToGiB(numberValue(record, "maxmem")),
  });
  const usedMemory = numberValue(record, "mem", "memory");
  const maxMemory = numberValue(record, "maxmem");
  return compact({
    ...identity,
    cpu_pct: ratioToPercent(numberValue(record, "cpu")),
    ram_used_gib: bytesToGiB(usedMemory),
    ram_pct: usedMemory !== undefined && maxMemory ? ratioToPercent(usedMemory / maxMemory) : undefined,
    uptime_seconds: numberValue(record, "uptime"),
  });
}

function storageType(record: PdmRecord): unknown {
  const specialized = value(record, "storage-type", "plugintype");
  return specialized ?? (record.type === "storage" ? undefined : record.type);
}

function storageIdentity(record: PdmRecord): PdmRecord {
  return compact({
    remote: value(record, "remote"),
    node: value(record, "node"),
    storage: value(record, "storage", "name"),
    type: storageType(record),
    status: value(record, "status"),
  });
}

export function projectStorage(record: PdmRecord, view: StorageView): PdmRecord {
  if (view === "full") return compactDeep(sanitizeSecrets(record)) as PdmRecord;
  const identity = storageIdentity(record);
  if (view === "summary") return identity;
  const total = numberValue(record, "total");
  const used = numberValue(record, "used");
  return compact({
    ...identity,
    total_gib: bytesToGiB(total),
    used_gib: bytesToGiB(used),
    available_gib: bytesToGiB(numberValue(record, "available", "avail")),
    used_pct: used !== undefined && total ? ratioToPercent(used / total) : undefined,
  });
}

export function projectResource(record: PdmRecord, view: ResourceView): PdmRecord {
  if (view === "full") return compactDeep(sanitizeSecrets(record)) as PdmRecord;
  return compact({
    remote: value(record, "remote"),
    node: value(record, "node"),
    type: value(record, "type", "resource-type"),
    id: value(record, "id"),
    vmid: value(record, "vmid"),
    name: value(record, "name", "hostname", "storage"),
    status: value(record, "status"),
  });
}

export function parseNodeFromUpid(upid: string): string | undefined {
  const parts = upid.split(":");
  if (parts.length >= 2 && parts[0] === "UPID" && parts[1]?.trim() !== "") {
    return parts[1];
  }
  return undefined;
}

export function projectTask(record: PdmRecord, view: TaskView): PdmRecord {
  if (view === "full") return compactDeep(sanitizeSecrets(record)) as PdmRecord;
  return compact({
    remote: value(record, "remote"),
    node: value(record, "node"),
    upid: value(record, "upid"),
    type: value(record, "type"),
    id: value(record, "id"),
    status: value(record, "status"),
    user: value(record, "user", "user_id"),
    starttime: numberValue(record, "starttime"),
    endtime: numberValue(record, "endtime"),
  });
}

function countStatuses(records: PdmRecord[], active: string, inactive: string): PdmRecord {
  return {
    total: records.length,
    [active]: records.filter(record => equals(value(record, "status"), active)).length,
    [inactive]: records.filter(record => equals(value(record, "status"), inactive)).length,
  };
}

function one(records: PdmRecord[], description: string): PdmRecord {
  if (records.length === 0) throw new Error(`${description} was not found in PDM.`);
  return records[0];
}

export class PdmClient {
  private readonly scope?: RequestScope;

  constructor(private readonly config: PdmConfig, private readonly executor: PdmExecutor = httpsExecutor, scope?: RequestScope) {
    this.scope = scope && { allowedRemotes: new Set(scope.allowedRemotes) };
  }

  private authorizeRemote(remote: string): void {
    if (this.scope && !this.scope.allowedRemotes.has(remote)) throw new Error("Access denied.");
  }

  async request(path: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    if (this.scope) {
      const match = /^\/api2\/json\/pve\/remotes\/([^/]+)\//.exec(path);
      if (this.scope.allowedRemotes.size === 0 || new URL(path, this.config.url).pathname !== path
        || (path !== remoteListPath() && !match)) {
        throw new Error("Access denied.");
      }
      if (match) this.authorizeRemote(decodeURIComponent(match[1]));
    }
    try {
      const data = await pdmRequest(this.config, "GET", path, query, this.executor);
      if (this.scope && path === remoteListPath()) {
        return sanitizeSecrets(asRecords(data, path).filter(record => typeof record.id === "string" && this.scope!.allowedRemotes.has(record.id)));
      }
      return data;
    } catch (error) {
      if (this.scope) throw new Error("PDM request failed.");
      throw error;
    }
  }

  async getRemoteList(): Promise<PdmRecord[]> {
    return asRecords(await this.request(remoteListPath()), remoteListPath());
  }

  async getResources(filters: ResourceFilters = {}): Promise<PdmRecord[]> {
    if (this.scope && filters.remote === undefined) {
      const records: PdmRecord[] = [];
      // ponytail: sequential fan-out bounds PDM load; add bounded concurrency if latency requires it.
      for (const remote of this.scope.allowedRemotes) records.push(...await this.getResources({ ...filters, remote }));
      return records;
    }
    if (filters.remote) {
      const path = pveRemotePath(filters.remote, "/resources");
      const records = withRemote(asRecords(await this.request(path), path), filters.remote);
      return filterResources(records, filters);
    }
    const path = "/api2/json/resources/list";
    const records = flattenGlobalResources(asRecords(await this.request(path, {
      "max-age": filters.maxAge ?? DEFAULT_RESOURCE_MAX_AGE,
      "resource-type": filters.resourceType,
    }), path));
    return filterResources(records, filters);
  }

  async getVmList(filters: GuestFilters = {}): Promise<PdmRecord[]> {
    if (!filters.remote) return this.getResources({ ...filters, resourceType: "qemu" });
    const path = pveRemotePath(filters.remote, "/qemu");
    const records = withRemote(asRecords(await this.request(path, { node: filters.node }), path), filters.remote);
    return filterResources(records, { node: filters.node, name: filters.name, status: filters.status });
  }

  async getVm(remote: string, vmid: number, node?: string): Promise<PdmRecord> {
    const base = pveRemotePath(remote, `/qemu/${vmid}`);
    const [runtime, config] = await Promise.all([
      this.request(`${base}/status`, { node }),
      this.request(`${base}/config`, { node, state: "active" }),
    ]);
    return sanitizeSecrets({ remote, vmid, runtime: asRecord(runtime, `${base}/status`), config: asRecord(config, `${base}/config`) }) as PdmRecord;
  }

  async getNodeList(remote?: string): Promise<PdmRecord[]> {
    if (!remote) return this.getResources({ resourceType: "node" });
    const path = pveRemotePath(remote, "/nodes");
    return withRemote(asRecords(await this.request(path), path), remote);
  }

  async getNode(remote: string, node: string): Promise<PdmRecord> {
    const path = pveRemotePath(remote, `/nodes/${encodePathSegment(node)}/status`);
    return sanitizeSecrets({ remote, node, status: asRecord(await this.request(path), path) }) as PdmRecord;
  }

  async getContainerList(filters: GuestFilters = {}): Promise<PdmRecord[]> {
    if (!filters.remote) return this.getResources({ ...filters, resourceType: "lxc" });
    const path = pveRemotePath(filters.remote, "/lxc");
    const records = withRemote(asRecords(await this.request(path, { node: filters.node }), path), filters.remote);
    return filterResources(records, { node: filters.node, name: filters.name, status: filters.status });
  }

  async getContainer(remote: string, vmid: number, node?: string): Promise<PdmRecord> {
    const base = pveRemotePath(remote, `/lxc/${vmid}`);
    const [runtime, config] = await Promise.all([
      this.request(`${base}/status`, { node }),
      this.request(`${base}/config`, { node, state: "active" }),
    ]);
    return sanitizeSecrets({ remote, vmid, runtime: asRecord(runtime, `${base}/status`), config: asRecord(config, `${base}/config`) }) as PdmRecord;
  }

  async getStorageList(filters: StorageFilters = {}): Promise<PdmRecord[]> {
    if (!filters.remote || !filters.node) {
      const records = await this.getResources({ remote: filters.remote, node: filters.node, resourceType: "storage" });
      return records.filter(record => equals(value(record, "storage-type", "plugintype"), filters.type));
    }
    const path = pveRemotePath(filters.remote, `/nodes/${encodePathSegment(filters.node)}/storage`);
    const records = withRemote(asRecords(await this.request(path), path), filters.remote)
      .map(record => record.node === undefined ? { node: filters.node, ...record } : record);
    return records.filter(record => equals(value(record, "type", "storage-type", "plugintype"), filters.type));
  }

  async getStorage(remote: string, storage: string, node?: string): Promise<PdmRecord> {
    let resolvedNode = node;
    let inventory: PdmRecord | undefined;
    if (!resolvedNode) {
      inventory = one((await this.getResources({ remote, resourceType: "storage" }))
        .filter(record => equals(value(record, "storage", "name"), storage)), `Storage ${storage}`);
      const candidate = value(inventory, "node");
      if (typeof candidate === "string") resolvedNode = candidate;
    }
    if (!resolvedNode) return sanitizeSecrets({ remote, storage, inventory }) as PdmRecord;
    const path = pveRemotePath(remote, `/nodes/${encodePathSegment(resolvedNode)}/storage/${encodePathSegment(storage)}/status`);
    return sanitizeSecrets({ remote, node: resolvedNode, storage, inventory, status: asRecord(await this.request(path), path) }) as PdmRecord;
  }

  async getRemoteSummary(remote: string): Promise<PdmRecord> {
    const [nodes, vms, containers] = await Promise.all([
      this.getNodeList(remote),
      this.getVmList({ remote }),
      this.getContainerList({ remote }),
    ]);
    const cpuCores = nodes.reduce((sum, node) => sum + (numberValue(node, "maxcpu", "cpus") ?? 0), 0);
    const ramBytes = nodes.reduce((sum, node) => sum + (numberValue(node, "maxmem") ?? 0), 0);
    return compact({
      remote,
      nodes: countStatuses(nodes, "online", "offline"),
      vms: countStatuses(vms, "running", "stopped"),
      containers: countStatuses(containers, "running", "stopped"),
      capacity: compact({
        cpu_cores: cpuCores || undefined,
        ram_total_gib: ramBytes ? bytesToGiB(ramBytes) : undefined,
      }),
    });
  }

  async getTaskList(filters: TaskFilters): Promise<PdmRecord[]> {
    const query: Record<string, QueryValue> = {};
    if (filters.limit !== undefined) query.limit = filters.limit;
    if (filters.errorsOnly) query.errors = 1;
    if (filters.vmid !== undefined) query.vmid = filters.vmid;

    const path = filters.node
      ? pveRemotePath(filters.remote, `/nodes/${encodePathSegment(filters.node)}/tasks`)
      : pveRemotePath(filters.remote, "/cluster/tasks");

    const records = asRecords(await this.request(path, query), path);
    return withRemote(records, filters.remote).map(record => {
      if (filters.node && record.node === undefined) return { node: filters.node, ...record };
      return record;
    });
  }

  async getTask(remote: string, upid: string, node?: string): Promise<PdmRecord> {
    // Authorize before the local UPID error, which can precede request().
    this.authorizeRemote(remote);
    const resolvedNode = node || parseNodeFromUpid(upid);
    if (!resolvedNode) {
      throw new Error("Node could not be determined for task. Please provide the node parameter.");
    }
    const path = pveRemotePath(remote, `/nodes/${encodePathSegment(resolvedNode)}/tasks/${encodePathSegment(upid)}/status`);
    return sanitizeSecrets({
      remote,
      node: resolvedNode,
      upid,
      status: asRecord(await this.request(path), path),
    }) as PdmRecord;
  }
}

// Compatibility exports kept for callers of the original first tool.
export async function getRemoteList(config: PdmConfig): Promise<PdmRecord[]> { return new PdmClient(config).getRemoteList(); }
export function formatRemotes(remotes: unknown[]): string { return JSON.stringify({ count: remotes.length, remotes }, null, 2); }
