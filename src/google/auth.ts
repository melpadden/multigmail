import {
  getAccount,
  saveAccount,
  type StoredAccount,
} from "../storage/kv.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const EXPIRY_BUFFER_MS = 60_000;

interface RefreshResult {
  access_token: string;
  expires_in: number;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<RefreshResult> {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${body}`);
  }

  return (await resp.json()) as RefreshResult;
}

export async function getValidAccessToken(
  env: Env,
  userId: string,
  alias: string,
): Promise<{ token: string; account: StoredAccount }> {
  const account = await getAccount(env.TOKEN_STORE, env.COOKIE_ENCRYPTION_KEY, userId, alias);
  if (!account) {
    throw new Error(`Account "${alias}" not found. Use list_accounts / add_account.`);
  }

  if (Date.now() < account.expiry_date - EXPIRY_BUFFER_MS) {
    return { token: account.access_token, account };
  }

  try {
    const refreshed = await refreshAccessToken(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      account.refresh_token,
    );
    const updated: StoredAccount = {
      ...account,
      access_token: refreshed.access_token,
      expiry_date: Date.now() + refreshed.expires_in * 1000,
    };
    await saveAccount(env.TOKEN_STORE, env.COOKIE_ENCRYPTION_KEY, userId, updated);
    return { token: updated.access_token, account: updated };
  } catch {
    const retry = await getAccount(env.TOKEN_STORE, env.COOKIE_ENCRYPTION_KEY, userId, alias);
    if (retry && Date.now() < retry.expiry_date - EXPIRY_BUFFER_MS) {
      return { token: retry.access_token, account: retry };
    }
    throw new Error(
      `Token expired and refresh failed for "${alias}". Re-authenticate with add_account.`,
    );
  }
}

export async function googleFetch(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  return resp;
}

export async function googleJson<T>(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const resp = await googleFetch(token, url, options);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Google API error (${resp.status}) ${url}: ${body}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}
