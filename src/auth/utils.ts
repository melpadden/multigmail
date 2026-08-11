export type Props = {
  userId: string;
  email: string;
  name?: string;
};

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

export function getUpstreamAuthorizeUrl(opts: {
  upstreamUrl: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  state?: string;
  hostedDomain?: string;
  loginHint?: string;
}): string {
  const upstream = new URL(opts.upstreamUrl);
  upstream.searchParams.set("client_id", opts.clientId);
  upstream.searchParams.set("redirect_uri", opts.redirectUri);
  upstream.searchParams.set("scope", opts.scope);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("access_type", "offline");
  upstream.searchParams.set("prompt", "consent");
  if (opts.state) upstream.searchParams.set("state", opts.state);
  if (opts.hostedDomain) upstream.searchParams.set("hd", opts.hostedDomain);
  if (opts.loginHint) upstream.searchParams.set("login_hint", opts.loginHint);
  return upstream.href;
}

export async function fetchUpstreamAuthToken(opts: {
  code: string | undefined;
  upstreamUrl: string;
  clientSecret: string;
  redirectUri: string;
  clientId: string;
  grantType: string;
}): Promise<[GoogleTokenResponse, null] | [null, Response]> {
  if (!opts.code) {
    return [null, new Response("Missing code", { status: 400 })];
  }

  const resp = await fetch(opts.upstreamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      grant_type: opts.grantType,
      redirect_uri: opts.redirectUri,
    }).toString(),
  });

  if (!resp.ok) {
    console.error("Google token exchange failed:", await resp.text());
    return [null, new Response("Failed to fetch access token", { status: 500 })];
  }

  const body = (await resp.json()) as GoogleTokenResponse;
  if (!body.access_token) {
    return [null, new Response("Missing access token in response", { status: 400 })];
  }
  return [body, null];
}

export function textResult(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return textResult(`Error: ${message}`);
}

export function truncateText(text: string, maxChars = 120_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… truncated (${text.length} chars total)`;
}
