import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, PdmClient } from "./pdm.js";
import { registerTools } from "./tools.js";

const config = loadConfig();
const port = Number(process.env.MCP_PORT ?? "3000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MCP_PORT must be a valid TCP port.");
}
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "pdm-mcp-server", version: "0.1.0" });
  registerTools(server, new PdmClient(config));
  return server;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString();
  return body ? JSON.parse(body) : undefined;
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    return send(response, 200, "ok\n");
  }

  if (request.url !== "/mcp") {
    return send(response, 404, "Not found\n");
  }

  try {
    // ponytail: read-only tools are stateless; each request receives a fresh MCP server and transport.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await createMcpServer().connect(transport);
    await transport.handleRequest(request, response, await readJson(request));
  } catch {
    if (!response.headersSent) {
      send(response, 400, "Invalid MCP request\n");
    }
  }
}).listen(port, "0.0.0.0");
