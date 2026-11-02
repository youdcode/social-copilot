import { createHmac, randomBytes } from 'node:crypto';

/** The account's own OAuth 1.0a keys, generated after the app was set to "Read only": they cannot write. */
export type OAuth1Credentials = {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
};

/** RFC 3986 percent-encoding, as OAuth 1.0a requires: encodeURIComponent leaves !'()* alone. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function byKeyThenValue([ak, av]: [string, string], [bk, bv]: [string, string]): number {
  if (ak !== bk) return ak < bk ? -1 : 1;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * The signature base string: method, URL without query, and every parameter (query, form body, oauth_*),
 * encoded then sorted.
 */
export function signatureBaseString(method: string, url: string, params: ReadonlyArray<[string, string]>): string {
  const parsed = new URL(url);
  const all: Array<[string, string]> = [...parsed.searchParams.entries(), ...params];
  const encoded = all.map(([k, v]): [string, string] => [percentEncode(k), percentEncode(v)]).sort(byKeyThenValue);
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase();
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
}

/**
 * The Authorization header of a request signed with HMAC-SHA1. bodyParams are form fields, if any;
 * nonce and timestamp are fixed only in tests.
 */
export function oauth1Header(
  method: string,
  url: string,
  credentials: OAuth1Credentials,
  options: { bodyParams?: Record<string, string>; nonce?: string; timestamp?: number } = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.token,
    oauth_version: '1.0',
  };
  const base = signatureBaseString(method, url, [...Object.entries(options.bodyParams ?? {}), ...Object.entries(oauth)]);
  const key = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth)
    .sort(byKeyThenValue)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ')}`;
}

/** X access tokens start with the numeric id of the account they belong to: "<user id>-<secret part>". */
export function accountIdFromToken(token: string): string | undefined {
  return /^(\d+)-/.exec(token)?.[1];
}
