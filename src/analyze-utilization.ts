#!/usr/bin/env node
/**
 * analyze-utilization
 * -------------------------------------------------------------------------
 * Consumes the raw CSV produced by extract-gke-utilization and produces an
 * HTML right-sizing report (PDF later).
 *
 * Per the brief: for each app, combine the values of all its pods into one
 * per-app series per metric, then report low(>0) / high / p90 / p95, and a
 * suggested rewrite of requests & limits expressed as a % of the current
 * configured value.
 *
 * How pods are combined is controlled by --agg:
 *   sum  (default) : at each timestamp, SUM the value across all pods of the app
 *   avg            : at each timestamp, AVERAGE across pods (per-replica view)
 *   pool           : pool every pod's raw points into one distribution
 *
 * NOTE ON SIZING: request/limit utilization are PER-POD ratios. If an app runs
 * N concurrent replicas, `sum` inflates the series ~N×, so the suggested % (which
 * is per-pod) is only meaningful under `avg`/`pool`. `sum` is the default because
 * the brief asked for it — switch to `--agg avg` for per-replica right-sizing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import * as yaml from 'js-yaml';

// --- metric metadata --------------------------------------------------------
const METRIC_META = [
  { short: 'cpu_request', resource: 'CPU', kind: 'request', label: 'CPU request utilization' },
  { short: 'cpu_limit', resource: 'CPU', kind: 'limit', label: 'CPU limit utilization' },
  { short: 'mem_request', resource: 'Memory', kind: 'request', label: 'Memory request utilization' },
  { short: 'mem_limit', resource: 'Memory', kind: 'limit', label: 'Memory limit utilization' },
] as const;
const METRIC_SHORTS: Set<string> = new Set(METRIC_META.map((m) => m.short));

type AggMode = 'sum' | 'avg' | 'pool';

// --- CLI --------------------------------------------------------------------
interface Cli {
  in: string;
  apps?: Set<string>;
  out: string;
  csv: string; // apply-table CSV (one row per container)
  agg: AggMode;
  yamlDir?: string; // directory of current manifests (<app>.yaml)
  requestTarget: number; // desired p95 request-util after resizing (headroom)
  limitTarget: number; // desired peak limit-util after resizing (headroom)
  // cluster sizing
  nodes: number; // target node count
  haSpare: number; // nodes that may fail (size so workloads fit on nodes-haSpare)
  packing: number; // target fraction of node allocatable filled by requests
  nodeCpuAllocM: number; // current node allocatable CPU (millicores)
  nodeMemAllocGiB: number; // current node allocatable memory (GiB)
  nodePods: number; // current node max pods
  nodeLabel: string; // human label for the current node shape
}

function findLatestCsv(): string {
  const files = fs
    .readdirSync(process.cwd())
    .filter((f) => /^gke-utilization-\d{4}-\d{2}-\d{2}\.csv(\.gz)?$/.test(f))
    .sort();
  if (!files.length) throw new Error('No gke-utilization-*.csv found in cwd; pass --in <file>');
  return files[files.length - 1];
}

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      app: { type: 'string' }, // comma-separated; omit for all apps
      out: { type: 'string' },
      csv: { type: 'string' }, // apply-table CSV path
      'yaml-dir': { type: 'string' }, // current manifests (default: ./yaml if present)
      agg: { type: 'string', default: 'sum' },
      'request-target': { type: 'string', default: '0.80' },
      'limit-target': { type: 'string', default: '0.90' },
      // cluster sizing (defaults reflect the observed 16 vCPU / 128 GiB nodes)
      nodes: { type: 'string', default: '4' },
      'ha-spare': { type: 'string', default: '1' },
      packing: { type: 'string', default: '0.75' },
      'node-cpu-alloc': { type: 'string', default: '15890' }, // millicores
      'node-mem-alloc': { type: 'string', default: '116.5' }, // GiB (122199992Ki)
      'node-pods': { type: 'string', default: '110' },
      'node-label': { type: 'string', default: '16 vCPU / 128 GiB (highmem-16)' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'Usage: analyze-utilization [options]',
        '  --in <file>            Input CSV or .csv.gz (default: latest gke-utilization-*.csv[.gz])',
        '  --app <a,b,...>        Only these apps (default: all)',
        '  --out <file>           Output HTML (default: derived from input + apps)',
        '  --csv <file>           Apply-table CSV (default: <out>.apply.csv)',
        '  --yaml-dir <dir>       Current manifests <app>.yaml for current-vs-suggested (default: ./yaml)',
        '  --agg sum|avg|pool     How to combine pods per app (default: sum)',
        '  --request-target <r>   Target p95 request-util after resize (default: 0.80)',
        '  --limit-target <r>     Target peak limit-util after resize (default: 0.90)',
        '  --nodes <n>            Cluster node count (default: 4)',
        '  --ha-spare <n>         Nodes that may fail; size to fit on nodes-spare (default: 1)',
        '  --packing <r>          Target fraction of node allocatable filled by requests (default: 0.75)',
        '  --node-cpu-alloc <m>   Current node allocatable CPU in millicores (default: 15890)',
        '  --node-mem-alloc <gib> Current node allocatable memory in GiB (default: 116.5)',
        '  --node-pods <n>        Current node max pods (default: 110)',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  const agg = String(values.agg) as AggMode;
  if (!['sum', 'avg', 'pool'].includes(agg)) throw new Error(`--agg must be sum|avg|pool, got "${values.agg}"`);

  const inFile = values.in ?? findLatestCsv();
  const apps = values.app
    ? new Set(
        String(values.app)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : undefined;

  const today = new Date().toISOString().slice(0, 10);
  const appTag = apps && apps.size <= 3 ? '-' + [...apps].join('_') : '';
  const out = values.out ?? `gke-utilization-report${appTag}-${agg}-${today}.html`;
  const csv = values.csv ?? out.replace(/\.html?$/i, '') + '.apply.csv';

  let yamlDir = values['yaml-dir'];
  if (yamlDir === undefined && fs.existsSync('yaml') && fs.statSync('yaml').isDirectory()) yamlDir = 'yaml';

  return {
    in: inFile,
    apps,
    out,
    csv,
    agg,
    yamlDir,
    requestTarget: Number(values['request-target']),
    limitTarget: Number(values['limit-target']),
    nodes: Number(values['nodes']),
    haSpare: Number(values['ha-spare']),
    packing: Number(values['packing']),
    nodeCpuAllocM: Number(values['node-cpu-alloc']),
    nodeMemAllocGiB: Number(values['node-mem-alloc']),
    nodePods: Number(values['node-pods']),
    nodeLabel: String(values['node-label']),
  };
}

// --- CSV line parse (fast path when no quotes) ------------------------------
function parseLine(line: string): string[] {
  if (line.indexOf('"') === -1) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// --- stats ------------------------------------------------------------------
interface Stats {
  count: number;
  low: number; // min value that is still > 0
  high: number;
  p90: number;
  p95: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const firstPos = sorted.find((v) => v > 0);
  return {
    count: sorted.length,
    low: firstPos ?? 0,
    high: sorted.length ? sorted[sorted.length - 1] : 0,
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
}

// --- Kubernetes quantities (parse current YAML values, format suggestions) ---
type Q = string | number | null | undefined;

/** CPU quantity -> millicores. "100m"->100, "1"->1000, 0.5->500. */
function cpuToMilli(v: Q): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.endsWith('m')) return parseFloat(s.slice(0, -1));
  if (s.endsWith('n')) return parseFloat(s.slice(0, -1)) / 1e6;
  if (s.endsWith('u')) return parseFloat(s.slice(0, -1)) / 1e3;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * 1000 : null;
}

const MEM_SUFFIX: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};
/** Memory quantity -> bytes. "256Mi", "1Gi", "512M", plain bytes. */
function memToBytes(v: Q): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^([0-9.]+)\s*([A-Za-z]+)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (!m[2]) return n; // bytes
  const mult = MEM_SUFFIX[m[2]];
  return mult ? n * mult : null;
}

/** millicores -> tidy k8s string ("295m", "2"). CPU rounds to nearest tidy step. */
function fmtCpu(milli: number): string {
  const step = milli < 100 ? 5 : milli < 1000 ? 10 : 50;
  const m = Math.max(5, Math.round(milli / step) * step);
  return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
}
/** bytes -> tidy k8s string ("64Mi", "1.5Gi"). Memory rounds UP (OOM-safe). */
function fmtMem(bytes: number): string {
  const Mi = 1024 ** 2;
  let mi = Math.ceil(bytes / Mi);
  const step = mi < 128 ? 8 : mi < 1024 ? 32 : 128;
  mi = Math.max(16, Math.ceil(mi / step) * step);
  if (mi % 1024 === 0) return `${mi / 1024}Gi`;
  if (mi > 1024) return `${(mi / 1024).toFixed(1)}Gi`;
  return `${mi}Mi`;
}

// --- GKE node allocatable (reproduces observed 15890m CPU / 116.5GiB on a 16/128 node) ---
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** GKE reserved CPU (millicores) for a node with `vcpu` cores. */
function gkeCpuReserveMilli(vcpu: number): number {
  let r = 0.06 * Math.min(1, vcpu) * 1000; // 6% of 1st core
  if (vcpu > 1) r += 0.01 * Math.min(1, vcpu - 1) * 1000; // 1% of 2nd
  if (vcpu > 2) r += 0.005 * Math.min(2, vcpu - 2) * 1000; // 0.5% of cores 3-4
  if (vcpu > 4) r += 0.0025 * (vcpu - 4) * 1000; // 0.25% of the rest
  return r;
}

/** GKE reserved memory (MiB) for a node with `memMiB` of RAM (+100MiB eviction threshold). */
function gkeMemReserveMiB(memMiB: number): number {
  let r = 0.25 * Math.min(4096, memMiB); // 25% of first 4GiB
  if (memMiB > 4096) r += 0.2 * Math.min(4096, memMiB - 4096); // 20% of next 4GiB
  if (memMiB > 8192) r += 0.1 * Math.min(8192, memMiB - 8192); // 10% of next 8GiB
  if (memMiB > 16384) r += 0.06 * Math.min(131072 - 16384, memMiB - 16384); // 6% up to 128GiB
  if (memMiB > 131072) r += 0.02 * (memMiB - 131072); // 2% above 128GiB
  return r + 100; // hard eviction threshold
}

function gkeAllocatable(vcpu: number, memGiB: number): { cpuM: number; memMiB: number } {
  const memMiB = memGiB * 1024;
  return { cpuM: vcpu * 1000 - gkeCpuReserveMilli(vcpu), memMiB: memMiB - gkeMemReserveMiB(memMiB) };
}

/** Common GKE machine shapes (E2; N2/N2D/C3 share the same vCPU:RAM ratios). */
interface Machine { name: string; vcpu: number; memGiB: number; family: string }
const MACHINES: Machine[] = [
  ['highcpu', 1], ['standard', 4], ['highmem', 8],
].flatMap(([fam, gbPer]) =>
  [2, 4, 8, 16, 32].map((v) => ({
    name: `e2-${fam}-${v}`,
    vcpu: v,
    memGiB: v * (gbPer as number),
    family: fam as string,
  })),
);

/** Smallest machine whose GKE-allocatable covers the per-node need (cpu millicores, mem MiB). */
function pickMachine(needCpuM: number, needMemMiB: number): { m: Machine; alloc: { cpuM: number; memMiB: number } } | null {
  const sorted = [...MACHINES].sort((a, b) => a.vcpu - b.vcpu || a.memGiB - b.memGiB);
  for (const m of sorted) {
    const alloc = gkeAllocatable(m.vcpu, m.memGiB);
    if (alloc.cpuM >= needCpuM && alloc.memMiB >= needMemMiB) return { m, alloc };
  }
  return null;
}

interface ContainerRes {
  deployment: string | null;
  replicas: number | null;
  cpuReqRaw: string | null;
  cpuLimRaw: string | null;
  memReqRaw: string | null;
  memLimRaw: string | null;
  cpuReqM: number | null;
  cpuLimM: number | null;
  memReqB: number | null;
  memLimB: number | null;
}

interface YamlIndex {
  byFile: Map<string, Map<string, ContainerRes>>; // fileBase -> containerName -> res
  byContainer: Map<string, ContainerRes>; // containerName -> res (last wins)
  files: number;
  containers: number;
}

function loadYaml(dir: string, warn: (m: string) => void): YamlIndex {
  const idx: YamlIndex = { byFile: new Map(), byContainer: new Map(), files: 0, containers: 0 };
  for (const fname of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(fname)) continue;
    const full = path.join(dir, fname);
    if (fs.statSync(full).size === 0) continue;
    let doc: any;
    try {
      doc = yaml.load(fs.readFileSync(full, 'utf8'));
    } catch (e: any) {
      warn(`WARNING: could not parse ${fname}: ${e?.message ?? e}`);
      continue;
    }
    const containers = doc?.spec?.template?.spec?.containers;
    if (!Array.isArray(containers)) continue;
    idx.files++;
    const base = fname.replace(/\.ya?ml$/i, '');
    const perFile = new Map<string, ContainerRes>();
    for (const c of containers) {
      const req = c?.resources?.requests ?? {};
      const lim = c?.resources?.limits ?? {};
      const res: ContainerRes = {
        deployment: doc?.metadata?.name ?? base,
        replicas: typeof doc?.spec?.replicas === 'number' ? doc.spec.replicas : null,
        cpuReqRaw: req.cpu != null ? String(req.cpu) : null,
        cpuLimRaw: lim.cpu != null ? String(lim.cpu) : null,
        memReqRaw: req.memory != null ? String(req.memory) : null,
        memLimRaw: lim.memory != null ? String(lim.memory) : null,
        cpuReqM: cpuToMilli(req.cpu),
        cpuLimM: cpuToMilli(lim.cpu),
        memReqB: memToBytes(req.memory),
        memLimB: memToBytes(lim.memory),
      };
      if (c?.name) {
        perFile.set(String(c.name), res);
        idx.byContainer.set(String(c.name), res);
        idx.containers++;
      }
    }
    idx.byFile.set(base, perFile);
  }
  return idx;
}

/** Resolve the current resources for an app/container: prefer <app>.yaml, else global by container. */
function resolveRes(idx: YamlIndex | null, app: string, container: string): ContainerRes | null {
  if (!idx) return null;
  const perFile = idx.byFile.get(app);
  if (perFile) {
    if (perFile.has(container)) return perFile.get(container)!;
    if (perFile.size === 1) return [...perFile.values()][0];
  }
  return idx.byContainer.get(container) ?? null;
}

// --- HTML helpers -----------------------------------------------------------
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pct = (v: number) => (v * 100).toFixed(1) + '%';

interface AppReport {
  app: string;
  container: string;
  pods: number;
  points: number;
  tsMin: string;
  tsMax: string;
  stats: Record<string, Stats>; // by metric short
  res: ContainerRes | null; // current values from YAML, if available
}

/** A single resource×kind sizing line: current (YAML) vs suggested (absolute). */
interface Sizing {
  key: string;
  resource: 'CPU' | 'Memory';
  kind: 'request' | 'limit';
  label: string;
  unit: 'cpu' | 'mem'; // canonical unit: millicores | bytes
  currentRaw: string | null; // as configured today
  currentCanon: number | null; // current in millicores | bytes
  util: number | null; // basis: p95 (request) or peak (limit)
  pct: number | null; // suggested value as % of current
  newRaw: string | null; // suggested absolute value
  newCanon: number | null; // suggested in millicores | bytes
}

/** current × (usage_basis / target) = suggested absolute; limit clamped ≥ request. */
function computeSizing(rep: AppReport, cli: Cli): Sizing[] {
  const basis = (short: string, which: 'p95' | 'high'): number | null => {
    const s = rep.stats[short];
    if (!s || s.count === 0) return null;
    return which === 'p95' ? s.p95 : s.high;
  };
  const r = rep.res;
  const cpuReqU = basis('cpu_request', 'p95');
  const cpuLimU = basis('cpu_limit', 'high');
  const memReqU = basis('mem_request', 'p95');
  const memLimU = basis('mem_limit', 'high');

  let cpuReqNewM = r?.cpuReqM != null && cpuReqU != null ? (r.cpuReqM * cpuReqU) / cli.requestTarget : null;
  let cpuLimNewM = r?.cpuLimM != null && cpuLimU != null ? (r.cpuLimM * cpuLimU) / cli.limitTarget : null;
  let memReqNewB = r?.memReqB != null && memReqU != null ? (r.memReqB * memReqU) / cli.requestTarget : null;
  let memLimNewB = r?.memLimB != null && memLimU != null ? (r.memLimB * memLimU) / cli.limitTarget : null;
  // A limit below its request is invalid in k8s — clamp limit up.
  if (cpuReqNewM != null && cpuLimNewM != null && cpuLimNewM < cpuReqNewM) cpuLimNewM = cpuReqNewM;
  if (memReqNewB != null && memLimNewB != null && memLimNewB < memReqNewB) memLimNewB = memReqNewB;

  const mk = (
    resource: 'CPU' | 'Memory',
    kind: 'request' | 'limit',
    key: string,
    util: number | null,
    currentRaw: string | null,
    currentCanon: number | null,
    newCanon: number | null,
    unit: 'cpu' | 'mem',
  ): Sizing => ({
    key,
    resource,
    kind,
    label: `${resource} ${kind}`,
    unit,
    currentRaw,
    currentCanon,
    util,
    pct: util != null ? (util / (kind === 'request' ? cli.requestTarget : cli.limitTarget)) * 100 : null,
    newRaw: newCanon != null ? (unit === 'cpu' ? fmtCpu(newCanon) : fmtMem(newCanon)) : null,
    newCanon,
  });

  return [
    mk('CPU', 'request', 'cpu_request', cpuReqU, r?.cpuReqRaw ?? null, r?.cpuReqM ?? null, cpuReqNewM, 'cpu'),
    mk('CPU', 'limit', 'cpu_limit', cpuLimU, r?.cpuLimRaw ?? null, r?.cpuLimM ?? null, cpuLimNewM, 'cpu'),
    mk('Memory', 'request', 'mem_request', memReqU, r?.memReqRaw ?? null, r?.memReqB ?? null, memReqNewB, 'mem'),
    mk('Memory', 'limit', 'mem_limit', memLimU, r?.memLimRaw ?? null, r?.memLimB ?? null, memLimNewB, 'mem'),
  ];
}

function suggestPct(basis: number, target: number): number | null {
  if (basis <= 0) return null;
  return (basis / target) * 100;
}

/** Provisioning categories used by the in-page filter. An app can carry several. */
const CATEGORIES: { cat: string; label: string }[] = [
  { cat: 'under-reserved', label: 'Under-reserved · request &gt; 100%' },
  { cat: 'over-limit', label: 'Over limit · limit &gt; 100%' },
  { cat: 'severely-over-reserved', label: 'Severely over-reserved · ≤ 25%' },
  { cat: 'over-reserved', label: 'Over-reserved · &lt; 80%' },
  { cat: 'no-limits', label: 'No limits set' },
  { cat: 'no-data', label: 'No data' },
];

function appFlags(rep: AppReport, cli: Cli): string[] {
  const g = suggestions(rep, cli);
  const present = [g.cpuReqPct, g.cpuLimPct, g.memReqPct, g.memLimPct].filter((v): v is number => v != null);
  const reqs = [g.cpuReqPct, g.memReqPct].filter((v): v is number => v != null);
  const lims = [g.cpuLimPct, g.memLimPct].filter((v): v is number => v != null);
  const flags: string[] = [];
  if (reqs.some((v) => v > 100)) flags.push('under-reserved'); // usage exceeds current request
  if (lims.some((v) => v > 100)) flags.push('over-limit'); // peak reached/passed the limit
  if (present.length && present.every((v) => v <= 25)) flags.push('severely-over-reserved');
  if (present.some((v) => v < 80)) flags.push('over-reserved'); // has headroom to shrink
  if (g.cpuLimPct == null && g.memLimPct == null) flags.push('no-limits');
  if (present.length === 0) flags.push('no-data');
  return flags;
}

/** The four sizing suggestions for a container: request sized on p95, limit on peak. */
function suggestions(rep: AppReport, cli: Cli) {
  const s = (short: string) => rep.stats[short];
  return {
    cpuReqBasis: s('cpu_request')?.p95 ?? 0,
    cpuLimBasis: s('cpu_limit')?.high ?? 0,
    memReqBasis: s('mem_request')?.p95 ?? 0,
    memLimBasis: s('mem_limit')?.high ?? 0,
    cpuReqPct: suggestPct(s('cpu_request')?.p95 ?? 0, cli.requestTarget),
    cpuLimPct: suggestPct(s('cpu_limit')?.high ?? 0, cli.limitTarget),
    memReqPct: suggestPct(s('mem_request')?.p95 ?? 0, cli.requestTarget),
    memLimPct: suggestPct(s('mem_limit')?.high ?? 0, cli.limitTarget),
  };
}

function dirBadge(p: number | null): string {
  if (p == null) return '<span class="badge muted">no data</span>';
  const r = Math.round(p);
  if (r < 95) return `<span class="badge down">▼ ${r}%</span>`;
  if (r > 110) return `<span class="badge up">▲ ${r}%</span>`;
  return `<span class="badge keep">≈ ${r}%</span>`;
}

function renderApp(rep: AppReport, cli: Cli): string {
  const statRow = (m: (typeof METRIC_META)[number]) => {
    const s = rep.stats[m.short];
    if (!s || s.count === 0)
      return `<tr><td>${esc(m.label)}</td><td colspan="5" class="muted">no data</td></tr>`;
    return `<tr>
      <td>${esc(m.label)}</td>
      <td class="num">${pct(s.low)}</td>
      <td class="num">${pct(s.p90)}</td>
      <td class="num strong">${pct(s.p95)}</td>
      <td class="num">${pct(s.high)}</td>
      <td class="num muted">${s.count.toLocaleString()}</td>
    </tr>`;
  };

  const sizeRow = (z: Sizing) => {
    const cur = z.currentRaw != null ? esc(z.currentRaw) : '<span class="muted">— none</span>';
    const used = z.util != null ? pct(z.util) : '<span class="muted">no data</span>';
    let nv: string;
    if (z.newRaw != null) nv = `<span class="strong">${esc(z.newRaw)}</span>`;
    else if (z.util == null) nv = '<span class="muted">no data</span>';
    else nv = '<span class="muted" title="no current value in this manifest to scale">—</span>';
    return `<tr>
      <td class="strong">${z.label}</td>
      <td class="num">${cur}</td>
      <td class="num">${used}</td>
      <td class="num">${dirBadge(z.pct)}</td>
      <td class="num">${nv}</td>
    </tr>`;
  };

  const sizing = computeSizing(rep, cli);
  const flags = appFlags(rep, cli);

  // Total demand = request × replicas (absolute), for "most demanding" sorting.
  const reps = rep.res?.replicas ?? 1;
  const cpuReq = sizing.find((s) => s.key === 'cpu_request')!;
  const memReq = sizing.find((s) => s.key === 'mem_request')!;
  const cpuCur = (cpuReq.currentCanon ?? 0) * reps; // millicores
  const cpuSug = (cpuReq.newCanon ?? cpuReq.currentCanon ?? 0) * reps;
  const memCur = (memReq.currentCanon ?? 0) * reps; // bytes
  const memSug = (memReq.newCanon ?? memReq.currentCanon ?? 0) * reps;

  return `<section class="app" data-app="${esc(rep.app)}" data-flags="${flags.join(' ')}"
      data-cpu-cur="${cpuCur.toFixed(0)}" data-cpu-sug="${cpuSug.toFixed(0)}" data-mem-cur="${memCur.toFixed(0)}" data-mem-sug="${memSug.toFixed(0)}">
    <h2>${esc(rep.app)}</h2>
    <div class="chips">
      <span class="chip">container: ${esc(rep.container)}</span>
      ${rep.res?.replicas != null ? `<span class="chip">replicas: ${rep.res.replicas}</span>` : ''}
      <span class="chip">pods: ${rep.pods}</span>
      ${rep.res ? `<span class="chip">demand ×${reps}: cur ${vcpu(cpuCur)} vCPU / ${gib(memCur)} GiB → sug <strong>${vcpu(cpuSug)} vCPU / ${gib(memSug)} GiB</strong></span>` : ''}
      <span class="chip">points: ${rep.points.toLocaleString()}</span>
      <span class="chip">agg: ${cli.agg}</span>
    </div>

    <table class="stats">
      <thead><tr><th>Metric</th><th class="num">low&nbsp;(&gt;0)</th><th class="num">p90</th><th class="num">p95</th><th class="num">high</th><th class="num">points</th></tr></thead>
      <tbody>${METRIC_META.map(statRow).join('')}</tbody>
    </table>

    <h3>Current vs suggested — values to set in the manifest</h3>
    <div class="apply">Container <code>${esc(rep.container)}</code>${
      rep.res?.deployment ? ` · deployment <code>${esc(rep.res.deployment)}</code>` : ' · <span class="muted">no manifest found</span>'
    }. Suggested = observed usage (p95 for requests, peak for limits) ÷ target headroom; limit clamped ≥ request.</div>
    <table class="rec">
      <thead><tr>
        <th>Resource</th>
        <th class="num">current</th>
        <th class="num">used<br><span class="muted">p95 / peak</span></th>
        <th class="num">vs current</th>
        <th class="num">suggested</th>
      </tr></thead>
      <tbody>${sizing.map(sizeRow).join('')}</tbody>
    </table>
  </section>`;
}

// --- cluster sizing ---------------------------------------------------------
interface Cluster {
  apps: number; // apps with a manifest (counted)
  uncounted: string[]; // apps in metrics without a manifest (system/daemonsets)
  replicas: number; // Σ configured replicas of counted apps
  assumedReplicas: number; // counted apps where replicas was missing (assumed 1)
  curCpuM: number; curMemB: number; // current requests × replicas
  sugCpuM: number; sugMemB: number; // right-sized requests × replicas
  useCpuM: number; useMemB: number; // observed usage (p95 basis) × replicas
}

function computeCluster(reports: AppReport[], cli: Cli): Cluster {
  const c: Cluster = {
    apps: 0, uncounted: [], replicas: 0, assumedReplicas: 0,
    curCpuM: 0, curMemB: 0, sugCpuM: 0, sugMemB: 0, useCpuM: 0, useMemB: 0,
  };
  for (const rep of reports) {
    if (!rep.res) { c.uncounted.push(rep.app); continue; }
    const reps = rep.res.replicas ?? 1;
    if (rep.res.replicas == null) c.assumedReplicas++;
    c.apps++;
    c.replicas += reps;
    const z = computeSizing(rep, cli);
    const cpuReq = z.find((s) => s.key === 'cpu_request')!;
    const memReq = z.find((s) => s.key === 'mem_request')!;
    // current
    c.curCpuM += (cpuReq.currentCanon ?? 0) * reps;
    c.curMemB += (memReq.currentCanon ?? 0) * reps;
    // suggested (fall back to current when there is no metric to size on)
    c.sugCpuM += (cpuReq.newCanon ?? cpuReq.currentCanon ?? 0) * reps;
    c.sugMemB += (memReq.newCanon ?? memReq.currentCanon ?? 0) * reps;
    // observed usage = util × current
    if (cpuReq.util != null && cpuReq.currentCanon != null) c.useCpuM += cpuReq.util * cpuReq.currentCanon * reps;
    if (memReq.util != null && memReq.currentCanon != null) c.useMemB += memReq.util * memReq.currentCanon * reps;
  }
  return c;
}

const vcpu = (milli: number) => (milli / 1000).toFixed(1);
const gib = (bytes: number) => (bytes / GIB).toFixed(1);

function renderCluster(cl: Cluster, cli: Cli): string {
  const effNodes = Math.max(1, cli.nodes - cli.haSpare);
  // required per-node allocatable = (demand / effNodes) / packing
  const needCpuM = cl.sugCpuM / effNodes / cli.packing;
  const needMemMiB = cl.sugMemB / MIB / effNodes / cli.packing;
  const rec = pickMachine(needCpuM, needMemMiB);

  // Utilisation of the CURRENT fleet (nodes × current allocatable) by right-sized requests.
  const fleetCpuAllocM = cli.nodes * cli.nodeCpuAllocM;
  const fleetMemAllocB = cli.nodes * cli.nodeMemAllocGiB * GIB;
  const cpuFill = (cl.sugCpuM / (effNodes * cli.nodeCpuAllocM)) * 100; // fill on nodes-spare current nodes
  const memFill = (cl.sugMemB / (effNodes * cli.nodeMemAllocGiB * GIB)) * 100;

  const savedCpu = cl.curCpuM - cl.sugCpuM;
  const savedMem = cl.curMemB - cl.sugMemB;
  const podCap = cli.nodes * cli.nodePods;
  const podCapHa = effNodes * cli.nodePods;

  const row = (label: string, cpu: string, mem: string, cls = '') =>
    `<tr class="${cls}"><td>${label}</td><td class="num">${cpu}</td><td class="num">${mem}</td></tr>`;

  const recNodeCpu = rec ? rec.m.vcpu : Math.ceil(needCpuM / 1000);
  const recNodeMem = rec ? rec.m.memGiB : Math.ceil(needMemMiB / 1024);
  const recName = rec ? rec.m.name : `custom ≥ ${recNodeCpu} vCPU / ${recNodeMem} GiB`;

  return `<section class="cluster">
    <h2>Cluster sizing — ${cli.nodes} nodes</h2>
    <div class="apply">
      Basis: right-sized <strong>requests × configured replicas</strong> (agg=${cli.agg}), across ${cl.apps} apps with manifests
      (${cl.replicas} replicas). Sized to keep requests ≤ <strong>${(cli.packing * 100).toFixed(0)}%</strong> of node allocatable
      while tolerating <strong>${cli.haSpare}</strong> node failure${cli.haSpare === 1 ? '' : 's'} (fits on ${effNodes} of ${cli.nodes}).
      ${cl.uncounted.length ? `<span class="muted">${cl.uncounted.length} system/daemonset apps have no manifest and are covered by the node reserve.</span>` : ''}
    </div>
    <table class="rec">
      <thead><tr><th>Cluster demand (Σ requests × replicas)</th><th class="num">CPU</th><th class="num">Memory</th></tr></thead>
      <tbody>
        ${row('Current reserved (today)', vcpu(cl.curCpuM) + ' vCPU', gib(cl.curMemB) + ' GiB')}
        ${row('Right-sized reserved (suggested)', '<strong>' + vcpu(cl.sugCpuM) + ' vCPU</strong>', '<strong>' + gib(cl.sugMemB) + ' GiB</strong>', 'hi')}
        ${row('↳ freed by right-sizing', vcpu(savedCpu) + ' vCPU', gib(savedMem) + ' GiB', 'muted')}
        ${row('Observed usage (p95 basis)', vcpu(cl.useCpuM) + ' vCPU', gib(cl.useMemB) + ' GiB', 'muted')}
      </tbody>
    </table>
    <h3>Recommended node size (for ${cli.nodes} nodes, survive ${cli.haSpare})</h3>
    <table class="rec">
      <thead><tr><th>Option</th><th class="num">per node</th><th class="num">notes</th></tr></thead>
      <tbody>
        <tr class="hi"><td><strong>Recommended</strong></td>
          <td class="num"><strong>${recNodeCpu} vCPU / ${recNodeMem} GiB</strong></td>
          <td class="num">${recName} × ${cli.nodes}</td></tr>
        <tr><td>Per-node need (allocatable)</td>
          <td class="num">${vcpu(needCpuM)} vCPU · ${(needMemMiB / 1024).toFixed(1)} GiB</td>
          <td class="num muted">= demand ÷ ${effNodes} ÷ ${cli.packing}</td></tr>
        <tr><td>Keep current node (${esc(cli.nodeLabel)})</td>
          <td class="num">${cpuFill.toFixed(0)}% CPU · ${memFill.toFixed(0)}% mem filled</td>
          <td class="num muted">on ${effNodes} nodes @ ${(cli.packing * 100).toFixed(0)}% target</td></tr>
        <tr><td>Pods</td>
          <td class="num">${cl.replicas} / ${podCap}</td>
          <td class="num muted">${cl.replicas} ≤ ${podCapHa}? survives ${cli.haSpare} down</td></tr>
      </tbody>
    </table>
  </section>`;
}

function renderHtml(reports: AppReport[], cli: Cli): string {
  const generated = new Date().toISOString();
  const clusterHtml = cli.yamlDir ? renderCluster(computeCluster(reports, cli), cli) : '';
  const body = reports.map((r) => renderApp(r, cli)).join('\n');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GKE utilization report${cli.apps && cli.apps.size <= 3 ? ' — ' + [...cli.apps].join(', ') : ''}</title>
<style>
  :root{ --fg:#1a1d24; --muted:#6b7280; --line:#e3e6eb; --bg:#fff; --accent:#2563eb;
         --down:#0f766e; --downbg:#d1faf3; --up:#b42318; --upbg:#fee4e2; --keep:#525252; --keepbg:#eef0f3; }
  *{ box-sizing:border-box; }
  body{ font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--fg); background:var(--bg); margin:0; padding:32px; }
  header{ border-bottom:2px solid var(--line); padding-bottom:16px; margin-bottom:24px; }
  h1{ font-size:22px; margin:0 0 6px; }
  h2{ font-size:18px; margin:0 0 4px; }
  h3{ font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:20px 0 8px; }
  .sub{ color:var(--muted); font-size:12.5px; }
  .method{ background:#f7f8fa; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:14px; font-size:12.5px; color:#374151; }
  .method code{ background:#eef0f3; padding:1px 5px; border-radius:4px; }
  section.app{ border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin-bottom:22px; }
  section.cluster{ border:2px solid var(--accent); border-radius:10px; padding:18px 20px; margin-bottom:22px; background:#f8faff; }
  section.cluster h2{ color:var(--accent); }
  tr.hi td{ background:#eef4ff; }
  tr.muted td{ color:var(--muted); }
  .apply{ font-size:12.5px; color:#374151; margin:2px 0 6px; }
  .apply code{ background:#eef0f3; padding:1px 5px; border-radius:4px; }
  .chips{ margin:2px 0 12px; }
  .chip{ display:inline-block; background:#f0f2f5; color:#374151; border-radius:999px; padding:2px 10px; margin:0 6px 6px 0; font-size:12px; }
  table{ border-collapse:collapse; width:100%; margin:6px 0 4px; }
  th,td{ text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:middle; }
  th{ color:var(--muted); font-weight:600; font-size:12px; }
  th.num{ text-align:right; }
  td.num{ text-align:right; font-variant-numeric:tabular-nums; }
  td.strong,.strong{ font-weight:700; }
  .muted{ color:var(--muted); }
  .badge{ display:inline-block; border-radius:6px; padding:2px 8px; font-weight:700; font-size:12.5px; font-variant-numeric:tabular-nums; }
  .badge.down{ color:var(--down); background:var(--downbg); }
  .badge.up{ color:var(--up); background:var(--upbg); }
  .badge.keep{ color:var(--keep); background:var(--keepbg); }
  .badge.muted{ color:var(--muted); background:var(--keepbg); }
  footer{ color:var(--muted); font-size:12px; margin-top:20px; border-top:1px solid var(--line); padding-top:12px; }
  .toolbar{ position:sticky; top:0; z-index:10; background:var(--bg); border-bottom:1px solid var(--line);
            padding:12px 0; margin-bottom:18px; display:flex; flex-wrap:wrap; gap:10px 12px; align-items:center; }
  .toolbar input[type=search]{ padding:7px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; min-width:200px; }
  .toolbar select{ padding:7px 8px; border:1px solid var(--line); border-radius:8px; font:inherit; font-size:12.5px; background:#f7f8fa; cursor:pointer; }
  .cats{ display:flex; flex-wrap:wrap; gap:6px; }
  .cats button{ font:inherit; font-size:12.5px; padding:5px 11px; border:1px solid var(--line); background:#f7f8fa;
                color:#374151; border-radius:999px; cursor:pointer; }
  .cats button:hover{ background:#eef0f3; }
  .cats button.active{ background:var(--accent); border-color:var(--accent); color:#fff; }
  .cats button .c{ opacity:.65; font-variant-numeric:tabular-nums; margin-left:3px; }
  .cats button.active .c{ opacity:.9; }
  .count{ color:var(--muted); font-size:12.5px; margin-left:auto; white-space:nowrap; }
  .empty{ display:none; color:var(--muted); text-align:center; padding:36px 0; }
  @media print{
    body{ padding:0; }
    .toolbar{ display:none !important; }
    section.app{ break-inside:avoid; page-break-inside:avoid; display:block !important; }
    @page{ size:A4; margin:14mm; }
  }
</style>
</head><body>
<header>
  <h1>GKE container right-sizing report</h1>
  <div class="sub">Source: <code>${esc(path.basename(cli.in))}</code> · apps: ${
    cli.apps ? [...cli.apps].join(', ') : 'all (' + reports.length + ')'
  } · generated ${esc(generated)}</div>
  <div class="method">
    <strong>Method.</strong> Per app, pods are combined with <code>agg=${cli.agg}</code>
    ${
      cli.agg === 'sum'
        ? '(values SUMMED across pods at each timestamp)'
        : cli.agg === 'avg'
          ? '(values AVERAGED across pods at each timestamp — per-replica view)'
          : '(all pods’ raw points pooled into one distribution)'
    }.
    <code>low</code> is the smallest value still &gt; 0; <code>p90/p95/high</code> use the nearest-rank method over the combined series.
    <strong>Suggested sizing</strong> = basis ÷ target, as a % of the current configured value:
    request uses <code>p95</code> with target <code>${cli.requestTarget}</code>;
    limit uses <code>peak</code> with target <code>${cli.limitTarget}</code>.
    <span class="muted">Utilization is a per-pod ratio, so <code>avg</code>/<code>pool</code> map directly to per-pod sizing;
    <code>sum</code> inflates by the concurrent replica count.</span>
    <br><strong>To set YAML:</strong> ${
      cli.yamlDir
        ? `current values were read from <code>${esc(cli.yamlDir)}/&lt;app&gt;.yaml</code>, so the <em>suggested</em> column holds absolute values ready to paste (<code>suggested = used ÷ target × current</code>).`
        : `no <code>--yaml-dir</code> given, so only the % (of current) is shown — pass <code>--yaml-dir</code> to get absolute values.`
    } A machine-readable table is written alongside as <code>${esc(path.basename(cli.csv))}</code>.
    <br><span class="muted">Caveat: memory is incompressible — the "peak" here is the max over the ${esc(reports[0]?.tsMin ?? '')}…${esc(
      reports[0]?.tsMax ?? '',
    )} window; leave extra headroom on memory limits to avoid OOMKills.</span>
  </div>
</header>
${clusterHtml}
<div class="toolbar">
  <input id="nameFilter" type="search" placeholder="Filter app name…" autocomplete="off" spellcheck="false">
  <div class="cats" id="cats">
    <button data-cat="all" class="active">All</button>
    ${CATEGORIES.map((c) => `<button data-cat="${c.cat}">${c.label}</button>`).join('\n    ')}
  </div>
  <select id="sortBy" title="Sort apps by total demand (request × replicas)">
    <option value="name">Sort: name (A→Z)</option>
    <option value="memSug">RAM suggested ↓ (most demanding)</option>
    <option value="memCur">RAM current ↓</option>
    <option value="cpuSug">CPU suggested ↓</option>
    <option value="cpuCur">CPU current ↓</option>
  </select>
  <span class="count" id="count"></span>
</div>
<div id="apps">${body}</div>
<div class="empty" id="empty">No apps match the current filter.</div>
<footer>Generated by analyze-utilization · ${reports.length} app(s) · nearest-rank percentiles · values shown as % (ratio×100).</footer>
<script>
(function () {
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.app'));
  var nameInput = document.getElementById('nameFilter');
  var cats = document.getElementById('cats');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  var appsWrap = document.getElementById('apps');
  var sortSel = document.getElementById('sortBy');
  var buttons = Array.prototype.slice.call(cats.querySelectorAll('button'));
  var activeCat = 'all';

  function sortApps() {
    var key = sortSel.value; // 'name' | 'cpuCur' | 'cpuSug' | 'memCur' | 'memSug'
    var arr = sections.slice();
    arr.sort(function (a, b) {
      if (key === 'name') {
        var an = (a.dataset.app || '').toLowerCase(), bn = (b.dataset.app || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      }
      return (Number(b.dataset[key]) || 0) - (Number(a.dataset[key]) || 0); // descending = most demanding first
    });
    arr.forEach(function (s) { appsWrap.appendChild(s); });
  }
  sortSel.addEventListener('change', sortApps);

  function flagsOf(s) { return (s.dataset.flags || '').split(' ').filter(Boolean); }

  // Annotate each category button with how many apps carry it.
  buttons.forEach(function (b) {
    var cat = b.dataset.cat;
    var n = cat === 'all' ? sections.length : sections.filter(function (s) { return flagsOf(s).indexOf(cat) >= 0; }).length;
    b.insertAdjacentHTML('beforeend', ' <span class="c">' + n + '</span>');
    if (cat !== 'all' && n === 0) { b.disabled = true; b.style.opacity = 0.4; b.style.cursor = 'default'; }
  });

  function apply() {
    var q = nameInput.value.trim().toLowerCase();
    var shown = 0;
    sections.forEach(function (s) {
      var okName = !q || (s.dataset.app || '').toLowerCase().indexOf(q) >= 0;
      var okCat = activeCat === 'all' || flagsOf(s).indexOf(activeCat) >= 0;
      var show = okName && okCat;
      s.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    countEl.textContent = 'showing ' + shown + ' of ' + sections.length;
    emptyEl.style.display = shown ? 'none' : 'block';
  }

  nameInput.addEventListener('input', apply);
  cats.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    activeCat = b.dataset.cat;
    buttons.forEach(function (x) { x.classList.toggle('active', x === b); });
    apply();
  });
  apply();
})();
</script>
</body></html>`;
}

// --- apply-table CSV (one row per container; ready to join with current YAML) ---
function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function ratio(v: number | undefined): string {
  return v == null ? '' : v.toFixed(6);
}
function pctInt(v: number | null): string {
  return v == null ? '' : String(Math.round(v));
}

function buildApplyCsv(reports: AppReport[], cli: Cli): string {
  const header = [
    'app',
    'container',
    'deployment',
    'replicas',
    'pods',
    'agg',
    // one triplet per resource×kind: current -> suggested (absolute), plus used% and %-of-current
    'cpu_request_current', 'cpu_request_used', 'cpu_request_pct', 'cpu_request_suggested',
    'cpu_limit_current', 'cpu_limit_used', 'cpu_limit_pct', 'cpu_limit_suggested',
    'mem_request_current', 'mem_request_used', 'mem_request_pct', 'mem_request_suggested',
    'mem_limit_current', 'mem_limit_used', 'mem_limit_pct', 'mem_limit_suggested',
    'points',
  ].join(',');

  const lines = reports.map((r) => {
    const z = computeSizing(r, cli); // order: cpu_request, cpu_limit, mem_request, mem_limit
    const cells = z.flatMap((s) => [
      csvField(s.currentRaw),
      ratio(s.util ?? undefined),
      pctInt(s.pct),
      csvField(s.newRaw),
    ]);
    return [
      csvField(r.app),
      csvField(r.container),
      csvField(r.res?.deployment ?? ''),
      r.res?.replicas ?? '',
      r.pods,
      cli.agg,
      ...cells,
      r.points,
    ].join(',');
  });

  return header + '\n' + lines.join('\n') + '\n';
}

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  const cli = parseCli();
  const started = Date.now();
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
  const log = (m: string) => process.stderr.write(`${m} [${elapsed()}s]\n`);

  if (!fs.existsSync(cli.in)) throw new Error(`Input CSV not found: ${cli.in}`);
  log(`[1/3] Reading ${cli.in} (agg=${cli.agg}${cli.apps ? `, apps=${[...cli.apps].join(',')}` : ', all apps'})…`);

  // Aggregation stores.
  //  sum/avg: key -> day -> dense per-minute {s, n} arrays. Timestamps are bucketed to the
  //           minute (the extractor aligns at 60s), and typed arrays keep 14 days × hundreds
  //           of apps in a few hundred MB instead of blowing the heap with string-keyed maps.
  //  pool   : key -> number[]          (all raw points)
  const byMinute = new Map<string, Map<number, { s: Float64Array; n: Uint16Array }>>();
  const pooled = new Map<string, number[]>();
  const podsByApp = new Map<string, Set<string>>();
  const containersByApp = new Map<string, Set<string>>();
  const appMeta = new Map<string, { points: number; tsMin: string; tsMax: string }>();

  const raw = fs.createReadStream(cli.in);
  const input = /\.gz$/i.test(cli.in) ? raw.pipe(zlib.createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let first = true;
  let rows = 0;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    } // header
    if (!line) continue;
    const c = parseLine(line);
    const app = c[1];
    if (cli.apps && !cli.apps.has(app)) continue;
    const metric = c[5];
    if (!METRIC_SHORTS.has(metric)) continue;
    const ts = c[0];
    const container = c[2];
    const pod = c[3];
    const value = Number(c[6]);
    if (!Number.isFinite(value)) continue;

    rows++;
    if (rows % 1_000_000 === 0) log(`      …scanned ${(rows / 1e6).toFixed(0)}M matching rows`);

    let pset = podsByApp.get(app);
    if (!pset) podsByApp.set(app, (pset = new Set()));
    pset.add(pod);

    let cset = containersByApp.get(app);
    if (!cset) containersByApp.set(app, (cset = new Set()));
    cset.add(container);

    let meta = appMeta.get(app);
    if (!meta) appMeta.set(app, (meta = { points: 0, tsMin: ts, tsMax: ts }));
    meta.points++;
    if (ts < meta.tsMin) meta.tsMin = ts;
    if (ts > meta.tsMax) meta.tsMax = ts;

    const key = app + ' ' + metric;
    if (cli.agg === 'pool') {
      let arr = pooled.get(key);
      if (!arr) pooled.set(key, (arr = []));
      arr.push(value);
    } else {
      const minute = Math.floor(Date.parse(ts) / 60_000);
      if (!Number.isFinite(minute)) continue;
      const day = Math.floor(minute / 1440);
      let days = byMinute.get(key);
      if (!days) byMinute.set(key, (days = new Map()));
      let b = days.get(day);
      if (!b) days.set(day, (b = { s: new Float64Array(1440), n: new Uint16Array(1440) }));
      const i = minute - day * 1440;
      b.s[i] += value;
      b.n[i] += 1;
    }
  }
  log(`[2/3] Scanned ${rows.toLocaleString()} matching rows; ${podsByApp.size} app(s). Computing stats…`);

  const warn = (m: string) => process.stderr.write(`${m}\n`);
  let yamlIdx: YamlIndex | null = null;
  if (cli.yamlDir) {
    if (fs.existsSync(cli.yamlDir)) {
      yamlIdx = loadYaml(cli.yamlDir, warn);
      log(`      loaded current values from ${cli.yamlDir}/ (${yamlIdx.files} manifests, ${yamlIdx.containers} containers)`);
    } else {
      warn(`WARNING: --yaml-dir "${cli.yamlDir}" not found; suggestions will be %-only.`);
    }
  }

  const seriesFor = (app: string, metric: string): number[] => {
    const key = app + ' ' + metric;
    if (cli.agg === 'pool') return pooled.get(key) ?? [];
    const days = byMinute.get(key);
    if (!days) return [];
    const out: number[] = [];
    for (const { s, n } of days.values()) {
      for (let i = 0; i < 1440; i++) if (n[i]) out.push(cli.agg === 'avg' ? s[i] / n[i] : s[i]);
    }
    return out;
  };

  const apps = [...podsByApp.keys()].sort();
  const reports: AppReport[] = apps.map((app) => {
    const meta = appMeta.get(app)!;
    const stats: Record<string, Stats> = {};
    for (const m of METRIC_META) stats[m.short] = computeStats(seriesFor(app, m.short));
    const container = [...(containersByApp.get(app) ?? [])].sort().join(';') || app;
    const res = resolveRes(yamlIdx, app, container);
    return { app, container, pods: podsByApp.get(app)!.size, points: meta.points, tsMin: meta.tsMin, tsMax: meta.tsMax, stats, res };
  });

  const matched = reports.filter((r) => r.res).length;
  if (yamlIdx) log(`      matched current values for ${matched}/${reports.length} apps`);

  // Console summary (stderr) for quick validation.
  for (const r of reports) {
    log(`      ${r.app}: pods=${r.pods}`);
    for (const m of METRIC_META) {
      const s = r.stats[m.short];
      if (s.count === 0) continue;
      process.stderr.write(
        `          ${m.short.padEnd(12)} low=${pct(s.low)}  p90=${pct(s.p90)}  p95=${pct(s.p95)}  high=${pct(s.high)}  (n=${s.count})\n`,
      );
    }
  }

  if (yamlIdx) {
    const cl = computeCluster(reports, cli);
    const effNodes = Math.max(1, cli.nodes - cli.haSpare);
    const rec = pickMachine(cl.sugCpuM / effNodes / cli.packing, cl.sugMemB / MIB / effNodes / cli.packing);
    log(
      `      cluster: current ${vcpu(cl.curCpuM)} vCPU / ${gib(cl.curMemB)} GiB → right-sized ${vcpu(cl.sugCpuM)} vCPU / ${gib(cl.sugMemB)} GiB reserved`,
    );
    log(
      `      recommend ${cli.nodes}× ${rec ? rec.m.name : 'custom'} (${rec ? rec.m.vcpu + ' vCPU / ' + rec.m.memGiB + ' GiB' : '?'}) to survive ${cli.haSpare} node down @ ${(cli.packing * 100).toFixed(0)}% packing`,
    );
  }

  const html = renderHtml(reports, cli);
  fs.writeFileSync(cli.out, html, 'utf8');
  fs.writeFileSync(cli.csv, buildApplyCsv(reports, cli), 'utf8');
  log(`[3/3] Wrote ${cli.out} + ${cli.csv} (${reports.length} app section(s)).`);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err?.message ?? err}\n`);
  process.exit(1);
});
