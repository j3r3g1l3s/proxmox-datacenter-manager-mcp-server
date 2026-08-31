FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Proxmox Datacenter Manager MCP Server" \
      org.opencontainers.image.description="Read-only MCP server for Proxmox Datacenter Manager (PDM) resources, virtual machines, containers, nodes and storages." \
      org.opencontainers.image.source="https://github.com/j3r3g1l3s/pdm-mcp-server" \
      org.opencontainers.image.url="https://github.com/j3r3g1l3s/pdm-mcp-server" \
      org.opencontainers.image.documentation="https://github.com/j3r3g1l3s/pdm-mcp-server#readme" \
      org.opencontainers.image.vendor="jer3m" \
      org.opencontainers.image.keywords="proxmox,proxmox-datacenter-manager,pdm,mcp,model-context-protocol"
ENV NODE_ENV=production
EXPOSE 3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
