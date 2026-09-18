import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { loadAuthConfig } from "./auth.js";
import { ALL_TOOL_NAMES } from "./tool-names.js";

const signingSecret = randomBytes(32).toString("hex");
function token(claims: Record<string, unknown> = {}, secret = signingSecret, alg = "HS256"): string {
  const header = Buffer.from(JSON.stringify({ alg })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ aud: "pdm-mcp", exp: Math.floor(Date.now() / 1000) + 300, pdm_remotes: ["LAB-A"], ...claims })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${createHmac(alg === "HS512" ? "sha512" : "sha256", secret).update(input).digest("base64url")}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate test port."));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("MCP test server did not start.");
}

async function rpc(url: string, body: object, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const line = (await response.text()).split("\n").find(item => item.startsWith("data: "));
  assert.ok(line, "MCP response must contain an SSE data event");
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}

test("stateless HTTP initialize and tools/list expose every read-only tool", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      PDM_URL: "https://pdm.invalid:8443",
      PDM_TOKEN_ID: "test-token",
      PDM_TOKEN_SECRET: "not-a-real-secret",
      MCP_PORT: String(port),
      MCP_AUTH_MODE: "disabled",
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(baseUrl);
    const initialized = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(((initialized.result as Record<string, unknown>).serverInfo as Record<string, unknown>).name, "pdm-mcp-server");

    const listed = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = ((listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
    assert.deepEqual(tools.map(tool => tool.name), ALL_TOOL_NAMES);
    assert.equal(tools.every(tool => (tool.annotations as Record<string, unknown>).readOnlyHint === true), true);
    const listVms = tools.find(tool => tool.name === "list_vms");
    const properties = ((listVms?.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>);
    assert.deepEqual(properties.view.enum, ["summary", "hardware", "runtime", "full"]);
    assert.equal(properties.view.default, "summary");

    const listTasks = tools.find(tool => tool.name === "list_tasks");
    const taskProperties = ((listTasks?.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>);
    assert.deepEqual(taskProperties.view.enum, ["summary", "full"]);
    assert.equal(taskProperties.view.default, "summary");
  } finally {
    child.kill();
  }
});

test("auth configuration fails closed and requires an explicit mode", () => {
  for (const env of [{}, { MCP_AUTH_MODE: "typo" }, { MCP_AUTH_MODE: "jwt" },
    { MCP_AUTH_MODE: "jwt", MCP_JWT_SECRET: "test-short-secret" },
    { MCP_AUTH_MODE: "jwt", MCP_JWT_SECRET: signingSecret, MCP_JWT_AUDIENCE: " " }]) {
    assert.throws(() => loadAuthConfig(env), error => error instanceof Error && !error.message.includes(signingSecret));
  }
  assert.deepEqual(loadAuthConfig({ MCP_AUTH_MODE: "disabled" }), { mode: "disabled" });
  assert.equal(loadAuthConfig({ MCP_AUTH_MODE: "jwt", MCP_JWT_SECRET: signingSecret }).mode, "jwt");
});

test("JWT HTTP authentication rejects invalid credentials, protects every request and keeps health public", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PDM_URL: "https://pdm.example.com:8443", PDM_TOKEN_ID: "readonly@pdm!mcp",
      PDM_TOKEN_SECRET: "replace-with-token-secret", MCP_PORT: String(port), MCP_AUTH_MODE: "jwt",
      MCP_JWT_SECRET: signingSecret, MCP_JWT_AUDIENCE: "pdm-mcp" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    await waitForHealth(baseUrl);
    const invalidHeaders = [undefined, "Bearer malformed", "Basic test-token", "Bearer a.b.c", "Bearer " + token({}, "test-invalid-signature"),
      ...[{ exp: 1 }, { exp: undefined }, { exp: "invalid" }, { aud: "other-audience" }, { aud: undefined },
        { nbf: Math.floor(Date.now() / 1000) + 3600 }, { pdm_remotes: [] }, { pdm_remotes: undefined },
        { pdm_remotes: "LAB-A" }, { pdm_remotes: ["LAB-A", 1] }, { pdm_remotes: [""] }, { pdm_remotes: [" "] },
      ].map(claims => `Bearer ${token(claims)}`), `Bearer ${token({}, signingSecret, "none")}`, `Bearer ${token({}, signingSecret, "HS512")}`];
    for (const authorization of invalidHeaders) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST", headers: authorization ? { Authorization: authorization } : {}, body: "invalid-json",
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal(await response.text(), "Unauthorized.\n");
    }
    for (const method of ["GET", "DELETE"]) {
      assert.equal((await fetch(`${baseUrl}/mcp`, { method })).status, 401);
    }
    for (const pdm_remotes of [["LAB-A"], ["LAB-B"]]) {
      const jwt = token({ pdm_remotes });
      const listed = await rpc(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, jwt);
      const tools = (listed.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
      assert.deepEqual(tools.map(tool => tool.name), ALL_TOOL_NAMES);
      assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
      const denied = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "list_vms", arguments: { remote: pdm_remotes[0] === "LAB-A" ? "LAB-B" : "LAB-A" } } }, jwt);
      assert.deepEqual(denied.result, { content: [{ type: "text", text: "Access denied." }], isError: true });
    }
    // A previously authenticated call does not authenticate the next request.
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal(output, "");
  } finally {
    child.kill();
  }
});
