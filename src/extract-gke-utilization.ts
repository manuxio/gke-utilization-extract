#!/usr/bin/env node
/**
 * extract-gke-utilization
 * -------------------------------------------------------------------------
 * Pull RAW GKE container resource-utilization time series from Google Cloud
 * Monitoring (resource type `k8s_container`) and write them to a single CSV
 * in long/tidy format — one row per data point.
 *
 * This script does NO aggregation. It fetches each time series individually
 * and emits every data point exactly as returned (no mean/p95/max, no
 * crossSeriesReducer, no rounding). A separate downstream script consumes the
 * CSV and aggregates however it likes.
 *
 * Progress/status is written to STDERR only. The CSV data goes to --out.
 */
import * as fs from 'node:fs';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { MetricServiceClient } from '@google-cloud/monitoring';

// ---------------------------------------------------------------------------
// App identity
// ---------------------------------------------------------------------------
// Single source of truth for how an "app" is identified. Default is the label
// as surfaced in Monitoring. To switch to the standard Kubernetes app label,
// change this one constant (or pass --app-field), e.g.:
//   const DEFAULT_APP_FIELD = 'metadata.user_labels."app.kubernetes.io/name"';
const DEFAULT_APP_FIELD = 'metadata.user_labels."app"';

// ---------------------------------------------------------------------------
// Metrics to fetch (short names used in the CSV `metric` column)
// ---------------------------------------------------------------------------
const METRICS: ReadonlyArray<{ type: string; short: string }> = [
  { type: 'kubernetes.io/container/cpu/request_utilization', short: 'cpu_request' },
  { type: 'kubernetes.io/container/cpu/limit_utilization', short: 'cpu_limit' },
  { type: 'kubernetes.io/container/memory/request_utilization', short: 'mem_request' },
  { type: 'kubernetes.io/container/memory/limit_utilization', short: 'mem_limit' },
];

const RESOURCE_TYPE = 'k8s_container';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface Cli {
  project?: string;
  cluster?: string;
  window: string;
  appField: string;
  align?: number;
  out: string;
  quiet: boolean;
  verbose: boolean;
}

function usage(): string {
  return [
    'Usage: gke-utilization-extract [options]',
    '',
    'Options:',
    '  --project <id>       GCP project id (default: $GOOGLE_CLOUD_PROJECT or ADC project)',
    '  --cluster <name>     Only this GKE cluster (default: all clusters in the project)',
    '  --window <dur>       Look-back window: 7d, 24h, 90m, 3600s (default: 14d)',
    '  --app-field <spec>   Field that identifies an app',
    `                       (default: ${DEFAULT_APP_FIELD})`,
    '  --align <seconds>    If set, apply ALIGN_MEAN at this period. Default: off (raw points)',
    '  --out <path>         Output CSV path (default: gke-utilization-<YYYY-MM-DD>.csv)',
    '  --quiet              Suppress progress output',
    '  --verbose            Log resolved request parameters',
    '  --help               Show this help',
  ].join('\n');
}

function parseWindowSeconds(w: string): number {
  const m = String(w).trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`Invalid --window "${w}" (expected e.g. 7d, 24h, 90m, 3600s, 604800)`);
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * mult[unit];
}

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      cluster: { type: 'string' },
      window: { type: 'string', default: '14d' },
      'app-field': { type: 'string' },
      align: { type: 'string' },
      out: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(usage() + '\n');
    process.exit(0);
  }

  let align: number | undefined;
  if (values.align != null) {
    align = Number(values.align);
    if (!Number.isFinite(align) || align <= 0) {
      throw new Error(`Invalid --align "${values.align}" (expected a positive number of seconds)`);
    }
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return {
    project: values.project,
    cluster: values.cluster,
    window: values.window ?? '14d',
    appField: values['app-field'] ?? DEFAULT_APP_FIELD,
    align,
    out: values.out ?? `gke-utilization-${today}.csv`,
    quiet: Boolean(values.quiet),
    verbose: Boolean(values.verbose),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Human-readable count: 118034 -> "118k", 3700000 -> "3.7M". */
export function human(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/** Minimal RFC-4180 CSV field escaping. */
export function csv(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** protobuf Timestamp (seconds may be Long | string | number) -> ISO 8601 UTC. */
export function tsToIso(ts: any): string {
  if (!ts) return '';
  const secs =
    typeof ts.seconds === 'object' && ts.seconds && typeof ts.seconds.toNumber === 'function'
      ? ts.seconds.toNumber()
      : Number(ts.seconds ?? 0);
  const nanos = Number(ts.nanos ?? 0);
  return new Date(secs * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

/** Extract the numeric value of a point, preserving full precision. null if non-numeric. */
export function pointValue(p: any): number | null {
  const v = p?.value ?? {};
  if (v.doubleValue != null) return Number(v.doubleValue);
  if (v.int64Value != null) {
    const iv = v.int64Value;
    return typeof iv === 'object' && iv && typeof iv.toNumber === 'function' ? iv.toNumber() : Number(iv);
  }
  return null;
}

/**
 * Build a resolver that reads the configured app field from a time series.
 * Supported specs:
 *   metadata.user_labels."app"   metadata.user_labels.app   (quoted key may contain dots/slashes)
 *   resource.labels.<key>
 *   metric.labels.<key>
 *   <bareKey>                     (treated as a user label key)
 */
export function makeAppResolver(fieldSpec: string): (series: any) => string | undefined {
  let m = fieldSpec.match(/^metadata\.user_labels\.(?:"([^"]+)"|(.+))$/);
  if (m) {
    const key = m[1] ?? m[2];
    return (s) => s?.metadata?.userLabels?.[key];
  }
  m = fieldSpec.match(/^resource\.labels\.(.+)$/);
  if (m) {
    const key = m[1];
    return (s) => s?.resource?.labels?.[key];
  }
  m = fieldSpec.match(/^metric\.labels\.(.+)$/);
  if (m) {
    const key = m[1];
    return (s) => s?.metric?.labels?.[key];
  }
  return (s) => s?.metadata?.userLabels?.[fieldSpec];
}

// ---------------------------------------------------------------------------
// Buffered, back-pressure-aware CSV writer (keeps memory bounded on big clusters)
// ---------------------------------------------------------------------------
class CsvSink {
  private buf = '';
  private static FLUSH_AT = 1 << 20; // 1 MiB
  constructor(private readonly stream: fs.WriteStream) {}

  async push(line: string): Promise<void> {
    this.buf += line;
    if (this.buf.length >= CsvSink.FLUSH_AT) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.buf) return;
    const chunk = this.buf;
    this.buf = '';
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async end(): Promise<void> {
    await this.flush();
    this.stream.end();
    await once(this.stream, 'finish');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cli = parseCli();
  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  // Progress -> STDERR only. `log` is gated by --quiet; `warn` always shows.
  const log = (msg: string) => {
    if (!cli.quiet) process.stderr.write(`${msg} [${elapsed()}s]\n`);
  };
  const warn = (msg: string) => process.stderr.write(`${msg}\n`);

  const windowSeconds = parseWindowSeconds(cli.window);
  const endMs = Date.now();
  const startMs = endMs - windowSeconds * 1000;
  const interval = {
    startTime: { seconds: Math.floor(startMs / 1000) },
    endTime: { seconds: Math.floor(endMs / 1000) },
  };
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const appOf = makeAppResolver(cli.appField);

  // [1/4] Resolve credentials + project ------------------------------------
  const client = new MetricServiceClient();
  let projectId: string;
  try {
    projectId = cli.project || process.env.GOOGLE_CLOUD_PROJECT || (await client.getProjectId());
  } catch (err: any) {
    warn(`ERROR: could not resolve GCP project. Pass --project or set GOOGLE_CLOUD_PROJECT.`);
    warn(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }
  const projectName = `projects/${projectId}`;
  log(`[1/4] Resolving credentials + project… ok (project=${projectId})`);
  if (cli.verbose) {
    log(
      `      cluster=${cli.cluster ?? '(all)'} window=${cli.window} (${windowSeconds}s) interval=[${startIso} .. ${endIso}] ` +
        `app-field=${cli.appField} align=${cli.align ? cli.align + 's ALIGN_MEAN' : 'off (raw)'} out=${cli.out}`,
    );
  }

  // Optional alignment (default: off => fully raw points)
  const aggregation = cli.align
    ? { alignmentPeriod: { seconds: cli.align }, perSeriesAligner: 'ALIGN_MEAN' as const }
    : undefined;

  // Open output CSV and write header
  const stream = fs.createWriteStream(cli.out, { encoding: 'utf8' });
  const fatalStreamError = new Promise<never>((_, reject) => stream.on('error', reject));
  const sink = new CsvSink(stream);
  await sink.push('timestamp,app,container_name,pod_name,namespace,metric,value\n');

  const appsSeen = new Set<string>();
  let totalRows = 0;

  try {
    for (let i = 0; i < METRICS.length; i++) {
      const metric = METRICS[i];
      const filter =
        `metric.type = "${metric.type}" AND resource.type = "${RESOURCE_TYPE}"` +
        (cli.cluster ? ` AND resource.labels.cluster_name = "${cli.cluster}"` : '');
      const baseRequest: any = {
        name: projectName,
        filter,
        interval,
        view: 'FULL',
        ...(aggregation ? { aggregation } : {}),
      };

      log(`[2/4] Fetching metric ${i + 1}/4: ${metric.short}…`);
      if (cli.verbose) log(`      filter: ${filter}`);

      let request: any = baseRequest;
      let page = 0;
      let seriesCount = 0;
      let pointCount = 0;

      // Manual pagination so we can log page progress and stream rows as we go.
      while (true) {
        const result: any = await Promise.race([
          client.listTimeSeries(request, { autoPaginate: false }),
          fatalStreamError,
        ]);
        const timeSeries: any[] = result[0] ?? [];
        const nextRequest: any = result[1];
        const rawResponse: any = result[2];
        page++;
        seriesCount += timeSeries.length;

        // [3/4] Write rows for this page
        for (const series of timeSeries) {
          const labels = series?.resource?.labels ?? {};
          const container = labels.container_name ?? '';
          const pod = labels.pod_name ?? '';
          const namespace = labels.namespace_name ?? '';
          const app = appOf(series) || container || 'unknown';
          appsSeen.add(app);

          const points: any[] = series?.points ?? [];
          for (const p of points) {
            const value = pointValue(p);
            if (value == null) continue; // skip non-numeric / empty points
            const iso = tsToIso(p?.interval?.endTime);
            await sink.push(
              `${csv(iso)},${csv(app)},${csv(container)},${csv(pod)},${csv(namespace)},${metric.short},${value}\n`,
            );
            totalRows++;
            pointCount++;
          }
        }

        const token = nextRequest?.pageToken || rawResponse?.nextPageToken;
        log(
          `        page ${page}: ${timeSeries.length} series (cumulative ${seriesCount} series, ${human(pointCount)} points)`,
        );
        if (!token) break;
        request = { ...baseRequest, pageToken: token };
      }

      if (seriesCount === 0) {
        warn(`WARNING: metric ${metric.short} (${metric.type}) returned 0 series for the window — skipping.`);
        continue;
      }

      log(
        `[3/4] Wrote ${metric.short}: ${seriesCount} series, ${human(pointCount)} points ` +
          `→ ${cli.out} (cumulative ${human(totalRows)} rows)`,
      );
    }

    await sink.end();
    log(
      `[4/4] Done: ${METRICS.length} metrics, ${appsSeen.size} apps seen, ` +
        `${human(totalRows)} rows in ${elapsed()}s → ${cli.out}`,
    );
  } catch (err: any) {
    // On error, report project / metric window context and exit non-zero.
    warn('ERROR while fetching/writing time series:');
    warn(`  project : ${projectId}`);
    if (cli.cluster) warn(`  cluster : ${cli.cluster}`);
    warn(`  metrics : ${METRICS.map((m) => m.short).join(', ')}`);
    warn(`  window  : ${cli.window} [${startIso} .. ${endIso}]`);
    warn(`  out     : ${cli.out}`);
    warn(`  cause   : ${err?.message ?? err}`);
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`FATAL: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
