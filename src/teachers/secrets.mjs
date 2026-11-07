// The only place that reads a key. The key comes from the one environment variable FORGE_LLM_API_KEY and nowhere else (not ANTHROPIC_API_KEY, not ANTHROPIC_AUTH_TOKEN,
// not a login profile, and the address to send to is not taken from ANTHROPIC_BASE_URL: it is in the settings); they are not settings, not arguments, not part of any file this program writes.
// Everything that is written out (logs, errors, the ledger, the records) goes through `redact`, which replaces the value of every key-like environment variable by ***.
const NAME = 'FORGE_LLM_API_KEY';
const KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

export function readApiKey(env = process.env) {
  return typeof env[NAME] === 'string' && env[NAME].length > 0 ? env[NAME] : null;
}

export const hasApiKey = (env = process.env) => readApiKey(env) !== null;

// the values to hide: every key-like variable of the environment that is long enough not to match by accident
function values(env) {
  return Object.entries(env).filter(([name, value]) => KEY_NAME.test(name) && typeof value === 'string' && value.length >= 12).map(([, value]) => value);
}

export function redact(text, env = process.env) {
  let out = String(text);
  for (const value of values(env)) out = out.split(value).join('***');
  return out.replace(/sk-[A-Za-z0-9_-]{20,}/g, '***');
}
