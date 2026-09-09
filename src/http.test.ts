import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { ALL_TOOL_NAMES } from "./tool-names.js";

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

async function rpc(url: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
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
