# PDM MCP project rules

- This project implements a Proxmox Datacenter Manager MCP server; PDM is not the direct PVE API.
- Keep all tools read-only unless the user explicitly changes that scope.
- Verify every endpoint against the current PDM API before implementing it; never invent paths.
- Use short tool names such as `list_vms` and `get_vm`; do not add a `pdm_` prefix.
- Preserve least privilege and never log API tokens, secrets, or complete authorization headers.
- Keep the Streamable HTTP transport stateless by creating a fresh server and transport per request.
- Run tests, build, and verify `tools/list` after changing tools.
- Avoid major dependency upgrades unless their breaking changes are reviewed first.

## Public repository sanitization rules

This repository may be published publicly. Never use, introduce, or preserve references derived from real infrastructure, customers, internal systems, or production environments.

For all source code, tests, examples, documentation, comments, fixtures, commit-ready changes, and configuration samples:

* Do not use any real company, customer, site, or organization name found in repository history or local context.
* Do not use any real internal hostname or other hostname taken from actual environments.
* Do not use real private IP addresses from the user's infrastructure, including addresses from RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) if they originated from a real environment.
* Do not reuse real remote names, VM names, node names, storage names, domains, usernames, email addresses, VPN names, VLAN names, site names, or customer identifiers.
* Do not infer new examples from existing production-looking values in the repository.

Always replace such values with obviously fictional, neutral examples.

Preferred examples:

* Remotes: `LAB-A`, `LAB-B`, `example-remote`
* Nodes: `pve-test-01`, `pve-test-02`
* VMs: `vm-test-01`, `web-test-01`
* Containers: `ct-test-01`
* Storages: `local-test`, `storage-test`
* Hosts: `mcp.example.internal`, `pdm.example.com`
* IPs: use documentation ranges such as `192.0.2.0/24`, `198.51.100.0/24`, or `203.0.113.0/24`
* Users/tokens: `readonly@pdm!mcp`, `test-token`, `replace-with-token-secret`

Before considering a change complete, review every modified file and ensure no real infrastructure identifier, customer name, hostname, private IP, credential, secret, or production-specific value has been introduced.

When an existing test contains a real-world identifier, sanitize it as part of the change rather than copying or extending it.
