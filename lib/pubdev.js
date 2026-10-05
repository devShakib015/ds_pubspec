'use strict';

// pub.dev answers 429 after a short burst, and a pubspec with forty
// dependencies is exactly that burst. So: a small worker pool, a cache that
// outlives the window (hours, not minutes), and a polite retry on 429.

const API = 'https://pub.dev/api/packages/';

/**
 * @typedef {{
 *   name: string,
 *   latest: string|null,
 *   isDiscontinued: boolean,
 *   replacedBy: string|null,
 *   retracted: string[],
 *   published: string|null,   // when the latest version came out
 * }} PackageInfo
 *
 * @typedef {{
 *   grantedPoints: number|null,
 *   maxPoints: number|null,
 *   likes: number|null,
 *   downloads30d: number|null,
 *   tags: string[],
 * }} ScoreInfo
 *
 * @typedef {{ get(key: string): any, set(key: string, value: any): any }} Store
 */

function toPackageInfo(name, json) {
  const versions = Array.isArray(json.versions) ? json.versions : [];
  const latest = json.latest || {};
  return {
    name,
    latest: latest.version || null,
    isDiscontinued: json.isDiscontinued === true,
    replacedBy: json.replacedBy || null,
    retracted: versions.filter((v) => v.retracted === true).map((v) => v.version),
    published: latest.published || null,
  };
}

function toScoreInfo(json) {
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    grantedPoints: num(json.grantedPoints),
    maxPoints: num(json.maxPoints),
    likes: num(json.likeCount),
    downloads30d: num(json.downloadCount30Days),
    tags: Array.isArray(json.tags) ? json.tags : [],
  };
}

/**
 * @param {{
 *   fetch?: typeof fetch,
 *   store?: Store,
 *   ttlMs?: number,
 *   now?: () => number,
 *   concurrency?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   userAgent?: string,
 * }} options
 */
function createPubDevClient(options = {}) {
  const doFetch = options.fetch || globalThis.fetch;
  const store = options.store || new Map();
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const userAgent = options.userAgent || 'ds-pubspec (+https://github.com/devShakib015/ds_pubspec)';
  let active = 0;
  const waiting = [];
  const inFlight = new Map();

  const acquire = () => new Promise((resolve) => {
    if (active < (options.concurrency || 4)) { active++; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };

  async function getJson(url) {
    await acquire();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent } });
        if (res.status === 404) return null;
        if (res.status === 429 || res.status >= 500) {
          const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`pub.dev answered ${res.status} for ${url}`);
        return await res.json();
      }
      throw new Error(`pub.dev kept refusing ${url}`);
    } finally {
      release();
    }
  }

  /** Cached by key for ttlMs; concurrent callers share one request. */
  async function cached(key, url, map) {
    const hit = store.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const json = await getJson(url);
        const value = json ? map(json) : null;
        await store.set(key, { at: now(), value });
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  return {
    /** @returns {Promise<PackageInfo|null>} null when pub.dev has no such package */
    packageInfo: (name) => cached(`pkg:${name}`, API + encodeURIComponent(name), (j) => toPackageInfo(name, j)),
    /** @returns {Promise<ScoreInfo|null>} */
    scoreInfo: (name) => cached(`score:${name}`, `${API}${encodeURIComponent(name)}/score`, toScoreInfo),
  };
}

module.exports = { createPubDevClient, toPackageInfo, toScoreInfo };
