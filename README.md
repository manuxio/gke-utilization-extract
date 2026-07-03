# gke-utilization-extract

A small TypeScript (Node.js) CLI that pulls **raw** GKE container
resource-utilization time series from Google Cloud Monitoring and writes them to
**one CSV** in long/tidy format — one row per data point.

It does **no aggregation**: each time series is fetched individually and every
data point is emitted exactly as returned (no mean/p95/max, no
`crossSeriesReducer`, no rounding). A separate downstream script consumes the
CSV and aggregates however it likes.

## Metrics fetched

Resource type `k8s_container`, dimensionless ratios (`0.13` = 13%, `1.0` = 100%;
`request_utilization` can exceed `1.0`, `limit_utilization` is effectively capped
near `1.0`):

| Cloud Monitoring metric type                              | CSV `metric` |
| -------------------------------------------------------- | ------------ |
| `kubernetes.io/container/cpu/request_utilization`         | `cpu_request` |
| `kubernetes.io/container/cpu/limit_utilization`           | `cpu_limit`   |
| `kubernetes.io/container/memory/request_utilization`      | `mem_request` |
| `kubernetes.io/container/memory/limit_utilization`        | `mem_limit`   |

## Setup

Requires **Node.js ≥ 18.17**.

```bash
npm install
npm run build      # compiles src/ -> dist/
```

Authentication uses **Application Default Credentials**. Log in once and make
sure the account has `roles/monitoring.viewer`:

```bash
gcloud auth application-default login
```

## Run

```bash
# Uses $GOOGLE_CLOUD_PROJECT (or ADC project); last 7 days; writes
# gke-utilization-<today>.csv in the current directory.
npm start

# Or build + run in one step:
npm run extract -- --project my-proj

# Directly with node after building:
node dist/extract-gke-utilization.js --project my-proj --window 7d
```

### Options

| Flag              | Default                              | Description |
| ----------------- | ------------------------------------ | ----------- |
| `--project <id>`  | `$GOOGLE_CLOUD_PROJECT` or ADC project | GCP project to query. |
| `--window <dur>`  | `7d`                                 | Look-back window: `7d`, `24h`, `90m`, `3600s`, or plain seconds. |
| `--app-field <spec>` | `metadata.user_labels."app"`      | Field that identifies an "app" (see below). |
| `--align <seconds>` | *off (raw points)*                 | If set, applies `ALIGN_MEAN` at this period. Off by default → fully raw. |
| `--out <path>`    | `gke-utilization-<YYYY-MM-DD>.csv`   | Output CSV path. |
| `--quiet`         | off                                  | Suppress progress output. |
| `--verbose`       | off                                  | Log resolved request parameters. |
| `--help`          | —                                    | Show help. |

Progress/status is printed to **stderr only**; the CSV data goes to `--out`, so
you can safely redirect or pipe either stream independently.

## Defining "app"

The app identifier is a single constant (`DEFAULT_APP_FIELD`) at the top of
[src/extract-gke-utilization.ts](src/extract-gke-utilization.ts), overridable
with `--app-field`. It defaults to the label as surfaced in Monitoring:

```
metadata.user_labels."app"
```

To switch to the standard Kubernetes app label, either edit the constant or pass:

```bash
--app-field 'metadata.user_labels."app.kubernetes.io/name"'
```

Supported field specs:

- `metadata.user_labels."<key>"` (quoted key may contain dots/slashes)
- `resource.labels.<key>`
- `metric.labels.<key>`

For each series the configured field is read; **if absent it falls back to
`resource.labels.container_name`**. Apps are discovered implicitly — whatever app
values appear across the fetched series (no hardcoded list). A run reports how
many distinct apps were seen.

## CSV output

Exactly one CSV file. Long/tidy format, one row per data point. Rows are streamed
to the file incrementally to keep memory low on large clusters.

| Column           | Description |
| ---------------- | ----------- |
| `timestamp`      | Point end time, ISO 8601 (UTC). |
| `app`            | Resolved app id (see "Defining app"), falling back to container name. |
| `container_name` | `resource.labels.container_name`. |
| `pod_name`       | `resource.labels.pod_name`. |
| `namespace`      | `resource.labels.namespace_name`. |
| `metric`         | Short metric name: `cpu_request`, `cpu_limit`, `mem_request`, `mem_limit`. |
| `value`          | Raw ratio, full precision, emitted as-is (no scaling/rounding). |

Example:

```csv
timestamp,app,container_name,pod_name,namespace,metric,value
2025-06-30T12:01:00.000Z,checkout,checkout,checkout-7d9f-abc,shop,cpu_request,0.1342
2025-06-30T12:02:00.000Z,checkout,checkout,checkout-7d9f-abc,shop,cpu_request,0.1571
```

## Progress output (stderr)

```
[1/4] Resolving credentials + project… ok (project=my-proj) [0.3s]
[2/4] Fetching metric 2/4: cpu_limit… [3.1s]
        page 1: 200 series (cumulative 200 series, 58k points) [3.9s]
        page 2: 212 series (cumulative 412 series, 118k points) [4.4s]
[3/4] Wrote cpu_limit: 412 series, 118k points → gke-utilization-2025-07-03.csv (cumulative 0.9M rows) [4.4s]
...
[4/4] Done: 4 metrics, 61 apps seen, 3.7M rows in 22.4s → gke-utilization-2025-07-03.csv [22.4s]
```

## Behavior notes

- **Pagination** (`nextPageToken`) is handled explicitly; page progress is logged.
- **Empty metric** → a warning is printed and the run continues.
- **Missing labels** → `app`/`container_name`/`pod_name`/`namespace` degrade
  gracefully (app falls back to container name, then `unknown`; other columns
  are left empty).
- **On error** the project, metrics, and window are printed to stderr and the
  process exits non-zero.
