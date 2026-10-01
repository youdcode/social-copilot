/** Read-only client for the X API v2, with the app bearer token. Nothing in here can write to X. */

export type XPublicMetrics = {
  like_count?: number;
  repost_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
};

export type XPost = {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: XPublicMetrics;
};

export type XUser = {
  id: string;
  username: string;
  name: string;
  description?: string;
  verified?: boolean;
  verified_type?: string;
  url?: string;
  public_metrics?: { followers_count?: number };
};

export class XApiError extends Error {
  override name = 'XApiError';
  readonly status: number;
  /** For 429: when the rate limit window resets. */
  readonly resetAt: Date | undefined;
  constructor(status: number, message: string, resetAt?: Date) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
  }
}

/**
 * The guides name the parameter tweet.fields; the OpenAPI spec (2.169) says post.fields. The client starts with the
 * first and switches for good if X rejects it (a refused request is not billed).
 */
export const POST_FIELDS_PARAMS = ['tweet.fields', 'post.fields'] as const;

export type XClient = {
  lookupUsers(usernames: readonly string[]): Promise<{ users: XUser[]; notFound: string[] }>;
  userPosts(
    userId: string,
    options: { sinceId?: string; startTime?: Date; maxResults: number; exclude: readonly string[] },
  ): Promise<{ posts: XPost[]; newestId?: string }>;
};

type XErrorBody = { title?: string; detail?: string; errors?: Array<{ message?: string; detail?: string }> };

function describe(status: number, body: XErrorBody): string {
  const detail = body.detail ?? body.errors?.map((e) => e.message ?? e.detail).join(' ; ') ?? body.title ?? '';
  if (status === 401) return `X refuse le jeton (401) : vérifie X_BEARER_TOKEN dans .env. ${detail}`.trim();
  if (status === 402) return `X refuse la requête faute de crédits (402). ${detail}`.trim();
  if (status === 403) return `X refuse l'accès (403). ${detail}`.trim();
  if (status === 429) return 'Limite de débit X atteinte (429).';
  return `Erreur X ${status}. ${detail}`.trim();
}

export function createXClient(options: {
  bearerToken: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}): XClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://api.x.com';
  let fieldsParam: (typeof POST_FIELDS_PARAMS)[number] = POST_FIELDS_PARAMS[0];

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${baseUrl}${path}?${new URLSearchParams(params)}`;
    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${options.bearerToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as T & XErrorBody;
    if (!response.ok) {
      const reset = response.headers.get('x-rate-limit-reset');
      throw new XApiError(response.status, describe(response.status, body), reset ? new Date(Number(reset) * 1000) : undefined);
    }
    return body;
  }

  return {
    async lookupUsers(usernames) {
      const users: XUser[] = [];
      const notFound: string[] = [];
      for (let i = 0; i < usernames.length; i += 100) {
        const batch = usernames.slice(i, i + 100);
        const body = await get<{ data?: XUser[]; errors?: Array<{ value?: string }> }>('/2/users/by', {
          usernames: batch.join(','),
          'user.fields': 'name,description,verified,verified_type,url,public_metrics',
        });
        users.push(...(body.data ?? []));
        notFound.push(...(body.errors ?? []).map((e) => e.value).filter((v): v is string => Boolean(v)));
      }
      return { users, notFound };
    },

    async userPosts(userId, { sinceId, startTime, maxResults, exclude }) {
      const params: Record<string, string> = {
        max_results: String(Math.min(100, Math.max(5, maxResults))),
      };
      if (exclude.length > 0) params.exclude = exclude.join(',');
      if (sinceId) params.since_id = sinceId;
      else if (startTime) params.start_time = startTime.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const path = `/2/users/${encodeURIComponent(userId)}/tweets`;
      type Body = { data?: XPost[]; meta?: { newest_id?: string } };
      const request = () => get<Body>(path, { ...params, [fieldsParam]: 'created_at,public_metrics' });
      let body: Body;
      try {
        body = await request();
      } catch (error) {
        const other = POST_FIELDS_PARAMS.find((p) => p !== fieldsParam)!;
        if (!(error instanceof XApiError) || error.status !== 400 || !/fields/i.test(error.message)) throw error;
        fieldsParam = other;
        body = await request();
      }
      const posts = body.data ?? [];
      return { posts, ...(body.meta?.newest_id ? { newestId: body.meta.newest_id } : {}) };
    },
  };
}
