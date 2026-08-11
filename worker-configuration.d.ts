interface Env {
  OAUTH_KV: KVNamespace;
  TOKEN_STORE: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  WORKER_URL?: string;
  HOSTED_DOMAIN?: string;
}
