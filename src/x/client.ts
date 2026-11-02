import { oauth1Header, accountIdFromToken, type OAuth1Credentials } from './oauth1.ts';

/**
 * Read-only clients for the X API v2: one with the app bearer token, one with the account's own OAuth 1.0a tokens
 * (app set to "Read only") for its mentions. Nothing in here can write to X: every request is a GET.
 */

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
  author_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
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
  /** One post by id, for a link pasted in the bot. Undefined if X does not return it. */
  lookupPost(postId: string): Promise<XPost | undefined>;
};

/** The account's own read-only tokens: its mentions, at the "Owned Reads" price. */
export type XUserClient = {
  /** Numeric id of the account the tokens belong to. */
  readonly accountId: string;
  mentions(options: {
    sinceId?: string;
    startTime?: Date;
    maxResults: number;
    paginationToken?: string;
  }): Promise<{ posts: XPost[]; referenced: XPost[]; newestId?: string; nextToken?: string }>;
};

type XErrorBody = { title?: string; detail?: string; errors?: Array<{ message?: string; detail?: string }> };

function describe(status: number, body: XErrorBody, tokens: string): string {
  const detail = body.detail ?? body.errors?.map((e) => e.message ?? e.detail).join(' ; ') ?? body.title ?? '';
  if (status === 401) return `X refuses the token (401): check ${tokens} in .env. ${detail}`.trim();
  if (status === 402) return `X refuses the request for lack of credits (402). ${detail}`.trim();
  if (status === 403) return `X refuses access (403). ${detail}`.trim();
  if (status === 429) return 'X rate limit reached (429).';
  return `X error ${status}. ${detail}`.trim();
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type Requester = {
  get<T>(path: string, params: Record<string, string>): Promise<T>;
  /** A GET that asks for post fields, under whichever parameter name X accepts. */
  getPosts<T>(path: string, params: Record<string, string>, fields: string): Promise<T>;
};

function createRequester(options: {
  authorize: (url: string) => string;
  tokens: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}): Requester {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://api.x.com';
  let fieldsParam: (typeof POST_FIELDS_PARAMS)[number] = POST_FIELDS_PARAMS[0];

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${baseUrl}${path}?${new URLSearchParams(params)}`;
    const response = await doFetch(url, {
      headers: { Authorization: options.authorize(url) },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as T & XErrorBody;
    if (!response.ok) {
      const reset = response.headers.get('x-rate-limit-reset');
      throw new XApiError(
        response.status,
        describe(response.status, body, options.tokens),
        reset ? new Date(Number(reset) * 1000) : undefined,
      );
    }
    return body;
  }

  return {
    get,
    async getPosts<T>(path: string, params: Record<string, string>, fields: string): Promise<T> {
      const request = () => get<T>(path, { ...params, [fieldsParam]: fields });
      try {
        return await request();
      } catch (error) {
        if (!(error instanceof XApiError) || error.status !== 400 || !/fields/i.test(error.message)) throw error;
        fieldsParam = POST_FIELDS_PARAMS.find((p) => p !== fieldsParam)!;
        return request();
      }
    },
  };
}

export function createXClient(options: {
  bearerToken: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}): XClient {
  const api = createRequester({ ...options, authorize: () => `Bearer ${options.bearerToken}`, tokens: 'X_BEARER_TOKEN' });

  return {
    async lookupUsers(usernames) {
      const users: XUser[] = [];
      const notFound: string[] = [];
      for (let i = 0; i < usernames.length; i += 100) {
        const batch = usernames.slice(i, i + 100);
        const body = await api.get<{ data?: XUser[]; errors?: Array<{ value?: string }> }>('/2/users/by', {
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
      else if (startTime) params.start_time = isoSeconds(startTime);
      const path = `/2/users/${encodeURIComponent(userId)}/tweets`;
      const body = await api.getPosts<{ data?: XPost[]; meta?: { newest_id?: string } }>(
        path,
        params,
        'created_at,public_metrics',
      );
      const posts = body.data ?? [];
      return { posts, ...(body.meta?.newest_id ? { newestId: body.meta.newest_id } : {}) };
    },

    async lookupPost(postId) {
      const body = await api.getPosts<{ data?: XPost }>(
        `/2/tweets/${encodeURIComponent(postId)}`,
        {},
        'created_at,public_metrics,author_id',
      );
      return body.data;
    },
  };
}

/**
 * Client signed with the account's OAuth 1.0a tokens. They must be generated after the app was set to "Read only":
 * a token keeps the access level the app had when it was generated.
 */
export function createXUserClient(options: {
  credentials: OAuth1Credentials;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}): XUserClient {
  const accountId = accountIdFromToken(options.credentials.token);
  if (!accountId) throw new Error('X_ACCESS_TOKEN does not have the expected form (<account id>-<token>).');
  const api = createRequester({
    ...options,
    authorize: (url) => oauth1Header('GET', url, options.credentials),
    tokens: 'X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET',
  });

  return {
    accountId,
    async mentions({ sinceId, startTime, maxResults, paginationToken }) {
      const params: Record<string, string> = {
        max_results: String(Math.min(100, Math.max(5, maxResults))),
        expansions: 'referenced_tweets.id',
      };
      if (sinceId) params.since_id = sinceId;
      else if (startTime) params.start_time = isoSeconds(startTime);
      if (paginationToken) params.pagination_token = paginationToken;
      type Body = { data?: XPost[]; includes?: { tweets?: XPost[] }; meta?: { newest_id?: string; next_token?: string } };
      const body = await api.getPosts<Body>(
        `/2/users/${encodeURIComponent(accountId)}/mentions`,
        params,
        'created_at,author_id,referenced_tweets',
      );
      return {
        posts: body.data ?? [],
        referenced: body.includes?.tweets ?? [],
        ...(body.meta?.newest_id ? { newestId: body.meta.newest_id } : {}),
        ...(body.meta?.next_token ? { nextToken: body.meta.next_token } : {}),
      };
    },
  };
}
