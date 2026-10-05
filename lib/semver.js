'use strict';

// Ordering for pub versions: 1.2.3, 1.2.3-dev.1 (before 1.2.3), 1.2.3+4
// (after 1.2.3). Enough to say "a newer release exists" — not a constraint
// solver; pub already did that work and wrote the answer to pubspec.lock.

function parse(v) {
  const [core, build = ''] = String(v).split('+');
  const dash = core.indexOf('-');
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? '' : core.slice(dash + 1);
  const nums = main.split('.').map((n) => parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre, build };
}

function compareIds(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (na !== null && nb !== null) { if (na !== nb) return na < nb ? -1 : 1; continue; }
    if (na !== null) return -1;
    if (nb !== null) return 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** <0 when a is older than b, 0 when equal, >0 when newer. */
function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre !== y.pre) {
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return compareIds(x.pre, y.pre);
  }
  if (x.build !== y.build) {
    if (!x.build) return -1;
    if (!y.build) return 1;
    return compareIds(x.build, y.build);
  }
  return 0;
}

module.exports = { compareVersions };
