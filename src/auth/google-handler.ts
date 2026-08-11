import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { saveAccount } from "../storage/kv.js";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  WORKSPACE_SCOPES,
  type Props,
} from "./utils.js";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils.js";

type AppEnv = {
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
};

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Multigmail</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
  <h1>Multigmail</h1>
  <p>Multi-account Google Workspace MCP connector for Claude (Gmail, Calendar, Drive).</p>
  <p>MCP endpoint: <code>/mcp</code></p>
  <p>Add it in Claude → Settings → Connectors → Add custom connector.</p>
</body></html>`),
);

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) return c.text("Invalid request", 400);

  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToGoogle(c.req.raw, c.env, stateToken, {
      "Set-Cookie": sessionBindingCookie,
    });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();
  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "Connect multiple Google accounts so Claude can use Gmail, Calendar, and Drive across all of them.",
      name: "Multigmail",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );
    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToGoogle(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    const message = error instanceof Error ? error.message : String(error);
    return c.text(`Internal server error: ${message}`, 500);
  }
});

function redirectToGoogle(
  request: Request,
  env: Env,
  stateToken: string,
  headers: Record<string, string> = {},
) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        hostedDomain: env.HOSTED_DOMAIN,
        redirectUri: new URL("/callback", request.url).href,
        scope: WORKSPACE_SCOPES,
        state: stateToken,
        upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
    },
  });
}

app.get("/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state) return c.text("Missing state parameter", 400);
  if (!code) return c.text("Missing code parameter", 400);

  const addAccountDataJson = await c.env.OAUTH_KV.get(`add-account:state:${state}`);
  if (addAccountDataJson) {
    await c.env.OAUTH_KV.delete(`add-account:state:${state}`);
    return handleAddAccountCallback(c, code, JSON.parse(addAccountDataJson) as {
      userId: string;
      alias: string;
    });
  }

  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;
  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

  const [tokenResponse, googleErrResponse] = await fetchUpstreamAuthToken({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    code,
    grantType: "authorization_code",
    redirectUri: new URL("/callback", c.req.url).href,
    upstreamUrl: "https://accounts.google.com/o/oauth2/token",
  });
  if (googleErrResponse) return googleErrResponse;

  const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
  });
  if (!userResponse.ok) {
    return c.text(`Failed to fetch user info: ${await userResponse.text()}`, 500);
  }

  const user = (await userResponse.json()) as { id: string; name?: string; email: string };
  const alias = deriveAlias(user.email);

  if (tokenResponse.refresh_token) {
    await saveAccount(c.env.TOKEN_STORE, c.env.COOKIE_ENCRYPTION_KEY, user.id, {
      alias,
      email: user.email,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expiry_date: Date.now() + tokenResponse.expires_in * 1000,
      scopes: (tokenResponse.scope ?? WORKSPACE_SCOPES).split(/\s+/).filter(Boolean),
    });
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: user.name ?? user.email },
    props: { email: user.email, userId: user.id, name: user.name } as Props,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: user.id,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
  return new Response(null, { status: 302, headers });
});

async function handleAddAccountCallback(
  c: { env: Env; req: { url: string }; text: (body: string, status?: number) => Response },
  code: string,
  stateData: { userId: string; alias: string },
) {
  const [tokenResponse, googleErrResponse] = await fetchUpstreamAuthToken({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    code,
    grantType: "authorization_code",
    redirectUri: new URL("/callback", c.req.url).href,
    upstreamUrl: "https://accounts.google.com/o/oauth2/token",
  });
  if (googleErrResponse) return googleErrResponse;

  const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
  });
  if (!userResponse.ok) {
    return c.text(`Failed to fetch user info: ${await userResponse.text()}`, 500);
  }

  const { email } = (await userResponse.json()) as { email: string };
  const alias = sanitizeAlias(stateData.alias);

  if (!tokenResponse.refresh_token) {
    return new Response(
      renderResultPage(
        "Error",
        `Google did not return a refresh token for ${email}. Revoke app access at myaccount.google.com/permissions and try again.`,
        false,
      ),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  await saveAccount(c.env.TOKEN_STORE, c.env.COOKIE_ENCRYPTION_KEY, stateData.userId, {
    alias,
    email,
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expiry_date: Date.now() + tokenResponse.expires_in * 1000,
    scopes: (tokenResponse.scope ?? WORKSPACE_SCOPES).split(/\s+/).filter(Boolean),
  });

  return new Response(
    renderResultPage(
      "Account Added",
      `Linked ${email} as alias "${alias}". You can close this tab and return to Claude.`,
      true,
    ),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function deriveAlias(email: string): string {
  const local = email.split("@")[0] ?? "account";
  return sanitizeAlias(local);
}

export function sanitizeAlias(alias: string): string {
  const cleaned = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "all") {
    throw new Error('Alias must be non-empty and cannot be "all".');
  }
  return cleaned.slice(0, 64);
}

function renderResultPage(title: string, message: string, success: boolean): string {
  const color = success ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>${title}</title></head>
<body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f8fafc;margin:0">
  <div style="background:#fff;border-radius:12px;padding:2rem;max-width:28rem;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center">
    <h1 style="color:${color};margin:0 0 .5rem;font-size:1.4rem">${title}</h1>
    <p style="color:#475569;line-height:1.6;margin:0">${message}</p>
  </div>
</body></html>`;
}

export { app as GoogleHandler };
