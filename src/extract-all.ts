#!/usr/bin/env node
/**
 * extract-all
 * -------------------------------------------------------------------------
 * Runs the whole pipeline for every GKE cluster in every project you can see:
 *
 *   for each project (gcloud projects list, or --projects)
 *     for each cluster (gcloud container clusters list)
 *       1. metrics   -> extract-gke-utilization --project P --cluster C
 *       2. manifests -> yaml/<name>.yaml + nodes.json (same as export-yaml)
 *       3. report    -> analyze-utilization --agg avg, sized on the real nodes
 *
 * Output layout (one folder per run):
 *   <out-dir>/index.html                         links to every report
 *   <out-dir>/<project>/<cluster>/gke-utilization.csv
 *   <out-dir>/<project>/<cluster>/yaml/*.yaml, nodes.json
 *   <out-dir>/<project>/<cluster>/report-<agg>.html (+ .apply.csv)
 *
 * A failure on one cluster is logged and the run moves on to the next one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Cluster, discoverClusters, exportCluster, kubeEnv, kubectlReady, nodeFlags, splitList, warn } from './gke';

// --- CLI --------------------------------------------------------------------
interface Cli {
  projects?: string[];
  clusters?: string[];
  window: string;
  agg: string;
  outDir: string;
  skipYaml: boolean;
  skipAnalyze: boolean;
}

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      projects: { type: 'string' }, // comma-separated; omit for all visible projects
      clusters: { type: 'string' },
      window: { type: 'string', default: '14d' },
      agg: { type: 'string', default: 'avg' },
      'out-dir': { type: 'string' },
      'skip-yaml': { type: 'boolean', default: false },
      'skip-analyze': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'Usage: extract-all [options]',
        '  --projects <a,b,...>   Only these projects (default: every project `gcloud projects list` shows)',
        '  --clusters <a,b,...>   Only these clusters (default: all)',
        '  --window <dur>         Look-back window passed to the extractor (default: 14d)',
        '  --agg sum|avg|pool     Aggregation passed to the analyzer (default: avg)',
        '  --out-dir <dir>        Output folder (default: data/<YYYY-MM-DD>)',
        '  --skip-yaml            Do not export manifests / nodes with kubectl',
        '  --skip-analyze         Only download; do not build reports',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  return {
    projects: splitList(values.projects),
    clusters: splitList(values.clusters),
    window: String(values.window),
    agg: String(values.agg),
    outDir: values['out-dir'] ?? path.join('data', new Date().toISOString().slice(0, 10)),
    skipYaml: Boolean(values['skip-yaml']),
    skipAnalyze: Boolean(values['skip-analyze']),
  };
}

const started = Date.now();
const log = (m: string) => process.stderr.write(`${m} [${((Date.now() - started) / 1000).toFixed(1)}s]\n`);

/** Run one of our own compiled scripts with live output. Returns true on success. */
function runNode(script: string, args: string[]): boolean {
  // Big clusters × 14 days do not fit the default ~4 GB heap.
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, script), ...args], { stdio: 'inherit' });
  return r.status === 0;
}

// --- index page -------------------------------------------------------------
interface Result {
  cluster: Cluster;
  csv: boolean;
  manifests: number | null;
  nodes: number | null;
  report?: string; // path relative to outDir
  error?: string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function renderIndex(results: Result[], cli: Cli): string {
  const rows = results
    .map(
      (r) => `<tr>
  <td>${esc(r.cluster.project)}</td>
  <td>${esc(r.cluster.name)}${r.cluster.autopilot ? ' <span class="tag">autopilot</span>' : ''}</td>
  <td>${esc(r.cluster.location)}</td>
  <td class="num">${r.nodes ?? '–'}</td>
  <td class="num">${r.manifests ?? '–'}</td>
  <td>${r.report ? `<a href="${esc(r.report.split(path.sep).join('/'))}">report</a>` : `<span class="err">${esc(r.error ?? 'no report')}</span>`}</td>
</tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GKE utilization reports</title>
<style>
  :root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --accent:#0a66c2; --err:#c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151517; --fg:#f2f2f7; --muted:#a1a1a6; --line:#2c2c30; --accent:#64a8f0; --err:#ef6c6c; } }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif; }
  main { max-width:960px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:var(--muted); margin-bottom:20px; }
  .wrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; } .num { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--accent); } .err { color:var(--err); }
  .tag { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
</style></head>
<body><main>
<h1>GKE utilization reports</h1>
<div class="sub">${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · window ${esc(cli.window)} · agg ${esc(cli.agg)} · ${results.length} cluster(s)</div>
<div class="wrap"><table>
<thead><tr><th>Project</th><th>Cluster</th><th>Location</th><th class="num">Nodes</th><th class="num">Manifests</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
</main></body></html>
`;
}

// --- main -------------------------------------------------------------------
function main(): void {
  const cli = parseCli();
  fs.mkdirSync(cli.outDir, { recursive: true });
  const env = kubeEnv(cli.outDir);
  const doYaml = !cli.skipYaml && kubectlReady();
  if (!cli.skipYaml && !doYaml) warn('         Continuing without manifests (reports will be %-only).');

  // [1/3] Discover clusters ------------------------------------------------
  log('[1/3] Discovering clusters');
  const clusters = discoverClusters(cli.projects, cli.clusters, log);
  if (!clusters.length) {
    warn('No GKE clusters found.');
    process.exitCode = 1;
    return;
  }

  // [2/3] Per cluster: metrics, manifests, report ----------------------------
  const results: Result[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const dir = path.join(cli.outDir, c.project, c.name);
    fs.mkdirSync(dir, { recursive: true });
    const res: Result = { cluster: c, csv: false, manifests: null, nodes: null };
    results.push(res);
    log(`[2/3] Cluster ${i + 1}/${clusters.length}: ${c.project}/${c.name} (${c.location})`);

    const csvPath = path.join(dir, 'gke-utilization.csv.gz');
    res.csv = runNode('extract-gke-utilization.js', [
      '--project', c.project, '--cluster', c.name, '--window', cli.window, '--out', csvPath, '--quiet',
    ]);
    if (!res.csv) {
      res.error = 'metrics download failed';
      continue;
    }
    log(`        metrics → ${csvPath} (${(fs.statSync(csvPath).size / 1e6).toFixed(0)} MB)`);

    let flags: string[] = [];
    const yamlDir = path.join(dir, 'yaml');
    if (doYaml) {
      try {
        const r = exportCluster(c, dir, env);
        res.manifests = r.manifests;
        res.nodes = r.nodes.length;
        // Autopilot bills per pod, so node-shape sizing does not apply there.
        if (!c.autopilot) flags = nodeFlags(r.nodes);
        log(`        manifests → ${yamlDir} (${r.manifests}), ${r.nodes.length} node(s)`);
      } catch (e: any) {
        warn(`        WARNING: kubectl step failed: ${e.message}`);
      }
    }

    if (cli.skipAnalyze) continue;
    const report = path.join(dir, `report-${cli.agg}.html`);
    const ok = runNode('analyze-utilization.js', [
      '--in', csvPath, '--agg', cli.agg, '--out', report,
      // Always pass --yaml-dir: otherwise the analyzer falls back to ./yaml, which belongs to another cluster.
      '--yaml-dir', res.manifests ? yamlDir : path.join(dir, 'no-yaml'),
      ...flags,
    ]);
    if (ok) res.report = path.relative(cli.outDir, report);
    else res.error = 'analysis failed';
  }

  // [3/3] Index ---------------------------------------------------------------
  const index = path.join(cli.outDir, 'index.html');
  fs.writeFileSync(index, renderIndex(results, cli), 'utf8');
  const ok = results.filter((r) => r.report || (cli.skipAnalyze && r.csv)).length;
  log(`[3/3] Done: ${ok}/${results.length} cluster(s) ok → ${index}`);
  if (ok < results.length) process.exitCode = 1;
}

try {
  main();
} catch (err: any) {
  process.stderr.write(`ERROR: ${err?.message ?? err}\n`);
  process.exit(1);
}
