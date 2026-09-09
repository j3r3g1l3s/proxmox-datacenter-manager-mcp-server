export const TOOL_NAMES = {
  listRemotes: "list_remotes",
  listResources: "list_resources",
  listVms: "list_vms",
  getVm: "get_vm",
  listNodes: "list_nodes",
  getNode: "get_node",
  listContainers: "list_containers",
  getContainer: "get_container",
  listStorages: "list_storages",
  getStorage: "get_storage",
  getRemoteSummary: "get_remote_summary",
  listTasks: "list_tasks",
  getTask: "get_task",
} as const;

export const ALL_TOOL_NAMES = Object.values(TOOL_NAMES);
