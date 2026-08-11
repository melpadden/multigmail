import { getValidAccessToken } from "./auth.js";
import { resolveAccountAlias, type StoredAccount } from "../storage/kv.js";

export type FanoutResult<T> = {
  account: string;
  email: string;
  ok: boolean;
  data?: T;
  error?: string;
};

export async function withAccounts<T>(
  env: Env,
  userId: string,
  accountOrAll: string,
  fn: (token: string, account: StoredAccount) => Promise<T>,
): Promise<FanoutResult<T>[]> {
  const accounts = await resolveAccountAlias(
    env.TOKEN_STORE,
    env.COOKIE_ENCRYPTION_KEY,
    userId,
    accountOrAll,
  );

  return Promise.all(
    accounts.map(async (account) => {
      try {
        const { token } = await getValidAccessToken(env, userId, account.alias);
        const data = await fn(token, account);
        return {
          account: account.alias,
          email: account.email,
          ok: true,
          data,
        } satisfies FanoutResult<T>;
      } catch (err) {
        return {
          account: account.alias,
          email: account.email,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies FanoutResult<T>;
      }
    }),
  );
}

export async function withSingleAccount<T>(
  env: Env,
  userId: string,
  account: string,
  fn: (token: string, account: StoredAccount) => Promise<T>,
): Promise<T> {
  if (account === "all") {
    throw new Error('Write operations require a specific account alias, not "all".');
  }
  const accounts = await resolveAccountAlias(
    env.TOKEN_STORE,
    env.COOKIE_ENCRYPTION_KEY,
    userId,
    account,
  );
  const target = accounts[0]!;
  const { token } = await getValidAccessToken(env, userId, target.alias);
  return fn(token, target);
}
