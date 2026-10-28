# Durable capacity baseline

## Purpose and command

`npm run benchmark:durable` measures the isolated `DurableSessionRuntime` with
in-process faux providers only. It does not configure or call a remote model
endpoint. The default run is deliberately small:

```bash
npm run benchmark:durable
```

A larger local run can select independent sessions, total turns, active
concurrency, and artificial provider delay:

```bash
npm run benchmark:durable -- \
  --sessions 32 --runs 320 --concurrency 16 --delay-ms 250 \
  --output docs/durable-capacity-local.json
```

Concurrency cannot exceed the session count, so each independent session has at
most one active turn, matching the Web chat boundary. Use `--skip-recovery` for a
load-only run or `--keep-data` to retain the temporary SQLite root. `--help`
lists all options. The command prints JSON and optionally writes the same report
to a file.

## Metric boundaries

- `admissionMs`: durable `submit()` admission; request IDs are unique per turn.
- `turnMs`: submit plus waiting for the assistant result, excluding the later
  snapshot and SQLite probes.
- `wallMs`: the complete measured load loop, including snapshots and probes.
- `snapshotReadMs`: pi-durable `watchEvents()` snapshot reads, not raw SQLite
  timing.
- `sqliteProbeMs`: a read-only `SELECT COUNT(*) FROM sqlite_schema` probe on each
  session database. This is a minimal SQLite connectivity/read probe, not a
  conversation-history benchmark.
- `eventLoopLagMs`: raw `monitorEventLoopDelay` samples with a 20ms resolution.
  The sampling interval contributes to these values; they are not a claim that
  every sample represents 20ms of application blocking.
- `memory`: process RSS/heap readings from the `tsx` development process. They
  include Node and `tsx` overhead and are not a production-image memory floor.
- `recovery.wallMs`: after the child process has exited from SIGKILL, the time to
  open the session, reacquire by the original request ID, finish the recovered
  response, and verify its snapshot. It excludes crash detection, process
  supervision, Pod restart, routing, and PostgreSQL reconnection time.

The recovery check kills a real child after its faux model starts. The parent
uses an immediate faux response. The report asserts one parent provider call and
exactly one visible durable user message. Model calls across the crash remain
at-least-once; the benchmark does not claim exactly-once billing or side effects.

## Recorded local baseline

Raw output: [`durable-capacity-baseline.json`](./durable-capacity-baseline.json).
Recorded on 2026-10-28 with Node v22.22.3, macOS arm64, 18 logical CPUs, and
64GiB host memory. This was a development-machine run, not a controlled
production Pod benchmark.

Configuration: 16 independent sessions, 32 turns, 8 active turns, and 100ms
artificial provider delay.

| Metric | Result |
| --- | ---: |
| Open 16 runtimes | 39.377ms |
| Load wall time | 437.498ms |
| Throughput | 73.143 turns/s |
| Maximum active turns | 8 |
| Admission p50 / p95 | 0.366 / 2.716ms |
| Turn p50 / p95 | 104.728 / 120.576ms |
| Snapshot read p50 / p95 | 0.113 / 0.391ms |
| SQLite schema probe p50 / p95 | 0.011 / 0.037ms |
| Event-loop samples | 19 |
| Event-loop p50 / p95 / max | 20.906 / 22.282 / 29.508ms |
| Start / peak RSS | 261.984 / 274.578MiB |
| Peak heap used | 87.480MiB |
| Close 16 runtimes | 18.793ms |
| Post-SIGKILL reopen/recovery | 2.659ms |
| Recovery parent provider calls / user messages | 1 / 1 |

These numbers describe this faux workload only. The artificial 100ms response
delay dominates turn latency and determines most of the theoretical concurrency
throughput. Percentiles from 32 turns and one recovery are smoke-scale evidence,
not statistically stable production SLOs.

## What this does not size

This harness currently excludes HTTP/SSE, Better Auth and PostgreSQL advisory
locks, tenant catalog/configuration, L1/L2/L3 work, OCR, channels, attachments,
real provider streaming, network variance, and production CPU limits. It opens
minimal runtimes without Inno's tool groups. Therefore this baseline alone must
not be used to promise a Pod count, a savings percentage, or a per-user memory
allowance.

Before choosing shard sizes, run both this runtime matrix and an HTTP-level
multi-tenant matrix inside the target container/Pod limits. Vary active runs,
history size, enabled tools, and realistic delayed streaming responses; record
RSS, CPU throttling, event-loop lag, SQLite latency, error rate, and full
supervised recovery time. Keep each durable session on one owner throughout the
test. Never create active-active SQLite owners to increase benchmark throughput.
