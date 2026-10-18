import { networkInterfaces } from 'node:os';

// This opt-in entry point is never imported by production servers.
const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const peers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Opt-in only (npm run dev:preview:phone): the preview also answers other devices on the same
// private network, for trying the pages on a phone. It signs every visitor in without a password,
// so use it only on a network you trust. Public addresses and proxied requests are always refused.
export const lanPreview = (env = process.env) => env.PREVIEW_LAN === '1';
export const privatePeer = (address) =>
  /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address || '');
export const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

export function assertLocalPreview(env, argv = process.argv) {
  if (
    env.NODE_ENV !== 'development' ||
    env.K_SERVICE ||
    env.CLOUD_RUN_JOB ||
    env.K_REVISION ||
    argv.includes('--production') ||
    (env.HOST && !hosts.has(env.HOST))
  ) {
    throw new Error(
      'Local preview requires development mode and a loopback host; production/cloud runs are forbidden.',
    );
  }
}

export function localPreviewRequest(req) {
  const lan = lanPreview();
  if (!peers.has(req.socket.remoteAddress) && !(lan && privatePeer(req.socket.remoteAddress)))
    return false;
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'])
    return false;
  try {
    const target = new URL(`http://${req.headers.host}`);
    if (!hosts.has(target.hostname) && !(lan && lanAddresses().includes(target.hostname)))
      return false;
    for (const key of ['origin', 'referer']) {
      if (req.headers[key] && new URL(req.headers[key]).origin !== target.origin) return false;
    }
    return true;
  } catch {
    return false;
  }
}
