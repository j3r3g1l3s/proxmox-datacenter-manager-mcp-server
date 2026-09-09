import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PdmClient, projectGuest, projectNode, projectResource, projectStorage, projectTask,
  type PdmRecord, type ResourceFilters,
} from "./pdm.js";
import { TOOL_NAMES } from "./tool-names.js";

const optionalText = z.string().trim().min(1).optional();
const vmid = z.number().int().positive();
const readOnly = { readOnlyHint: true } as const;
const guestView = z.enum(["summary", "hardware", "runtime", "full"]).default("summary");
const nodeView = z.enum(["summary", "capacity", "runtime", "full"]).default("summary");
const storageView = z.enum(["summary", "capacity", "full"]).default("summary");
const resourceView = z.enum(["summary", "full"]).default("summary");
const taskView = z.enum(["summary", "full"]).default("summary");

export function listResult(key: string, records: PdmRecord[], label: string) {
  const structuredContent = { count: records.length, [key]: records };
  return { content: [{ type: "text" as const, text: `Found ${records.length} ${label}.` }], structuredContent };
}

export function objectResult(record: PdmRecord, message: string) {
  return { content: [{ type: "text" as const, text: message }], structuredContent: record };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error contacting PDM.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerTools(server: McpServer, client: PdmClient): void {
  server.registerTool(TOOL_NAMES.listRemotes, {
    description: "List remotes configured in Proxmox Datacenter Manager.",
    annotations: readOnly,
  }, async () => {
    try { return listResult("remotes", await client.getRemoteList(), "remotes"); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listResources, {
    description: "List and filter resources managed by Proxmox Datacenter Manager.",
    annotations: readOnly,
    inputSchema: {
      remote: optionalText,
      resource_type: optionalText,
      node: optionalText,
      name: optionalText,
      vmid: vmid.optional(),
      status: optionalText,
      max_age: z.number().int().nonnegative().optional().describe("Maximum cache age in seconds; defaults to 300. Use 0 to force refresh."),
      view: resourceView,
    },
  }, async ({ resource_type, max_age, view, ...input }) => {
    try {
      const records = await client.getResources({ ...input, resourceType: resource_type, maxAge: max_age } as ResourceFilters);
      return listResult("resources", records.map(record => projectResource(record, view)), "resources");
    }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listVms, {
    description: "List QEMU virtual machines. Defaults to a compact summary. Use view=hardware for assigned CPU/RAM/disk, view=runtime for current usage, and get_vm for details about one VM.",
    annotations: readOnly,
    inputSchema: { remote: optionalText, node: optionalText, name: optionalText, status: optionalText, view: guestView },
  }, async ({ view, ...input }) => {
    try { return listResult("vms", (await client.getVmList(input)).map(record => projectGuest(record, view)), "virtual machines"); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.getVm, {
    description: "Get detailed read-only runtime and configuration information for one QEMU virtual machine.",
    annotations: readOnly,
    inputSchema: { remote: z.string().trim().min(1), vmid, node: optionalText },
  }, async ({ remote, vmid, node }) => {
    try { return objectResult(await client.getVm(remote, vmid, node), `Retrieved VM ${vmid}.`); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listNodes, {
    description: "List PVE nodes. Defaults to a compact summary. Use view=capacity for physical CPU/RAM, view=runtime for current usage, and get_node for one node's details.",
    annotations: readOnly,
    inputSchema: { remote: optionalText, view: nodeView },
  }, async ({ remote, view }) => {
    try { return listResult("nodes", (await client.getNodeList(remote)).map(record => projectNode(record, view)), "nodes"); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.getNode, {
    description: "Get detailed read-only status information for one Proxmox VE node.",
    annotations: readOnly,
    inputSchema: { remote: z.string().trim().min(1), node: z.string().trim().min(1) },
  }, async ({ remote, node }) => {
    try { return objectResult(await client.getNode(remote, node), `Retrieved node ${node}.`); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listContainers, {
    description: "List LXC containers. Defaults to a compact summary. Use view=hardware for assigned CPU/RAM/disk, view=runtime for current usage, and get_container for details about one container.",
    annotations: readOnly,
    inputSchema: { remote: optionalText, node: optionalText, name: optionalText, status: optionalText, view: guestView },
  }, async ({ view, ...input }) => {
    try { return listResult("containers", (await client.getContainerList(input)).map(record => projectGuest(record, view)), "containers"); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.getContainer, {
    description: "Get detailed read-only runtime and configuration information for one LXC container.",
    annotations: readOnly,
    inputSchema: { remote: z.string().trim().min(1), vmid, node: optionalText },
  }, async ({ remote, vmid, node }) => {
    try { return objectResult(await client.getContainer(remote, vmid, node), `Retrieved container ${vmid}.`); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listStorages, {
    description: "List PVE storages. Defaults to a compact summary. Use view=capacity for total/used/available space, and get_storage for one storage's details.",
    annotations: readOnly,
    inputSchema: { remote: optionalText, node: optionalText, type: optionalText, view: storageView },
  }, async ({ view, ...input }) => {
    try { return listResult("storages", (await client.getStorageList(input)).map(record => projectStorage(record, view)), "storages"); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.getStorage, {
    description: "Get read-only status information for one Proxmox VE storage.",
    annotations: readOnly,
    inputSchema: { remote: z.string().trim().min(1), storage: z.string().trim().min(1), node: optionalText },
  }, async ({ remote, storage, node }) => {
    try { return objectResult(await client.getStorage(remote, storage, node), `Retrieved storage ${storage}.`); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.getRemoteSummary, {
    description: "Get a compact aggregate summary of one PDM remote, including node, VM, container and physical capacity counts. Prefer this for totals instead of listing every resource.",
    annotations: readOnly,
    inputSchema: { remote: z.string().trim().min(1) },
  }, async ({ remote }) => {
    try { return objectResult(await client.getRemoteSummary(remote), `Retrieved summary for remote ${remote}.`); }
    catch (error) { return toolError(error); }
  });

  server.registerTool(TOOL_NAMES.listTasks, {
    description: "List recent and active tasks for a remote PVE cluster or specific node. Defaults to a compact summary. Use for tracking backups, migrations, or troubleshooting failures.",
    annotations: readOnly,
    inputSchema: {
      remote: z.string().trim().min(1).describe("Remote name (e.g. LAB-A)"),
      node: optionalText.describe("Optional node name to list node-specific tasks"),
      vmid: vmid.optional().describe("Filter tasks by VM/container ID (requires node)"),
      errors_only: z.boolean().optional().describe("Only return failed tasks"),
      limit: z.number().int().positive().max(100).default(20).describe("Maximum number of tasks to return (default: 20, max: 100)"),
      view: taskView,
    },
  }, async ({ remote, node, vmid, errors_only, limit, view }) => {
    try {
      const records = await client.getTaskList({ remote, node, vmid, errorsOnly: errors_only, limit });
      return listResult("tasks", records.map(record => projectTask(record, view)), "tasks");
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool(TOOL_NAMES.getTask, {
    description: "Get detailed read-only status and execution result of a specific task by UPID.",
    annotations: readOnly,
    inputSchema: {
      remote: z.string().trim().min(1).describe("Remote name (e.g. LAB-A)"),
      upid: z.string().trim().min(1).describe("Unique Process ID of the task (UPID)"),
      node: optionalText.describe("Node where the task ran (inferred from UPID if omitted)"),
    },
  }, async ({ remote, upid, node }) => {
    try {
      return objectResult(await client.getTask(remote, upid, node), `Retrieved task ${upid}.`);
    } catch (error) {
      return toolError(error);
    }
  });
}
