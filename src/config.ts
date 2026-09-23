import { GlpiConfig } from './glpi-client.js';

export function envInt(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function parseGlpiConfig(env: NodeJS.ProcessEnv = process.env): GlpiConfig {
  const url = env.GLPI_URL;
  if (!url) throw new Error('GLPI_URL environment variable is required');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`GLPI_URL is not a valid URL: "${url}"`);
  }

  if (parsedUrl.protocol !== 'https:') {
    const allowInsecure =
      env.GLPI_ALLOW_HTTP === 'true' || env.GLPI_ALLOW_INSECURE_HTTP === 'true';
    if (!allowInsecure) {
      throw new Error(
        `Insecure protocol "${parsedUrl.protocol}" rejected for GLPI_URL. ` +
        'HTTPS is required to protect credentials and API tokens. ' +
        'Set GLPI_ALLOW_HTTP=true to bypass this check for local development only.'
      );
    }
    console.error(
      'SECURITY WARNING: GLPI_URL uses unencrypted HTTP. API tokens and credentials will be sent in plaintext.'
    );
  }

  const userToken = env.GLPI_USER_TOKEN;
  const username = env.GLPI_USERNAME;
  const password = env.GLPI_PASSWORD;
  if (!userToken && !(username && password)) {
    throw new Error(
      'No authentication configured. Set GLPI_USER_TOKEN, or GLPI_USERNAME + GLPI_PASSWORD.'
    );
  }

  return {
    url,
    appToken: env.GLPI_APP_TOKEN,
    userToken,
    username,
    password,
    timeoutMs: envInt(env.GLPI_TIMEOUT_MS, 'GLPI_TIMEOUT_MS'),
    maxRetries: envInt(env.GLPI_MAX_RETRIES, 'GLPI_MAX_RETRIES'),
  };
}
