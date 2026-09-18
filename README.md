# PDM MCP Server

## Ejecutar con Docker

Editá las credenciales PDM y ejecutá:

```bash
docker run -d \
  --name pdm-mcp-server \
  --restart unless-stopped \
  --pull always \
  -p 3000:3000 \
  -e PDM_URL="https://pdm.example.com:8443" \
  -e PDM_TOKEN_ID='readonly@pdm!mcp' \
  -e PDM_TOKEN_SECRET='replace-with-token-secret' \
  -e PDM_TLS_INSECURE="false" \
  -e MCP_AUTH_MODE="disabled" \
  jer3m/pdm-mcp-server:latest
```

El servidor queda disponible en `http://localhost:3000/mcp`. Verificá que arrancó con:

```bash
curl http://localhost:3000/healthz
```

Si PDM utiliza un certificado interno o autofirmado, cambiá `PDM_TLS_INSECURE` a `true`. Para evitar guardar el secreto en el historial del shell, también podés pasar estas mismas variables mediante `--env-file`.

Servidor MCP estrictamente read-only para Proxmox Datacenter Manager (PDM). Expone Streamable HTTP stateless en `/mcp`; cada request recibe un servidor y transporte nuevos, por lo que no depende de sesiones en memoria.

## Autenticación y autorización por request

Elegí explícitamente `MCP_AUTH_MODE=disabled` para conservar el comportamiento sin autenticación, o `MCP_AUTH_MODE=jwt` para restringir cada request a los remotes permitidos. Si el modo falta, es desconocido o la configuración JWT es inválida, el servidor no arranca; nunca vuelve automáticamente al acceso sin restricciones. `.env.example` y Compose seleccionan `disabled` por compatibilidad.

Para activar JWT, además de las credenciales PDM, configurá:

```dotenv
MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<server-side-random-signing-secret>
MCP_JWT_AUDIENCE=pdm-mcp
```

Reemplazá el marcador del secreto por un valor aleatorio de al menos 32 bytes, generado y almacenado en el servidor. `MCP_JWT_AUDIENCE` es opcional y tiene como valor predeterminado `pdm-mcp`; el secreto es obligatorio en modo JWT. Compose recibe estas variables del entorno o de `.env`. Para ejecutar Node directamente, cargalas en el entorno o usá `node --env-file=.env dist/index.js` después del build.

El cliente debe enviar `Authorization: Bearer <jwt>` en **cada** request a `/mcp`, incluyendo `initialize` y `tools/list`. Se acepta únicamente HS256 y se verifican firma, audiencia (`aud`), vencimiento obligatorio (`exp`, segundos Unix) y `nbf` si existe. El claim `pdm_remotes` debe ser un array no vacío de strings no vacíos, por ejemplo `{"pdm_remotes":["LAB-A"]}` o `{"pdm_remotes":["LAB-A","LAB-B"]}`. Los nombres se comparan exactamente, distinguiendo mayúsculas y minúsculas; no se aceptan espacios al principio o al final. Emití tokens de corta duración con la audiencia configurada y un vencimiento futuro. Un JWT ausente, inválido o sin alcance válido recibe HTTP 401 con un error genérico. `GET /healthz` permanece público.

El modo JWT está pensado para aplicaciones que derivan la autorización **del lado del servidor**. El backend emisor debe obtener los remotes permitidos de su propia política de acceso: nunca debe dejar que el usuario final elija su claim `pdm_remotes`. El secreto de firma nunca debe exponerse a browsers ni LLMs. Usá HTTPS delante de `/mcp` para proteger los bearer tokens en tránsito. Esta integración verifica tokens emitidos por tu aplicación; no implementa un servidor OAuth ni un flujo de login.

Una misma instancia MCP puede atender múltiples alcances aislados. Cada request crea su propio cliente PDM con el alcance del JWT verificado. El MCP vuelve a aplicar la autorización aunque el caller o el LLM proporcionen un argumento `remote`: un remote no permitido produce `Access denied.` sin consultar PDM ni revelar otros remotes. Los argumentos de las tools no pueden ampliar el alcance.

En modo JWT, `list_resources`, `list_vms`, `list_nodes`, `list_containers` y `list_storages` sin `remote` consultan secuencialmente **solo los remotes permitidos** y agregan sus resultados; no utilizan el inventario global ni lo filtran después. En esas consultas `max_age` no aplica, porque se usan las rutas existentes por remote. `list_remotes` consulta la colección de configuración y devuelve únicamente las entradas con ID autorizado, sanitizando secretos. Los errores de autenticación y los errores de requests PDM en modo JWT son genéricos y no incluyen tokens, headers, secretos ni cuerpos de respuesta.

Con `MCP_AUTH_MODE=disabled`, se mantienen el inventario global y el acceso sin alcance previo. Restringí ese endpoint a clientes confiables mediante la red o un reverse proxy. Los permisos del token PDM siguen siendo el límite superior y todas las tools siguen siendo read-only.

## Tools

| Tool | Fuente PDM | Uso |
| --- | --- | --- |
| `list_remotes` | `GET /api2/json/remotes/remote` | Remotes configurados |
| `list_resources` | `GET /api2/json/resources/list` o `GET .../resources` | Inventario global cacheado o de un remote |
| `list_vms` | Inventario global o `GET .../qemu` | VMs QEMU, globales o por remote |
| `get_vm` | `GET .../qemu/{vmid}/status` y `/config` | Runtime y configuración sanitizada |
| `list_nodes` | Inventario global o `GET .../nodes` | Nodos globales o por remote |
| `get_node` | `GET .../nodes/{node}/status` | Estado detallado del nodo |
| `list_containers` | Inventario global o `GET .../lxc` | Containers LXC, globales o por remote |
| `get_container` | `GET .../lxc/{vmid}/status` y `/config` | Runtime y configuración sanitizada |
| `list_storages` | Inventario global o `GET .../nodes/{node}/storage` | Estado general, sin listar contenido |
| `get_storage` | Inventario global y `GET .../storage/{storage}/status` | Estado de un storage, sin su contenido |
| `get_remote_summary` | `GET .../nodes`, `/qemu` y `/lxc` | Totales y capacidad física sin listar cada recurso |
| `list_tasks` | `GET .../cluster/tasks` o `GET .../nodes/{node}/tasks` | Tareas recientes y activas (cluster o por nodo/vmid) |
| `get_task` | `GET .../nodes/{node}/tasks/{upid}/status` | Estado detallado de una tarea por UPID |

En la tabla, `...` significa `/api2/json/pve/remotes/{remote}`. La colección de configuración de remotes es distinta y conserva `/api2/json/remotes/remote`. Los nombres de remote, node y storage se codifican como segmentos URL. Las respuestas incluyen texto JSON por compatibilidad y `structuredContent` para clientes MCP que lo soportan.

El inventario global envía `max-age=300` por defecto para reutilizar el cache de PDM y evitar recolectar todos los remotes en cada consulta. `list_resources` acepta `max_age`; usá `0` cuando necesites forzar una actualización. Con `remote` se consulta directamente `/pve/remotes/{remote}/resources`, evitando el fan-out global. `PDM_TIMEOUT_MS` sigue siendo configurable y mantiene su default de 15 segundos.
El inventario global envía `max-age=300` por defecto para reutilizar el cache de PDM y evitar recolectar todos los remotes en cada consulta. `list_resources` acepta `max_age`; usá `0` cuando necesites forzar una actualización. Con `remote` se consulta directamente `/pve/remotes/{remote}/resources`, evitando el fan-out global. `PDM_TIMEOUT_MS` sigue siendo configurable y mantiene su default de 60 segundos.

`get_vm`, `get_container` y las consultas de tareas eliminan claves sensibles como passwords, tokens, secrets, claves SSH y valores equivalentes embebidos. El servidor nunca incluye el header de autorización ni el body de un error PDM en sus errores.

## Respuestas compactas

Las tools de listado devuelven una frase corta en `content` y los datos una sola vez en `structuredContent`. La vista predeterminada es siempre compacta:

- `list_vms` y `list_containers`: `summary`, `hardware`, `runtime` o `full`.
- `list_nodes`: `summary`, `capacity`, `runtime` o `full`.
- `list_storages`: `summary`, `capacity` o `full`.
- `list_resources` y `list_tasks`: `summary` o `full`.

`summary` sirve para descubrir e identificar recursos. `hardware`/`capacity` normalizan bytes a GiB; `runtime` normaliza ratios a porcentajes. `full` debe pedirse explícitamente y continúa sanitizando secretos. Para el detalle de un único elemento usá su tool `get_*`.

Para preguntas agregadas como cantidad de VMs encendidas o RAM física total, preferí `get_remote_summary`: usa solamente los listados de nodes, QEMU y LXC, sin hacer una request por guest.

## Requisitos y configuración

- Node.js 24 o posterior.
- PDM 1.x accesible por HTTPS.
- Usuario y token dedicados con rol `Auditor` propagado sobre `/resource`. Los permisos del token nunca superan los del usuario.

Variables requeridas:

```text
PDM_URL=https://pdm.example.com:8443
PDM_TOKEN_ID=readonly@pdm!mcp
PDM_TOKEN_SECRET=replace-me
```

Variables opcionales:

```text
PDM_TLS_INSECURE=false
PDM_TIMEOUT_MS=15000
PDM_TIMEOUT_MS=60000
MCP_PORT=3000
```

`PDM_TLS_INSECURE=true` deshabilita la validación TLS solamente para esa conexión PDM; usalo únicamente con certificados internos/autofirmados.

## Desarrollo y prueba manual

```powershell
npm install
npm test
npm start
```

Comprobá primero la salud:

```powershell
curl.exe http://localhost:3000/healthz
```

Para ejecutar tools sin poner credenciales PDM en comandos, iniciá MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector
```

En Inspector elegí **Streamable HTTP**, usá `http://localhost:3000/mcp`, conectá y abrí **Tools**. Pruebas sugeridas:

```json
list_resources {}
list_vms {"view":"summary"}
list_vms {"remote":"LAB-A"}
list_vms {"remote":"LAB-A","view":"hardware"}
list_vms {"remote":"LAB-A","view":"runtime"}
get_vm {"remote":"LAB-A","vmid":105}
list_nodes {"view":"summary"}
list_nodes {"remote":"LAB-A"}
list_containers {}
list_storages {}
list_storages {"remote":"LAB-A","node":"pve-test-01"}
get_remote_summary {"remote":"LAB-A"}
list_tasks {"remote":"LAB-A"}
list_tasks {"remote":"LAB-A","errors_only":true}
list_tasks {"remote":"LAB-A","node":"pve-test-01","vmid":105}
get_task {"remote":"LAB-A","upid":"UPID:pve-test-01:00001234:00005678:65A4B3C2:vzdump:105:readonly@pdm!mcp:"}
```

Para Codex:

```toml
[mcp_servers.pdm]
url = "http://mcp.example.internal:3000/mcp"
```

En modo JWT, configurá también el bearer token emitido por tu backend en el cliente MCP. En modo `disabled`, publicá el puerto 3000 únicamente en una red confiable o restringilo mediante firewall/reverse proxy.

## Docker y CI

La imagen pública es `jer3m/pdm-mcp-server:latest` y se construye desde GitHub Actions. Para publicar nuevas versiones configurá:

- Variable `DOCKERHUB_IMAGE`, por ejemplo `tuusuario/pdm-mcp-server`.
- Secret `DOCKERHUB_USERNAME`.
- Secret `DOCKERHUB_TOKEN`, un access token de Docker Hub con permiso de escritura.

El workflow **Publish Docker image** se ejecuta manualmente con el tag indicado o con un tag Git `v*`; en este último caso también publica `latest`.

`compose.yml` publica `3000:3000` y muestra todas las variables necesarias. Después de editar sus valores:

```bash
docker pull jer3m/pdm-mcp-server:latest
docker compose up -d
curl http://localhost:3000/healthz
```
