/**
 * Environment variables read from .env at runtime. Keep this list in sync with .env.example.
 */
export const SECRET_NAMES = [
  'MISTRAL_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_ID',
  'X_BEARER_TOKEN',
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export class MissingSecretError extends Error {
  override name = 'MissingSecretError';
}

/**
 * Returns the requested variables, or throws naming every missing one. Values never appear in errors.
 */
export function requireSecrets<const N extends SecretName>(
  names: readonly N[],
  env: NodeJS.ProcessEnv = process.env,
): Record<N, string> {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new MissingSecretError(`Variables absentes de .env : ${missing.join(', ')}`);
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()])) as Record<N, string>;
}
