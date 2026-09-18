import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authenticate, type RequestScope } from "./auth.js";
import {
  PdmClient, filterResources, formatRemotes, loadConfig, parseNodeFromUpid, pdmAuthorization, pdmRequest,
  projectGuest, projectNode, projectResource, projectStorage, projectTask, pveRemotePath, remoteListPath,
  sanitizeSecrets, type PdmExecutor, type PdmHttpRequest, type PdmRecord,
} from "./pdm.js";
import { ALL_TOOL_NAMES, TOOL_NAMES } from "./tool-names.js";
import { listResult, objectResult, registerTools } from "./tools.js";

const config = loadConfig({
  PDM_URL: "https://pdm.test:8443", PDM_TOKEN_ID: "test-user@pdm!test-token",
  PDM_TOKEN_SECRET: "test-secret", PDM_TLS_INSECURE: "true",
});

function mockClient(resolver: (request: PdmHttpRequest) => unknown, scope?: RequestScope) {
  const requests: PdmHttpRequest[] = [];
  const executor: PdmExecutor = async request => {
    requests.push(request);
    return { status: 200, body: JSON.stringify({ data: resolver(request) }) };
  };
  return { client: new PdmClient(config, executor, scope), requests };
}

async function verifiedScope(remotes: string[]): Promise<RequestScope> {
  const secret = randomBytes(32);
  const jwt = await new SignJWT({ pdm_remotes: remotes }).setProtectedHeader({ alg: "HS256" })
    .setAudience("pdm-mcp").setExpirationTime("5m").sign(secret);
  const scope = await authenticate({ mode: "jwt", secret, audience: "pdm-mcp" }, `Bearer ${jwt}`);
  assert.ok(scope);
  return scope;
}

test("verified request scope allows LAB-A and rejects every remote tool before any PDM request", async () => {
  const { client, requests } = mockClient(() => [{ vmid: 105, name: "vm-test-01" }], await verifiedScope(["LAB-A"]));
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, client);
  const mcp = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    const allowed = await mcp.callTool({ name: "list_vms", arguments: { remote: "LAB-A" } });
    assert.notEqual(allowed.isError, true);
    assert.deepEqual(requests.map(request => request.url.pathname), ["/api2/json/pve/remotes/LAB-A/qemu"]);
    requests.length = 0;
    for (const name of ALL_TOOL_NAMES.filter(name => name !== "list_remotes")) {
      const denied = await mcp.callTool({ name, arguments: {
        remote: "LAB-B", node: "pve-test-01", vmid: 105, storage: "local-test", upid: "test-upid",
        allowedRemotes: ["LAB-B"], pdm_remotes: ["LAB-B"],
      } });
      assert.equal(denied.isError, true, name);
      assert.deepEqual(denied.content, [{ type: "text", text: "Access denied." }], name);
    }
    await assert.rejects(client.getTask("LAB-B", "invalid-upid"), /^Error: Access denied\.$/);
    assert.equal(requests.length, 0);
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("scoped unqualified lists query only permitted remotes and aggregate with filters intact", async () => {
  for (const remotes of [["LAB-A"], ["LAB-A", "LAB-B"]]) {
    const { client, requests } = mockClient(() => [
      { type: "qemu", name: "vm-test-01", vmid: 105, status: "running", node: "pve-test-01" },
      { type: "qemu", name: "vm-test-02", vmid: 106, status: "stopped", node: "pve-test-02" },
      { type: "lxc", name: "ct-test-01", status: "running" },
      { type: "node", node: "pve-test-01" },
      { type: "storage", storage: "local-test", "storage-type": "dir" },
    ], await verifiedScope(remotes));
    const lists = [() => client.getResources({ resourceType: "qemu", vmid: 105, name: "vm-test", node: "pve-test-01", status: "running", maxAge: 0 }),
      () => client.getVmList({ name: "vm-test-01", status: "running" }), () => client.getNodeList(),
      () => client.getContainerList({ status: "running" }), () => client.getStorageList({ type: "dir" })];
    for (const list of lists) {
      requests.length = 0;
      const records = await list();
      assert.deepEqual(records.map(record => record.remote), remotes);
      assert.deepEqual(requests.map(request => request.url.pathname), remotes.map(remote => `/api2/json/pve/remotes/${remote}/resources`));
      assert.ok(requests.every(request => request.url.search === ""));
    }
  }
});

test("list_remotes filters by exact authorized ID and sanitizes the permitted records", async () => {
  const { client } = mockClient(() => [
    { id: "LAB-A", type: "pve", token: "test-token", nested: { password: "test-password" } },
    { id: "LAB-B", type: "pve" }, { id: "lab-a", type: "pve" }, { name: "LAB-A" },
  ], await verifiedScope(["LAB-A"]));
  assert.deepEqual(await client.getRemoteList(), [
    { id: "LAB-A", type: "pve", token: "[REDACTED]", nested: { password: "[REDACTED]" } },
  ]);
});

test("scoped client blocks global inventory, case changes and URL traversal at the request boundary", async () => {
  const { client, requests } = mockClient(() => [], await verifiedScope(["LAB-A"]));
  for (const path of ["/api2/json/resources/list", "/api2/json/pve/remotes/lab-a/qemu",
    "/api2/json/pve/remotes/LAB-A/../LAB-B/qemu", "/api2/json/pve/remotes/LAB-A/%2e%2e/LAB-B/qemu"]) {
    await assert.rejects(client.request(path), /^Error: Access denied\.$/);
  }
  assert.equal(requests.length, 0);
});

test("scoped upstream failures disclose no authorization, response body or other remote", async () => {
  const scope = await verifiedScope(["LAB-A"]);
  const sensitive = `LAB-B ${pdmAuthorization(config)} test-response-body`;
  for (const executor of [async () => { throw new Error(sensitive); },
    async () => ({ status: 403, body: sensitive }), async () => ({ status: 200, body: sensitive })]) {
    const client = new PdmClient(config, executor, scope);
    await assert.rejects(client.getVmList({ remote: "LAB-A" }), /^Error: PDM request failed\.$/);
  }
});

test("disabled authentication preserves unscoped global inventory and all remotes", async () => {
  const scope = await authenticate({ mode: "disabled" }, "Bearer malformed");
  assert.equal(scope, undefined);
  const { client, requests } = mockClient(() => [{ id: "LAB-A" }, { id: "LAB-B" }], scope);
  assert.equal((await client.getRemoteList()).length, 2);
  await client.getVmList();
  assert.equal(requests[1].url.pathname, "/api2/json/resources/list");
});

test("concurrent callers retain isolated scope snapshots", async () => {
  const scopeA = await verifiedScope(["LAB-A"]);
  const scopeB = await verifiedScope(["LAB-B"]);
  const first = mockClient(() => [{ type: "qemu", vmid: 105 }], scopeA);
  const second = mockClient(() => [{ type: "qemu", vmid: 106 }], scopeB);
  (scopeA.allowedRemotes as Set<string>).add("LAB-B");
  const [a, b] = await Promise.all([first.client.getVmList(), second.client.getVmList()]);
  assert.deepEqual(a.map(record => record.remote), ["LAB-A"]);
  assert.deepEqual(b.map(record => record.remote), ["LAB-B"]);
  await assert.rejects(first.client.getVmList({ remote: "LAB-B" }), /^Error: Access denied\.$/);
  await assert.rejects(second.client.getVmList({ remote: "LAB-A" }), /^Error: Access denied\.$/);
  assert.equal(first.requests.length, 1);
  assert.equal(second.requests.length, 1);
});

test("generic request sends auth/TLS options, encodes query and parses data", async () => {
  let seen: PdmHttpRequest | undefined;
  const data = await pdmRequest(config, "GET", "/api2/json/resources/list", { node: "node one", vmid: 105 }, async request => {
    seen = request;
    return { status: 200, body: '{"data":[{"vmid":105}]}' };
  });
  assert.deepEqual(data, [{ vmid: 105 }]);
  assert.equal(seen?.authorization, "PDMAPIToken test-user@pdm!test-token:test-secret");
  assert.equal(seen?.rejectUnauthorized, false);
  assert.equal(seen?.url.search, "?node=node+one&vmid=105");
});

test("generic request maps HTTP, invalid JSON and network errors without exposing response bodies", async () => {
  await assert.rejects(pdmRequest(config, "GET", "/api2/json/resources/list", {}, async () => ({ status: 403, body: "test-secret" })), /insufficient permissions.*HTTP 403/);
  await assert.rejects(pdmRequest(config, "GET", "/api2/json/resources/list", {}, async () => ({ status: 200, body: "no-json" })), /invalid JSON/);
  await assert.rejects(pdmRequest(config, "GET", "/api2/json/resources/list", {}, async () => { throw new Error("ECONNREFUSED"); }), /ECONNREFUSED/);
});

test("list_remotes keeps the canonical endpoint", async () => {
  const { client, requests } = mockClient(() => [{ id: "LAB-A", type: "pve" }]);
  assert.deepEqual(await client.getRemoteList(), [{ id: "LAB-A", type: "pve" }]);
  assert.equal(requests[0].url.pathname, "/api2/json/remotes/remote");
  assert.equal(remoteListPath(), "/api2/json/remotes/remote");
  assert.equal(JSON.parse(formatRemotes([{ id: "LAB-A" }])).count, 1);
});

test("list_resources uses global inventory, cache and supported server-side type filter", async () => {
  const { client, requests } = mockClient(() => [
    { remote: "LAB-A", type: "qemu", node: "pve-test-01", name: "vm-test-01", vmid: 105, status: "running" },
    { remote: "LAB-B", type: "qemu", node: "pve-test-02", name: "vm-test-02", vmid: 106, status: "stopped" },
  ]);
  const result = await client.getResources({ resourceType: "qemu", node: "pve-test-01", name: "VM-TEST", vmid: 105, status: "RUNNING" });
  assert.equal(requests[0].url.pathname, "/api2/json/resources/list");
  assert.equal(requests[0].url.searchParams.get("max-age"), "300");
  assert.equal(requests[0].url.searchParams.get("resource-type"), "qemu");
  assert.deepEqual(result.map(item => item.vmid), [105]);
});

test("list_resources with a remote uses that PVE remote instead of global fan-out", async () => {
  const { client, requests } = mockClient(() => [{ type: "qemu", vmid: 105, name: "vm-test-01" }]);
  const result = await client.getResources({ remote: "LAB-B", resourceType: "qemu", maxAge: 60 });
  assert.equal(requests[0].url.pathname, "/api2/json/pve/remotes/LAB-B/resources");
  assert.equal(requests[0].url.search, "");
  assert.equal(result[0].remote, "LAB-B");
});

test("global resources flatten PDM remote groups and honor explicit max-age", async () => {
  const { client, requests } = mockClient(() => [{ remote: "LAB-B", resources: [{ type: "qemu", vmid: 105 }] }]);
  const result = await client.getResources({ resourceType: "qemu", maxAge: 0 });
  assert.equal(requests[0].url.searchParams.get("max-age"), "0");
  assert.deepEqual(result, [{ remote: "LAB-B", type: "qemu", vmid: 105 }]);
});

test("list_vms uses global resources without remote and specialized endpoint with remote", async () => {
  const global = mockClient(() => [{ type: "qemu", name: "web-test-01" }, { type: "lxc", name: "ct-test-01" }]);
  assert.deepEqual((await global.client.getVmList({ name: "WEB-TEST" })).map(item => item.name), ["web-test-01"]);
  assert.equal(global.requests[0].url.pathname, "/api2/json/resources/list");

  const remote = mockClient(() => [{ vmid: 101, node: "pve test 01", name: "web-test-01", status: "running" }]);
  const result = await remote.client.getVmList({ remote: "LAB-B", node: "pve test 01", status: "running" });
  assert.equal(remote.requests[0].url.pathname, "/api2/json/pve/remotes/LAB-B/qemu");
  assert.notEqual(remote.requests[0].url.pathname, "/api2/json/pve/remotes/remote/LAB-B/qemu");
  assert.equal(remote.requests[0].url.searchParams.get("node"), "pve test 01");
  assert.equal(result[0].remote, "LAB-B");
});

test("get_vm combines status/config endpoints and sanitizes configuration", async () => {
  const { client, requests } = mockClient(request => request.url.pathname.endsWith("/config")
    ? { name: "vm-test-01", cipassword: "bad", net0: "virtio,token=bad", cores: 4 }
    : { status: "running", cpu: 0.2 });
  const result = await client.getVm("LAB-A/encoded", 101, "pve test 01");
  assert.deepEqual(requests.map(item => item.url.pathname).sort(), [
    "/api2/json/pve/remotes/LAB-A%2Fencoded/qemu/101/config",
    "/api2/json/pve/remotes/LAB-A%2Fencoded/qemu/101/status",
  ]);
  assert.equal(requests[0].url.searchParams.get("node"), "pve test 01");
  assert.equal((result.config as Record<string, unknown>).cipassword, "[REDACTED]");
  assert.match(String((result.config as Record<string, unknown>).net0), /token=\[REDACTED\]/);
});

test("list_nodes uses global inventory or encoded specialized endpoint", async () => {
  const global = mockClient(() => [{ type: "node", node: "pve-test-01" }, { type: "storage", storage: "storage-test" }]);
  assert.deepEqual((await global.client.getNodeList()).map(item => item.node), ["pve-test-01"]);
  const remote = mockClient(() => [{ node: "pve-test-01", status: "online" }]);
  await remote.client.getNodeList("LAB-B");
  assert.equal(remote.requests[0].url.pathname, "/api2/json/pve/remotes/LAB-B/nodes");
});

test("get_node uses node status endpoint with encoded segments", async () => {
  const { client, requests } = mockClient(() => ({ cpu: 0.1, memory: 1024 }));
  const result = await client.getNode("LAB-A/encoded", "pve test 01");
  assert.equal(requests[0].url.pathname, "/api2/json/pve/remotes/LAB-A%2Fencoded/nodes/pve%20test%2001/status");
  assert.equal(result.node, "pve test 01");
});

test("list_containers uses global resources or specialized LXC endpoint", async () => {
  const global = mockClient(() => [{ type: "lxc", name: "ct-test-01", status: "stopped" }, { type: "qemu", name: "vm-test-01" }]);
  assert.deepEqual((await global.client.getContainerList({ status: "stopped" })).map(item => item.name), ["ct-test-01"]);
  const remote = mockClient(() => [{ vmid: 202, node: "pve-test-01", name: "ct-test-01", status: "running" }]);
  await remote.client.getContainerList({ remote: "LAB-B", node: "pve-test-01" });
  assert.equal(remote.requests[0].url.pathname, "/api2/json/pve/remotes/LAB-B/lxc");
  assert.equal(remote.requests[0].url.searchParams.get("node"), "pve-test-01");
});

test("get_container combines LXC status/config and sanitizes secrets", async () => {
  const { client, requests } = mockClient(request => request.url.pathname.endsWith("/config")
    ? { hostname: "ct-test-01", password: "bad", rootfs: "storage-test:8" } : { status: "running" });
  const result = await client.getContainer("LAB-A", 202);
  assert.deepEqual(requests.map(item => item.url.pathname).sort(), [
    "/api2/json/pve/remotes/LAB-A/lxc/202/config",
    "/api2/json/pve/remotes/LAB-A/lxc/202/status",
  ]);
  assert.equal((result.config as Record<string, unknown>).password, "[REDACTED]");
});

test("list_storages filters global inventory and uses node endpoint when scoped", async () => {
  const global = mockClient(() => [
    { remote: "LAB-A", type: "storage", "storage-type": "dir", storage: "local-test" },
    { remote: "LAB-A", type: "storage", "storage-type": "zfspool", storage: "storage-test" },
  ]);
  assert.deepEqual((await global.client.getStorageList({ remote: "LAB-A", type: "dir" })).map(item => item.storage), ["local-test"]);
  const scoped = mockClient(() => [{ storage: "local-test", type: "dir" }]);
  const result = await scoped.client.getStorageList({ remote: "LAB-A", node: "pve-test/encoded", type: "dir" });
  assert.equal(scoped.requests[0].url.pathname, "/api2/json/pve/remotes/LAB-A/nodes/pve-test%2Fencoded/storage");
  assert.equal(result[0].node, "pve-test/encoded");
});

test("get_storage resolves node from inventory then queries only storage status", async () => {
  const { client, requests } = mockClient(request => request.url.pathname === "/api2/json/pve/remotes/LAB-A/resources"
    ? [{ remote: "LAB-A", type: "storage", node: "pve test 01", storage: "local-test" }]
    : { total: 1000, used: 250, available: 750 });
  const result = await client.getStorage("LAB-A", "local-test");
  assert.equal(requests[1].url.pathname, "/api2/json/pve/remotes/LAB-A/nodes/pve%20test%2001/storage/local-test/status");
  assert.equal((result.status as Record<string, unknown>).used, 250);
});

test("filtering and sanitizer cover aliases and nested values", () => {
  assert.equal(filterResources([{ "resource-type": "qemu", hostname: "vm-test-01" }], { resourceType: "qemu", name: "VM-TEST" }).length, 1);
  assert.deepEqual(sanitizeSecrets({ nested: { apiToken: "bad", description: "password=bad,ok=yes" } }), {
    nested: { apiToken: "[REDACTED]", description: "password=[REDACTED],ok=yes" },
  });
});

const noisyGuest: PdmRecord = {
  remote: "LAB-A", node: "pve-test-01", vmid: 105, name: "vm-test-01", status: "running",
  cpu: 0.123923123981, cpus: 4, mem: 3 * 1024 ** 3, maxmem: 8 * 1024 ** 3,
  maxdisk: 50 * 1024 ** 3, netin: 123456789, netout: 987654321, diskread: 111,
  diskwrite: 222, pid: 999, uptime: 12345, pressurecpu: 0.7, tags: null,
};

test("guest summary, hardware and runtime views omit noisy telemetry", () => {
  assert.deepEqual(projectGuest(noisyGuest, "summary"), {
    remote: "LAB-A", node: "pve-test-01", vmid: 105, name: "vm-test-01", status: "running",
  });
  assert.deepEqual(projectGuest(noisyGuest, "hardware"), {
    remote: "LAB-A", node: "pve-test-01", vmid: 105, name: "vm-test-01", status: "running",
    vcpus: 4, ram_gib: 8, disk_gib: 50,
  });
  assert.deepEqual(projectGuest(noisyGuest, "runtime"), {
    remote: "LAB-A", node: "pve-test-01", vmid: 105, name: "vm-test-01", status: "running",
    cpu_pct: 12.4, ram_used_gib: 3, ram_pct: 37.5, uptime_seconds: 12345,
  });
  for (const view of ["summary", "hardware", "runtime"] as const) {
    const projected = projectGuest(noisyGuest, view);
    for (const key of ["netin", "netout", "diskread", "diskwrite", "pid", "pressurecpu", "maxmem", "maxdisk"]) {
      assert.equal(key in projected, false, `${key} leaked into ${view}`);
    }
  }
});

test("node, storage and common resource projections normalize capacity", () => {
  const node = { remote: "LAB-A", node: "pve-test-01", status: "online", maxcpu: 24, maxmem: 128 * 1024 ** 3, cpu: 0.016, mem: 32 * 1024 ** 3, uptime: 900 };
  assert.deepEqual(projectNode(node, "summary"), { remote: "LAB-A", node: "pve-test-01", status: "online" });
  assert.deepEqual(projectNode(node, "capacity"), { remote: "LAB-A", node: "pve-test-01", status: "online", cpu_cores: 24, ram_total_gib: 128 });
  assert.deepEqual(projectNode(node, "runtime"), { remote: "LAB-A", node: "pve-test-01", status: "online", cpu_pct: 1.6, ram_used_gib: 32, ram_pct: 25, uptime_seconds: 900 });

  const storage = { remote: "LAB-A", node: "pve-test-01", storage: "storage-test", type: "zfspool", status: "available", total: 100 * 1024 ** 3, used: 40 * 1024 ** 3, avail: 60 * 1024 ** 3, content: null };
  assert.deepEqual(projectStorage(storage, "summary"), { remote: "LAB-A", node: "pve-test-01", storage: "storage-test", type: "zfspool", status: "available" });
  assert.deepEqual(projectStorage(storage, "capacity"), { remote: "LAB-A", node: "pve-test-01", storage: "storage-test", type: "zfspool", status: "available", total_gib: 100, used_gib: 40, available_gib: 60, used_pct: 40 });

  assert.deepEqual(projectResource(noisyGuest, "summary"), { remote: "LAB-A", node: "pve-test-01", vmid: 105, name: "vm-test-01", status: "running" });
});

test("full views remain sanitized and omit null values", () => {
  assert.deepEqual(projectGuest({ ...noisyGuest, cipassword: "bad", nested: { token: "bad", empty: null } }, "full"), {
    ...Object.fromEntries(Object.entries(noisyGuest).filter(([, item]) => item !== null)),
    cipassword: "[REDACTED]", nested: { token: "[REDACTED]" },
  });
});

test("MCP results do not duplicate structured payload in content text", () => {
  const records = Array.from({ length: 27 }, (_, index) => ({ ...noisyGuest, vmid: 100 + index, name: `vm-${index}` }));
  const result = listResult("vms", records.map(record => projectGuest(record, "summary")), "virtual machines");
  assert.equal(result.content[0].text, "Found 27 virtual machines.");
  assert.equal(result.content[0].text.includes("vm-0"), false);
  assert.equal(result.content[0].text.includes("{"), false);
  assert.equal((result.structuredContent.vms as PdmRecord[]).length, 27);

  const detail = objectResult({ vmid: 105, name: "vm-test-01", config: { cores: 4 } }, "Retrieved VM 105.");
  assert.equal(detail.content[0].text, "Retrieved VM 105.");
  assert.equal(detail.content[0].text.includes("cores"), false);
});

test("27 VM summaries are substantially smaller than complete PDM records", () => {
  const complete = Array.from({ length: 27 }, (_, index) => ({ ...noisyGuest, vmid: 100 + index, name: `vm-${index}` }));
  const summary = complete.map(record => projectGuest(record, "summary"));
  const before = Buffer.byteLength(JSON.stringify(complete));
  const after = Buffer.byteLength(JSON.stringify(summary));
  assert.equal(after < before * 0.4, true, `expected >60% reduction, got ${before} -> ${after}`);
});

test("get_remote_summary uses exactly nodes, qemu and lxc and aggregates physical capacity", async () => {
  const { client, requests } = mockClient(request => {
    if (request.url.pathname.endsWith("/nodes")) return [
      { node: "pve-test-01", status: "online", maxcpu: 12, maxmem: 16 * 1024 ** 3 },
      { node: "pve-test-02", status: "offline", maxcpu: 20, maxmem: 32 * 1024 ** 3 },
    ];
    if (request.url.pathname.endsWith("/qemu")) return [{ status: "running" }, { status: "stopped" }, { status: "running" }];
    if (request.url.pathname.endsWith("/lxc")) return [{ status: "running" }];
    throw new Error(`Unexpected path ${request.url.pathname}`);
  });
  assert.deepEqual(await client.getRemoteSummary("LAB-A"), {
    remote: "LAB-A",
    nodes: { total: 2, online: 1, offline: 1 },
    vms: { total: 3, running: 2, stopped: 1 },
    containers: { total: 1, running: 1, stopped: 0 },
    capacity: { cpu_cores: 32, ram_total_gib: 48 },
  });
  assert.deepEqual(requests.map(request => request.url.pathname).sort(), [
    "/api2/json/pve/remotes/LAB-A/lxc",
    "/api2/json/pve/remotes/LAB-A/nodes",
    "/api2/json/pve/remotes/LAB-A/qemu",
  ]);
});

test("all proxied PVE operations share the canonical root and never add literal remote", async () => {
  const { client, requests } = mockClient(request => {
    if (request.url.pathname.endsWith("/resources")) return [{ type: "storage", node: "pve-test-01", storage: "storage-test" }];
    if (request.url.pathname.endsWith("/config") || request.url.pathname.endsWith("/status")) return {};
    return [];
  });
  await client.getResources({ remote: "LAB-B" });
  await client.getVmList({ remote: "LAB-B" });
  await client.getVm("LAB-B", 105);
  await client.getNodeList("LAB-B");
  await client.getNode("LAB-B", "pve-test-01");
  await client.getContainerList({ remote: "LAB-B" });
  await client.getContainer("LAB-B", 205);
  await client.getStorageList({ remote: "LAB-B", node: "pve-test-01" });
  await client.getStorage("LAB-B", "storage-test", "pve-test-01");

  assert.equal(requests.length > 0, true);
  assert.equal(requests.every(request => request.url.pathname.startsWith("/api2/json/pve/remotes/LAB-B/")), true);
  assert.equal(requests.some(request => request.url.pathname.includes("/pve/remotes/remote/")), false);
  assert.equal(pveRemotePath("LAB-B", "/qemu"), "/api2/json/pve/remotes/LAB-B/qemu");
});

test("tool registry names are canonical and complete", () => {
  assert.deepEqual(ALL_TOOL_NAMES, [
    "list_remotes", "list_resources", "list_vms", "get_vm", "list_nodes",
    "get_node", "list_containers", "get_container", "list_storages", "get_storage",
    "get_remote_summary", "list_tasks", "get_task",
  ]);
  assert.equal(Object.values(TOOL_NAMES).some(name => name.startsWith("pdm_")), false);
  assert.equal(pdmAuthorization(config), "PDMAPIToken test-user@pdm!test-token:test-secret");
});

test("parseNodeFromUpid extracts node from valid UPIDs", () => {
  assert.equal(parseNodeFromUpid("UPID:pve-test-01:00001234:00005678:65A4B3C2:vzdump:100:root@pam:"), "pve-test-01");
  assert.equal(parseNodeFromUpid("invalid:upid"), undefined);
  assert.equal(parseNodeFromUpid(""), undefined);
});

test("projectTask formats summary and full views and sanitizes secrets", () => {
  const raw = {
    remote: "LAB-A",
    node: "pve-test-01",
    upid: "UPID:pve-test-01:00001234:00005678:65A4B3C2:vzdump:100:root@pam:",
    type: "vzdump",
    id: "100",
    status: "OK",
    user: "readonly@pdm!mcp",
    starttime: 1700000000,
    endtime: 1700000100,
    password: "supersecretpassword",
  };
  assert.deepEqual(projectTask(raw, "summary"), {
    remote: "LAB-A",
    node: "pve-test-01",
    upid: "UPID:pve-test-01:00001234:00005678:65A4B3C2:vzdump:100:root@pam:",
    type: "vzdump",
    id: "100",
    status: "OK",
    user: "readonly@pdm!mcp",
    starttime: 1700000000,
    endtime: 1700000100,
  });
  const full = projectTask(raw, "full");
  assert.equal(full.password, "[REDACTED]");
});

test("getTaskList queries cluster tasks when node is not specified and applies filters", async () => {
  const { client, requests } = mockClient(() => [
    { upid: "UPID:pve-test-01:001:vzdump:100", type: "vzdump", status: "OK", node: "pve-test-01" },
  ]);
  const tasks = await client.getTaskList({ remote: "LAB-A", limit: 10, errorsOnly: true });
  assert.equal(requests[0].url.pathname, "/api2/json/pve/remotes/LAB-A/cluster/tasks");
  assert.equal(requests[0].url.searchParams.get("limit"), "10");
  assert.equal(requests[0].url.searchParams.get("errors"), "1");
  assert.equal(tasks[0].remote, "LAB-A");
  assert.equal(tasks[0].node, "pve-test-01");
});

test("getTaskList queries node tasks when node is specified", async () => {
  const { client, requests } = mockClient(() => [
    { upid: "UPID:pve-test-01:001:vzdump:100", type: "vzdump", status: "OK" },
  ]);
  const tasks = await client.getTaskList({ remote: "LAB-A", node: "pve-test-01", vmid: 100 });
  assert.equal(requests[0].url.pathname, "/api2/json/pve/remotes/LAB-A/nodes/pve-test-01/tasks");
  assert.equal(requests[0].url.searchParams.get("vmid"), "100");
  assert.equal(tasks[0].remote, "LAB-A");
  assert.equal(tasks[0].node, "pve-test-01");
});

test("getTask queries task status with explicit or inferred node", async () => {
  const { client, requests } = mockClient(() => ({ status: "stopped", exitstatus: "OK" }));
  const upid = "UPID:pve-test-01:00001234:00005678:65A4B3C2:vzdump:100:root@pam:";

  // Inferred node
  const resInferred = await client.getTask("LAB-A", upid);
  assert.equal(requests[0].url.pathname, `/api2/json/pve/remotes/LAB-A/nodes/pve-test-01/tasks/${encodeURIComponent(upid)}/status`);
  assert.equal(resInferred.node, "pve-test-01");

  // Explicit node
  await client.getTask("LAB-A", "custom-upid", "pve-test-02");
  assert.equal(requests[1].url.pathname, "/api2/json/pve/remotes/LAB-A/nodes/pve-test-02/tasks/custom-upid/status");

  // Missing node error
  await assert.rejects(client.getTask("LAB-A", "invalid-upid"), /Node could not be determined/);
});
