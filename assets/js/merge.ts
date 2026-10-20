export interface Chunk {
  base: string;
  mine: string;
  theirs: string;
  conflict: boolean;
}
export type Choice = "mine" | "theirs" | "both" | "neither";
const lines = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function matches(a: string[], b: string[]): [number, number][] {
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const aa = a.slice(prefix, a.length - suffix),
    bb = b.slice(prefix, b.length - suffix);
  const matched: [number, number][] = Array.from({ length: prefix }, (_, i) => [
    i,
    i,
  ]);
  const v = new Map<number, number>([[1, 0]]),
    trace: Map<number, number>[] = [];
  let distance = -1;
  outer: for (let d = 0; d <= Math.min(aa.length + bb.length, 2000); d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
          ? (v.get(k + 1) ?? 0)
          : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < aa.length && y < bb.length && aa[x] === bb[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= aa.length && y >= bb.length) {
        distance = d;
        break outer;
      }
    }
  }
  if (distance >= 0) {
    const middle: [number, number][] = [];
    let x = aa.length,
      y = bb.length;
    for (let d = distance; d >= 0; d--) {
      const previous = trace[d],
        k = x - y;
      const pk =
        k === -d ||
        (k !== d && (previous.get(k - 1) ?? 0) < (previous.get(k + 1) ?? 0))
          ? k + 1
          : k - 1;
      const px = d === 0 ? 0 : (previous.get(pk) ?? 0),
        py = px - pk;
      while (x > px && y > py) {
        x--;
        y--;
        middle.push([x + prefix, y + prefix]);
      }
      x = px;
      y = py;
    }
    matched.push(...middle.reverse());
  }
  for (let i = 0; i < suffix; i++)
    matched.push([a.length - suffix + i, b.length - suffix + i]);
  return matched;
}

export function merge(
  base: string | null,
  mine: string,
  theirs: string,
): Chunk[] {
  if (mine === theirs) return [{ base: mine, mine, theirs, conflict: false }];
  const a = lines(mine),
    b = lines(theirs);
  const original =
    base === null ? matches(a, b).map(([i]) => a[i]) : lines(base);
  const ma = new Map(matches(original, a)),
    mb = new Map(matches(original, b));
  const result: Chunk[] = [];
  let o = 0,
    i = 0,
    j = 0;
  const add = (old: string[], local: string[], remote: string[]) => {
    const common = old.join(""),
      l = local.join(""),
      r = remote.join("");
    if (!common && !l && !r) return;
    const resolved =
      l === r
        ? l
        : base !== null && l === common
          ? r
          : base !== null && r === common
            ? l
            : null;
    result.push({
      base: common,
      mine: resolved ?? l,
      theirs: resolved ?? r,
      conflict: resolved === null,
    });
  };
  while (o < original.length || i < a.length || j < b.length) {
    let n = 0;
    while (
      o + n < original.length &&
      ma.get(o + n) === i + n &&
      mb.get(o + n) === j + n
    )
      n++;
    if (n) {
      add(original.slice(o, o + n), a.slice(i, i + n), b.slice(j, j + n));
      o += n;
      i += n;
      j += n;
      continue;
    }
    let next = o;
    while (next < original.length && (!ma.has(next) || !mb.has(next))) next++;
    if (next === original.length) {
      add(original.slice(o), a.slice(i), b.slice(j));
      break;
    }
    const ni = ma.get(next)!,
      nj = mb.get(next)!;
    add(original.slice(o, next), a.slice(i, ni), b.slice(j, nj));
    o = next;
    i = ni;
    j = nj;
  }
  return result;
}
export function renderMerge(chunks: Chunk[], choices: Choice[]): string {
  let index = 0;
  return chunks
    .map((c) => {
      if (!c.conflict) return c.mine;
      const choice = choices[index++];
      if (!choice) throw new Error("Resolve every conflicting change first.");
      if (choice === "mine") return c.mine;
      if (choice === "theirs") return c.theirs;
      if (choice === "neither") return "";
      return c.mine + (c.mine && !c.mine.endsWith("\n") ? "\n" : "") + c.theirs;
    })
    .join("");
}
