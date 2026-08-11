import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GoogleHandler } from "./auth/google-handler.js";
import { WorkspaceMCP } from "./mcp/server.js";

export { WorkspaceMCP };

export default new OAuthProvider({
  apiHandler: WorkspaceMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GoogleHandler as any,
  tokenEndpoint: "/token",
});
