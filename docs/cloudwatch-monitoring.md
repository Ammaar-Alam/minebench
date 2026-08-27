# CloudWatch Metrics & Architecture

MineBench publishes asynchronous telemetry to Amazon CloudWatch to monitor generation workloads, throughput, latency distributions, worker health, and queue latency.

```mermaid
flowchart LR
    subgraph Compute["Generation Compute (AWS Lightsail)"]
        Worker["Worker Process"] -->|EMF JSON| Stdout["stdout / Logs"]
        Stdout -->|Tail & Parse| Agent["CloudWatch Agent"]
        Agent -->|OS Telemetry| OS["RAM & CPU Stats"]
    end

    subgraph Web["Streaming Generation (Vercel)"]
        Route["Generate Route"] -->|OIDC + PutMetricData| Metrics
    end

    subgraph CloudWatch["Amazon CloudWatch"]
        Agent -->|Async Flush| Metrics["Metrics Engine<br/>(MineBench/Production)"]
        Metrics --> Dashboards["Unified Dashboard"]
        Metrics --> Alarms["CloudWatch Alarms"]
    end

    Alarms -->|Trigger| SNS["Amazon SNS Topic"]
```

## Metrics Specification

All telemetry is emitted under the `MineBench/Production` namespace.

| Metric | Unit | Description |
| :--- | :--- | :--- |
| `GenerationsCount` | Count | Aggregate successful generation volume (Sum). |
| `GenerationDuration` | Milliseconds | Generation latency distribution (p50, p90, p95, p99, Min, Max). |
| `ActiveGenerations` | Count | In-flight generation concurrency gauge. |
| `WorkerAcceptingJobs` | Count | `1` while the worker accepts jobs and `0` while it drains. |
| `QueuedJobsCount` | Count | Count of generation jobs waiting in the queue. |
| `OldestQueuedJobAgeSeconds` | Seconds | Age of the oldest waiting job in queue. |
| `GenerationErrors` | Count | Count of failed generation attempts, tagged by error classification. |
| `mem_used_percent` | Percent | Host memory utilization percentage. |
| `disk_used_percent` | Percent | Host disk space utilization percentage. |
| `cpu_usage_idle` | Percent | Host idle CPU percentage. |

Worker heartbeats and queue health are emitted immediately at startup and every 30 seconds. They continue while active work drains after shutdown begins, so deploys remain visible. Missing `WorkerAcceptingJobs` data is an alarm condition rather than a healthy state.

Success, duration, and error events publish both an `Environment` aggregate for alarms and detailed model dimensions for dashboards. CloudWatch does not aggregate custom metrics across dimension sets automatically, so alarms must use the aggregate series.

## Vercel publishing

Production Vercel Functions can publish through a narrowly scoped AWS OIDC role. No long-lived AWS credentials are stored in Vercel. Publishing is disabled unless `MINEBENCH_CLOUDWATCH_ROLE_ARN` is present in the production environment. `MINEBENCH_CLOUDWATCH_REGION` defaults to `us-east-1`.

The IAM role may only call `cloudwatch:PutMetricData` when `cloudwatch:namespace` is `MineBench/Production`. Preview and development deployments never publish production metrics.
