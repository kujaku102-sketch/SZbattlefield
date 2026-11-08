// The only place that reads a key. A key comes from one environment variable of its provider and nowhere else; it is not a setting, not an argument, not part of any file
// this program writes. Everything that is written out (logs, errors, the ledger, the records) goes through `redact`, which replaces the value of every key-like
// environment variable by ***.
//
//   anthropic  FORGE_ANTHROPIC_API_KEY
//   gemini     GEMINI_API_KEY
//
// ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are never read (Claude Code itself reads those names), and neither is ANTHROPIC_BASE_URL: the address to send to is in the settings.
// A settings file may say `keyEnv` to make the name explicit; it must be the provider's own name, nothing else is accepted.
export const KEY_ENV = Object.freeze({ anthropic: 'FORGE_ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' });
const KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

export function keyEnvOf(provider, wanted = undefined) {
  const name = KEY_ENV[provider];
  if (!name) throw new Error(`provider ${provider}? one of ${Object.keys(KEY_ENV).join(', ')}`);
  if (wanted !== undefined && wanted !== name) throw new Error(`keyEnv ${wanted}? the provider ${provider} reads ${name} only`);
  return name;
}

export function readApiKey(env = process.env, provider = 'anthropic') {
  const value = env[keyEnvOf(provider)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const hasApiKey = (env = process.env, provider = 'anthropic') => readApiKey(env, provider) !== null;

// the values to hide: every key-like variable of the environment that is long enough not to match by accident
function values(env) {
  return Object.entries(env).filter(([name, value]) => KEY_NAME.test(name) && typeof value === 'string' && value.length >= 12).map(([, value]) => value);
}

export function redact(text, env = process.env) {
  let out = String(text);
  for (const value of values(env)) out = out.split(value).join('***');
  return out.replace(/sk-[A-Za-z0-9_-]{20,}/g, '***').replace(/AIza[0-9A-Za-z_-]{20,}/g, '***');
}
