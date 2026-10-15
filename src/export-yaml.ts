#!/usr/bin/env node
/**
 * export-yaml
 * -------------------------------------------------------------------------
 * Download the current workload manifests (Deployments, StatefulSets,
 * DaemonSets by default) of every GKE cluster in every visible project:
 *
 *   <out-dir>/<project>/<cluster>/yaml/<name>.yaml
 *   <out-dir>/<project>/<cluster>/nodes.json
 *
 * Same layout as extract-all, so the yaml/ folder can be passed straight to
 * analyze-utilization with --yaml-dir. Read-only on the cluster side.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_KINDS, discoverClusters, exportCluster, kubeEnv, kubectlReady, splitList, warn } from './gke';

const started = Date.now();
const log = (m: string) => process.stderr.write(`${m} [${((Date.now() - started) / 1000).toFixed(1)}s]\n`);

function main(): void {
  const { values } = parseArgs({
    options: {
      projects: { type: 'string' },
      clusters: { type: 'string' },
      kinds: { type: 'string', default: DEFAULT_KINDS },
      'all-namespaces': { type: 'boolean', default: false },
      'out-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'Usage: export-yaml [options]',
        '  --projects <a,b,...>   Only these projects (default: every project `gcloud projects list` shows)',
        '  --clusters <a,b,...>   Only these clusters (default: all)',
        `  --kinds <k1,k2,...>    kubectl resource kinds to export (default: ${DEFAULT_KINDS})`,
        '  --all-namespaces       Include GKE system namespaces (kube-*, gke-*, gmp-*, …)',
        '  --out-dir <dir>        Output folder (default: data/<YYYY-MM-DD>)',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  const outDir = values['out-dir'] ?? path.join('data', new Date().toISOString().slice(0, 10));
  if (!kubectlReady()) {
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const clusters = discoverClusters(splitList(values.projects), splitList(values.clusters), log);
  if (!clusters.length) {
    warn('No GKE clusters found.');
    process.exitCode = 1;
    return;
  }

  const env = kubeEnv(outDir);
  let ok = 0;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const dir = path.join(outDir, c.project, c.name);
    try {
      const r = exportCluster(c, dir, env, String(values.kinds), Boolean(values['all-namespaces']));
      log(`[${i + 1}/${clusters.length}] ${c.project}/${c.name}: ${r.manifests} manifests, ${r.nodes.length} node(s) → ${dir}`);
      ok++;
    } catch (e: any) {
      warn(`[${i + 1}/${clusters.length}] ${c.project}/${c.name}: FAILED (${e.message})`);
    }
  }
  log(`Done: ${ok}/${clusters.length} cluster(s) exported → ${outDir}`);
  if (ok < clusters.length) process.exitCode = 1;
}

try {
  main();
} catch (err: any) {
  process.stderr.write(`ERROR: ${err?.message ?? err}\n`);
  process.exit(1);
}
