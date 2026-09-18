import { jwtVerify } from "jose";

export interface RequestScope { readonly allowedRemotes: ReadonlySet<string> }
export type AuthConfig = { mode: "disabled" } | { mode: "jwt"; secret: Uint8Array; audience: string };

export function loadAuthConfig(env = process.env): AuthConfig {
  if (env.MCP_AUTH_MODE === "disabled") return { mode: "disabled" };
  if (env.MCP_AUTH_MODE !== "jwt") throw new Error("MCP_AUTH_MODE must be disabled or jwt.");
  const secret = new TextEncoder().encode(env.MCP_JWT_SECRET ?? "");
  if (secret.length < 32) throw new Error("MCP_JWT_SECRET must contain at least 32 bytes.");
  const audience = env.MCP_JWT_AUDIENCE ?? "pdm-mcp";
  if (!audience.trim()) throw new Error("MCP_JWT_AUDIENCE must not be empty.");
  return { mode: "jwt", secret, audience };
}

export async function authenticate(config: AuthConfig, authorization?: string): Promise<RequestScope | undefined> {
  if (config.mode === "disabled") return undefined;
  try {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization ?? "");
    if (!match) throw new Error();
    const { payload } = await jwtVerify(match[1], config.secret, {
      algorithms: ["HS256"], audience: config.audience, requiredClaims: ["exp", "pdm_remotes"],
    });
    const remotes = payload.pdm_remotes;
    if (!Array.isArray(remotes) || remotes.length === 0
      || remotes.some(remote => typeof remote !== "string" || !remote.trim() || remote !== remote.trim())) {
      throw new Error();
    }
    return { allowedRemotes: new Set(remotes) };
  } catch {
    throw new Error("Unauthorized.");
  }
}
