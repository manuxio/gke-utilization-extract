/**
 * Shared GKE helpers for extract-all and export-yaml: project/cluster
 * discovery via gcloud, manifest + node export via kubectl.
 *
 * kubectl credentials always go to a private kubeconfig (KUBECONFIG env), so
 * the user's own ~/.kube/config is never touched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';

// Namespaces managed by GKE itself: their workloads are not ours to resize.
export const SYSTEM_NS = /^(kube-|gke-|gmp-|config-management-|istio-system$|asm-)/;

// Workload kinds whose pod template carries the container requests/limits.
export const DEFAULT_KINDS = 'deploy,sts,ds';

export const warn = (m: string) => process.stderr.write(`${m}\n`);

/** Run a CLI tool and capture stdout. gcloud/kubectl are .cmd shims on Windows, hence the shell. */
export function capture(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: env ?? process.env,
    maxBuffer: 1 << 30,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  return r.stdout;
}

export function hasTool(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { shell: process.platform === 'win32', stdio: 'ignore' });
  return r.status === 0;
}

/** True when kubectl + the GKE auth plugin are installed; warns otherwise. */
export function kubectlReady(): boolean {
  if (hasTool('kubectl', ['version', '--client']) && hasTool('gke-gcloud-auth-plugin', ['--version'])) return true;
  warn('WARNING: kubectl or gke-gcloud-auth-plugin not found.');
  warn('         Install with: gcloud components install kubectl gke-gcloud-auth-plugin');
  return false;
}

export function kubeEnv(outDir: string): NodeJS.ProcessEnv {
  return { ...process.env, KUBECONFIG: path.resolve(outDir, '.kubeconfig') };
}

export function splitList(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- discovery --------------------------------------------------------------
export interface Cluster {
  project: string;
  name: string;
  location: string;
  autopilot: boolean;
}

export function listProjects(): string[] {
  const out = capture('gcloud', ['projects', 'list', '--format=value(projectId)']);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}

export function listClusters(project: string): Cluster[] {
  const out = capture('gcloud', ['container', 'clusters', 'list', `--project=${project}`, '--format=json']);
  return (JSON.parse(out || '[]') as any[]).map((c) => ({
    project,
    name: c.name,
    location: c.location,
    autopilot: Boolean(c.autopilot?.enabled),
  }));
}

/**
 * Every cluster in the given projects (default: all visible projects).
 * Projects without the GKE API or without permission are skipped with a note.
 * Throws only if the project list itself cannot be read (usually expired auth).
 */
export function discoverClusters(projects: string[] | undefined, clusterNames: string[] | undefined, log: (m: string) => void): Cluster[] {
  let ps: string[];
  try {
    ps = projects ?? listProjects();
  } catch (e: any) {
    throw new Error(`could not list projects: ${e.message}\n       Run \`gcloud auth login\` first.`);
  }
  log(`Looking for GKE clusters in ${ps.length} project(s)…`);
  const clusters: Cluster[] = [];
  for (const p of ps) {
    try {
      const cs = listClusters(p).filter((c) => !clusterNames || clusterNames.includes(c.name));
      if (cs.length) log(`        ${p}: ${cs.map((c) => c.name).join(', ')}`);
      clusters.push(...cs);
    } catch (e: any) {
      // Usually "Kubernetes Engine API has not been used in project" or a permission error.
      warn(`        ${p}: skipped (${e.message.slice(0, 160)})`);
    }
  }
  return clusters;
}

// --- manifests + nodes ------------------------------------------------------
export interface ClusterExport {
  manifests: number;
  nodes: any[];
}

/**
 * Fetch credentials for one cluster, write each workload to <dir>/yaml/<name>.yaml
 * (the analyzer looks manifests up as <app>.yaml) and the node list to
 * <dir>/nodes.json. Read-only on the cluster side.
 */
export function exportCluster(c: Cluster, dir: string, env: NodeJS.ProcessEnv, kinds = DEFAULT_KINDS, allNamespaces = false): ClusterExport {
  capture('gcloud', ['container', 'clusters', 'get-credentials', c.name, `--location=${c.location}`, `--project=${c.project}`], env);

  const items: any[] = JSON.parse(capture('kubectl', ['get', kinds, '-A', '-o', 'json'], env)).items ?? [];
  const yamlDir = path.join(dir, 'yaml');
  fs.mkdirSync(yamlDir, { recursive: true });
  const used = new Set<string>();
  let manifests = 0;
  for (const it of items) {
    const ns = it.metadata?.namespace ?? 'default';
    if (!allNamespaces && SYSTEM_NS.test(ns)) continue;
    // Plain <name>.yaml; disambiguate with namespace/kind only on a clash.
    let base = it.metadata?.name;
    if (used.has(base)) base = `${ns}__${String(it.kind).toLowerCase()}__${base}`;
    used.add(base);
    fs.writeFileSync(path.join(yamlDir, `${base}.yaml`), yaml.dump(it, { lineWidth: -1 }), 'utf8');
    manifests++;
  }

  const nodes: any[] = JSON.parse(capture('kubectl', ['get', 'nodes', '-o', 'json'], env)).items ?? [];
  fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes, null, 2), 'utf8');
  return { manifests, nodes };
}

function cpuMilli(v: string): number {
  return v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000;
}

function memGiB(v: string): number {
  const m = v.match(/^(\d+(?:\.\d+)?)([KMGT]i?)?$/);
  if (!m) return NaN;
  const mult: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  };
  return (Number(m[1]) * (m[2] ? mult[m[2]] : 1)) / 1024 ** 3;
}

/** Analyzer flags describing the current node shape (most common one if pools are mixed). */
export function nodeFlags(nodes: any[]): string[] {
  if (!nodes.length) return [];
  const shapes = new Map<string, { count: number; node: any }>();
  for (const nd of nodes) {
    const type = nd.metadata?.labels?.['node.kubernetes.io/instance-type'] ?? 'unknown';
    const s = shapes.get(type);
    if (s) s.count++;
    else shapes.set(type, { count: 1, node: nd });
  }
  const [type, top] = [...shapes.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (shapes.size > 1) {
    warn(`        WARNING: mixed node types (${[...shapes.keys()].join(', ')}); sizing uses ${type}`);
  }
  const alloc = top.node.status?.allocatable ?? {};
  const cpuM = cpuMilli(String(alloc.cpu));
  const mem = memGiB(String(alloc.memory));
  return [
    '--nodes', String(nodes.length),
    '--node-cpu-alloc', String(Math.round(cpuM)),
    '--node-mem-alloc', mem.toFixed(1),
    '--node-pods', String(alloc.pods ?? 110),
    '--node-label', `${(cpuM / 1000).toFixed(0)} vCPU / ${mem.toFixed(0)} GiB alloc (${type})`,
  ];
}
