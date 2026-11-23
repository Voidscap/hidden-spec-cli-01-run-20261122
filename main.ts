// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Files as lines (SPEC.md section 3) ----

interface FileModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

// ---- Matching lines at three tiers (SPEC.md section 5) ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => trimTrail(s.replace(/^[ \t]+/, ''));
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Tier 2 re-indentation of one new line (SPEC.md section 5). */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a unified hunk or a V4A chunk: context, old-only or new-only. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
  emptyLine: boolean;
}

function bodyOld(items: BodyLine[]): string[] {
  return items.filter((b) => b.kind !== 'add').map((b) => b.text);
}

/** The lines that replace the matched ones: context lines are the file's own, `+` lines the patch's. */
function buildSegment(items: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWS(fileLines[pos]!);
    p = leadWS(bodyOld(items)[0]!);
  }
  let k = pos;
  for (const b of items) {
    if (b.kind === 'ctx') {
      out.push(fileLines[k]!);
      k += 1;
    } else if (b.kind === 'del') {
      k += 1;
    } else {
      out.push(tier === 2 ? reindent(b.text, f, p) : b.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastCtxAddNoNL(items: BodyLine[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind !== 'del') return items[i]!.noNL;
  }
  return false;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  items: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({
  gitOld: null,
  gitNew: null,
  hasPair: false,
  pairOld: null,
  pairNew: null,
  renameFrom: null,
  renameTo: null,
  newFile: false,
  deletedFile: false,
  hunks: [],
});

/** A `---`/`+++` path: up to the first tab, spaces removed, one `a/` or `b/` prefix removed; null for /dev/null. */
function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice(11));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.hasPair = true;
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.hasPair = true;
      cur.pairOld = headerPath(line.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      sections.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.items.push({ kind: 'ctx', text: '', noNL: false, emptyLine: true });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') hunk.items.push({ kind: 'ctx', text: bl.slice(1), noNL: false, emptyLine: false });
        else if (c === '-') hunk.items.push({ kind: 'del', text: bl.slice(1), noNL: false, emptyLine: false });
        else if (c === '+') hunk.items.push({ kind: 'add', text: bl.slice(1), noNL: false, emptyLine: false });
        else if (c === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noNL = true;
        } else break;
        j += 1;
      }
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.emptyLine) hunk.items.pop();
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): void {
  const o = bodyOld(h.items);
  if (o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, model.lines.length));
    const seg = h.items.filter((b) => b.kind === 'add').map((b) => b.text);
    const atEnd = at === model.lines.length;
    model.lines.splice(at, 0, ...seg);
    if (atEnd) model.fin = !lastCtxAddNoNL(h.items);
    return;
  }
  const found = findTier(model.lines, o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.occ[0]!;
  for (const cand of found.occ) {
    if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
  }
  const seg = buildSegment(h.items, model.lines, pos, found.tier);
  const reachesEnd = pos + o.length === model.lines.length;
  model.lines.splice(pos, o.length, ...seg);
  if (reachesEnd) model.fin = !lastCtxAddNoNL(h.items);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.hasPair ? s.pairOld : (s.renameFrom ?? s.gitOld);
    const newPath = s.hasPair ? s.pairNew : (s.renameTo ?? s.gitNew);
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if ((s.newFile || oldPath === null) && newPath !== null) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const outLines: string[] = [];
      let noNL = false;
      for (const h of s.hunks) {
        for (const b of h.items) {
          if (b.kind === 'add') {
            outLines.push(b.text);
            noNL = b.noNL;
          }
        }
      }
      tree.now.set(newPath, writeModel({ lines: outLines, br: '\n', fin: !noNL }));
      return;
    }
    if ((s.deletedFile || newPath === null) && oldPath !== null) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (tree.get(op) === null) throw new Fail('missing', op);
    const isMove = np !== op;
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const model = parseFile(tree.get(op)!);
    let d = 0;
    for (const h of s.hunks) {
      applyHunk(model, h, d, strict, op);
      const oLen = h.items.filter((b) => b.kind !== 'add').length;
      const nLen = h.items.filter((b) => b.kind !== 'del').length;
      d += nLen - oLen;
    }
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, writeModel(model));
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, writeModel(model));
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= from; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    from = rp + 1;
    i = rp + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeModel({ lines: [...newLines], br: '\n', fin: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const seg =
      found.tier === 2 ? newLines.map((l) => reindent(l, leadWS(model.lines[pos]!), leadWS(oldLines[0]!))) : [...newLines];
    model.lines.splice(pos, oldLines.length, ...seg);
    tree.now.set(path, writeModel(model));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface Chunk {
  anchor: string | null;
  items: BodyLine[];
  eof: boolean;
}

const V4A_PREFIXES = { add: '*** Add File: ', del: '*** Delete File: ', upd: '*** Update File: ' } as const;
type V4aKind = keyof typeof V4A_PREFIXES;

function v4aHeader(l: string): V4aKind | null {
  if (l.startsWith(V4A_PREFIXES.add)) return 'add';
  if (l.startsWith(V4A_PREFIXES.del)) return 'del';
  if (l.startsWith(V4A_PREFIXES.upd)) return 'upd';
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aHeader(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(V4A_PREFIXES[kind].length).trim();
    let j = i + 1;
    const raw: { text: string; n: number }[] = [];
    while (j < last && v4aHeader(lines[j]!) === null) {
      raw.push({ text: lines[j]!, n: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
      edits.push(v4aAdd(path, content));
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, raw, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

function v4aAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, writeModel({ lines: content, br: '\n', fin: true }));
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, raw: { text: string; n: number }[], updLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    start = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let ended = false;
  for (let k = start; k < raw.length; k += 1) {
    const r = raw[k]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
      ended = false;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.n}`);
      cur.eof = true;
      ended = true;
      continue;
    }
    const c = l[0];
    if (l === '' || c === ' ' || c === '-' || c === '+') {
      if (ended) throw new Exit2(`error: parse ${r.n}`);
      if (cur === null) {
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      cur.items.push({
        kind: l === '' || c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
        text: l === '' ? '' : l.slice(1),
        noNL: false,
        emptyLine: l === '',
      });
      continue;
    }
    throw new Exit2(`error: parse ${r.n}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    const top = strict ? 0 : 2;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (let t = 0; t <= top && found < 0; t += 1) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineEq(model.lines[k]!, chunk.anchor, t)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const o = bodyOld(chunk.items);
      if (o.length === 0) {
        const seg = chunk.items.map((b) => b.text);
        const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
        continue;
      }
      let placed: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= top && placed === null; t += 1) {
        let occ = occurrences(model.lines, o, t, cursor);
        if (chunk.eof) occ = occ.filter((p) => p + o.length === model.lines.length);
        if (occ.length > 0) placed = { tier: t, pos: occ[0]! };
      }
      if (placed === null) throw new Fail('no-match', path);
      const seg = buildSegment(chunk.items, model.lines, placed.pos, placed.tier);
      model.lines.splice(placed.pos, o.length, ...seg);
      cursor = placed.pos + seg.length;
    }
    const out = writeModel(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      entries.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (!covered.has(p)) entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
