import { decrypt, encrypt } from "./crypto.js";

export interface StoredAccount {
  alias: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scopes: string[];
}

function accountKey(userId: string, alias: string): string {
  return `account:${userId}:${alias}`;
}

export async function saveAccount(
  kv: KVNamespace,
  secret: string,
  userId: string,
  account: StoredAccount,
): Promise<void> {
  const encrypted = await encrypt(JSON.stringify(account), secret);
  await kv.put(accountKey(userId, account.alias), encrypted);
}

export async function getAccount(
  kv: KVNamespace,
  secret: string,
  userId: string,
  alias: string,
): Promise<StoredAccount | null> {
  const encrypted = await kv.get(accountKey(userId, alias));
  if (!encrypted) return null;
  return JSON.parse(await decrypt(encrypted, secret)) as StoredAccount;
}

export async function listAccounts(
  kv: KVNamespace,
  secret: string,
  userId: string,
): Promise<StoredAccount[]> {
  const prefix = `account:${userId}:`;
  const listed = await kv.list({ prefix });
  const accounts: StoredAccount[] = [];
  for (const key of listed.keys) {
    const encrypted = await kv.get(key.name);
    if (!encrypted) continue;
    try {
      accounts.push(JSON.parse(await decrypt(encrypted, secret)) as StoredAccount);
    } catch {
      // skip corrupt entries
    }
  }
  return accounts.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function deleteAccount(
  kv: KVNamespace,
  userId: string,
  alias: string,
): Promise<boolean> {
  const key = accountKey(userId, alias);
  const existing = await kv.get(key);
  if (!existing) return false;
  await kv.delete(key);
  return true;
}

export async function resolveAccountAlias(
  kv: KVNamespace,
  secret: string,
  userId: string,
  accountOrAll: string,
): Promise<StoredAccount[]> {
  if (accountOrAll === "all") {
    const accounts = await listAccounts(kv, secret, userId);
    if (accounts.length === 0) {
      throw new Error("No accounts linked. Use add_account first.");
    }
    return accounts;
  }

  const byAlias = await getAccount(kv, secret, userId, accountOrAll);
  if (byAlias) return [byAlias];

  // Allow targeting by email as a convenience
  const accounts = await listAccounts(kv, secret, userId);
  const byEmail = accounts.find(
    (a) => a.email.toLowerCase() === accountOrAll.toLowerCase(),
  );
  if (byEmail) return [byEmail];

  throw new Error(
    `Account "${accountOrAll}" not found. Use list_accounts to see linked aliases.`,
  );
}
