# Kubernetes HTTP-Request Autoscaling with KEDA, Prometheus & Grafana

A hands-on DevOps reference project demonstrating **event-driven pod autoscaling**
based on live HTTP request metrics, using **KEDA** on top of Kubernetes **HPA**,
with full observability via **Prometheus** and **Grafana**.

Designed for local study, single-VM R&D, and as a template for production-grade
autoscaling setups.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Cluster Setup](#1-cluster-setup)
4. [Clone the Application Repo](#2-clone-the-application-repo)
5. [Monitoring Stack Setup](#3-monitoring-stack-setup)
6. [Deploy the Application](#4-deploy-the-application)
7. [Install KEDA](#5-install-keda)
8. [Load Testing](#6-load-testing)
9. [Observe Autoscaling in Real Time](#7-observe-autoscaling-in-real-time)
10. [GPU Inference Autoscaling (Optional)](#8-gpu-inference-autoscaling-optional)
11. [Why KEDA? (Deep Dive)](#why-keda-deep-dive)
12. [Cost Benefit of This Architecture](#cost-benefit-of-this-architecture)
13. [Resource Utilization](#resource-utilization)
14. [Why This Matters for Production](#why-this-matters-for-production)
15. [Study Notes / Learning Path](#study-notes--learning-path)
16. [Resources & References](#resources--references)
17. [Troubleshooting](#troubleshooting)

---

## Architecture

```
                    Internet
                        │
                  Traefik Ingress
                        │
                 Node.js Application
                        │
                  /metrics endpoint
                        │
                  ServiceMonitor
                        │
                  Prometheus
                        │
      ┌─────────────────┴──────────────────┐
      │                                     │
   Grafana                            Prometheus Adapter
      │                                     │
      ▼                                     ▼
  Dashboards                              KEDA
                                            │
                                       ScaledObject
                                            │
                                       HPA (managed by KEDA)
                                            │
                                        Deployment
                                            │
                                           Pods
```

**Flow summary:**

- Traffic hits the app through the Traefik ingress controller.
- The Node.js app exposes an HTTP `/metrics` endpoint (request count, latency, etc.) in Prometheus format.
- A `ServiceMonitor` tells Prometheus to scrape that endpoint.
- Prometheus stores the time-series data; Grafana visualizes it via dashboards.
- KEDA queries Prometheus on an interval, evaluates the `ScaledObject` trigger (e.g. requests/sec), and creates/updates a native Kubernetes `HPA` object under the hood.
- The HPA scales the `Deployment` replica count up or down, and pods are added/removed accordingly.

---

## Prerequisites

- A local Kubernetes cluster: **Ubuntu** (bare-metal/VM) or **WSL2**, running Docker + k3s.
- `kubectl` and `helm` installed and configured against the cluster.
- Internet access to pull Helm charts and container images.

### 1. Cluster Setup

Download and run the cluster bootstrap script:

```bash
wget https://raw.githubusercontent.com/sajedul5/devops/main/setup-docker-k3s.sh
chmod +x setup-docker-k3s.sh
./setup-docker-k3s.sh
```

> Script repo reference: https://github.com/sajedul5/devops/blob/main/setup-docker-k3s.sh

Verify the cluster is healthy:

```bash
docker ps
kubectl get ns
kubectl get node
```

---

## 2. Clone the Application Repo

```bash
git clone https://github.com/sajedul5/kubernetes-http-request-hpa.git
cd kubernetes-http-request-hpa
```

---

## 3. Monitoring Stack Setup

### Add Helm Repositories

```bash
# install Helm first if it's not already available
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

### Install kube-prometheus-stack

```bash
kubectl create namespace monitoring

helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values monitoring/prometheus-values.yaml
```

This single chart installs Prometheus, Alertmanager, Grafana, node-exporter,
kube-state-metrics, and the CRDs (`ServiceMonitor`, `PodMonitor`, etc.) needed
for KEDA and the app to be scraped automatically.

### Expose via Ingress

```bash
kubectl apply -f monitoring/prometheus-ingress.yaml
kubectl apply -f monitoring/grafana-ingress.yaml

kubectl get ingress -n monitoring
```

---

## 4. Deploy the Application

```bash
kubectl apply -f kubernetes/app/

kubectl get all -n http-request-hpa
kubectl get pods -n http-request-hpa
```

---

## 5. Install KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda --namespace keda --create-namespace
```

Apply the `ScaledObject` that defines the scaling trigger (Prometheus query
on HTTP requests per second):

```bash
kubectl apply -f keda/scaledobject.yaml
```

Verify:

```bash
kubectl get pods -n keda
kubectl get hpa -n http-request-hpa
kubectl get pods -n http-request-hpa
```

Once the `ScaledObject` is applied, KEDA automatically creates and manages a
standard Kubernetes `HPA` resource for you — you don't write the HPA by hand.

---

## 6. Load Testing

### Install k6

```bash
sudo apt update && sudo apt install -y curl gnupg ca-certificates
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list >/dev/null
sudo apt update && sudo apt install -y k6

k6 version
```

### Run the Load Test

```bash
k6 run loadtest/k6.js
```

---

## 7. Observe Autoscaling in Real Time

Open **two terminals** alongside the running load test:

```bash
# Terminal 1 — watch pods scale live
kubectl get pods -n http-request-hpa -w

# Terminal 2 — periodic snapshot
kubectl get pods -n http-request-hpa
```

Also open the **Grafana** dashboard (via the ingress URL configured earlier)
to watch request-rate, replica count, and resource usage graphs update in
real time, and check **Prometheus** directly to confirm the raw metric KEDA
is querying.

---

## 8. GPU Inference Autoscaling (Optional)

The same pattern — scale on the real demand signal from Prometheus — applied
to GPU inference (LLM / ASR / TTS model serving). Here every replica costs a
whole GPU, so the cost benefit is much larger than for the CPU app above.

Full guide and manifests: [kubernetes/gpu/README.md](kubernetes/gpu/README.md)

### Architecture

```
k6 Job ─► Service vllm:8000 ─► vLLM pods (1 GPU each)
                                   │  vllm:num_requests_running / vllm:num_requests_waiting
                              ServiceMonitor ─► Prometheus ◄── KEDA (every 15s)
                                                                 │
                     (running + waiting) / 12 per replica  (+ cron pre-warm)
                                                                 │
                                         HPA ─► more vLLM pods ─► Pending (no free GPU)
                                                                 │
                         Cluster Autoscaler adds a GPU node from the pool (min 0)
```

Two levels of autoscaling work together:

1. **Pod level** — KEDA adds/removes inference pods based on concurrent requests.
2. **Node level** — when a new pod can't find a free GPU it goes `Pending`, and
   the Cluster Autoscaler (or Karpenter on EKS) adds a GPU node. When pods scale
   down, empty GPU nodes are removed. **This is where the money is saved.**

### Two ways to run it

| | Local (`kubernetes/gpu/local/`) | GKE (`kubernetes/gpu/gke/`) |
|---|---|---|
| Cluster | The k3s cluster from section 1 | GKE + spot NVIDIA L4 node pool |
| GPU | Fake: node advertises `nvidia.com/gpu` | Real L4 |
| Server | Mock vLLM (same metric names) | Real vLLM + Qwen2.5-0.5B |
| Cost | Free | A few dollars per lab session |
| You learn | KEDA queue logic, GPU scheduling, GPU exhaustion | Node autoscaling, real cold start, real $ numbers |

**Local (no GPU needed):**

```bash
# make the node look like a GPU node (4 fake GPUs)
./kubernetes/gpu/local/fake-gpu-node.sh

kubectl apply -f kubernetes/gpu/namespace.yaml
kubectl apply -f kubernetes/gpu/local/mock-vllm.yaml
kubectl apply -f kubernetes/gpu/service.yaml -f kubernetes/gpu/servicemonitor.yaml
kubectl apply -f kubernetes/gpu/scaledobject.yaml

# load test runs inside the cluster so traffic spreads over all pods
kubectl create configmap k6-llm -n llm --from-file=loadtest/k6-llm.js
kubectl apply -f kubernetes/gpu/loadtest-job.yaml

kubectl get pods -n llm -w
```

Expected: replicas grow with load (~40 users → 4 pods), and **pods 5–6 stay
`Pending` with `Insufficient nvidia.com/gpu`** — the GPU-exhaustion event that,
on a cloud cluster, triggers a new GPU node.

**GKE (real GPUs):**

```bash
./kubernetes/gpu/gke/create-cluster.sh        # check GPU quota first
# install kube-prometheus-stack + KEDA (sections 3 and 5)
kubectl apply -f kubernetes/gpu/namespace.yaml
kubectl apply -f kubernetes/gpu/gke/vllm.yaml
kubectl apply -f kubernetes/gpu/service.yaml -f kubernetes/gpu/servicemonitor.yaml
kubectl apply -f kubernetes/gpu/scaledobject.yaml
kubectl create configmap k6-llm -n llm --from-file=loadtest/k6-llm.js
kubectl apply -f kubernetes/gpu/loadtest-job.yaml

./kubernetes/gpu/gke/delete-cluster.sh        # ALWAYS clean up after the lab
```

### Choosing the GPU scaling metric

| Metric | Use for scaling? |
|---|---|
| `DCGM_FI_DEV_GPU_UTIL` (GPU utilization) | ❌ Shows ~100% whenever any kernel runs, even at low throughput |
| `DCGM_FI_DEV_FB_USED` (GPU memory) | ❌ Constant once the model is loaded |
| `vllm:num_requests_waiting` only | ⚠️ Reads 0 once the queue drains → scales down busy pods → oscillation |
| `vllm:num_requests_running + vllm:num_requests_waiting` | ✅ Total demand — used in this repo |
| Queue depth (Kafka / Redis / RabbitMQ) | ✅ Best for async / batch jobs |

### GPU cold start

| Step | Typical time |
|---|---|
| KEDA detects demand → pod Pending | 30–60s |
| New GPU node provisioned | 1–3 min |
| NVIDIA driver / device plugin ready | 1–2 min |
| Pull inference image (10–20 GB) | 2–6 min |
| Load model weights into GPU | 0.5–5 min |
| **Total, zero to serving** | **~5–15 min** |

Because of this, the ScaledObject keeps `minReplicaCount: 1`, pre-warms with a
cron trigger during office hours, and scales down slowly. The optional
`gke/gpu-placeholder.yaml` keeps a spare GPU node warm with a low-priority pod
that is evicted the moment a real pod needs the GPU.

### GPU cost benefit (example)

Approximate on-demand NVIDIA L4 price ≈ $0.85/hr, spot ≈ 30–40% of that —
check current prices for your region. Daily load: 8 GPUs for 6 h, 4 GPUs for
8 h, 1 GPU for 10 h.

| Strategy | GPU-hours/day | ≈ $/month | Saving |
|---|---|---|---|
| Static, sized for peak (8 × 24 h) | 192 | $4,900 | — |
| KEDA + node autoscaling (+10% buffer) | ~99 | $2,520 | ~48% |
| Same, burst above 2 GPUs on spot | ~99 | $1,550 | ~68% |
| Dev/staging GPU: office hours only vs 24×7 | 220 vs 720 per month | $190 vs $610 | ~70% |

Autoscaling GPUs pays off when peak load is more than ~1.5× the average, or
when an environment is idle more than ~30% of the time. For production, keep
the warm floor on on-demand GPUs and burst on spot.

---

## Why KEDA? (Deep Dive)

### The limitation of vanilla HPA

The stock Kubernetes **Horizontal Pod Autoscaler (HPA)** natively scales on
CPU and memory only (via `metrics-server`). Custom metrics require the
**Prometheus Adapter** and a lot of manual `APIService` / custom metrics API
wiring — brittle, hard to maintain, and limited to metrics exposed through
that adapter.

### What KEDA adds

- **Event-driven scaling**: KEDA can scale based on 60+ external sources —
  Prometheus queries, message queue depth (RabbitMQ, Kafka, SQS), cron
  schedules, HTTP request rate, database queue length, and more — not just
  CPU/memory.
- **Scale-to-zero**: Unlike vanilla HPA (minimum 1 replica), KEDA can scale a
  deployment down to **zero pods** when there's no traffic/events, and scale
  back up on the first event. This is the single biggest cost lever in this
  architecture.
- **Simplicity**: You describe *what* to scale on (`ScaledObject` CRD) and
  KEDA manages the underlying HPA object for you — no manual custom-metrics
  API plumbing.
- **Decoupled scalers**: Each workload can scale on a different signal
  (queue depth for a worker, HTTP RPS for an API, cron for a batch job) using
  the same operator.
- **Native HPA compatibility**: Because KEDA still produces a standard HPA
  under the hood, it plays well with existing tooling, dashboards, and
  cluster-autoscaler integrations.

### KEDA vs Vanilla HPA — Summary

| Capability                     | Vanilla HPA              | KEDA                                   |
|---------------------------------|---------------------------|------------------------------------------|
| CPU/Memory scaling               | ✅                         | ✅ (via HPA it creates)                  |
| Custom metrics (e.g. RPS)        | ⚠️ Manual adapter setup   | ✅ Built-in scalers                      |
| External event sources (queues)  | ❌                         | ✅ 60+ scalers                           |
| Scale-to-zero                    | ❌ (min 1 replica)         | ✅                                       |
| Setup complexity                 | Low (basic), High (custom)| Low (declarative `ScaledObject`)         |
| Multiple trigger types per app   | ❌                         | ✅ (combine triggers)                    |

---

## Cost Benefit of This Architecture

1. **Scale-to-zero for idle workloads** — Dev/staging services, batch
   consumers, or low-traffic APIs run 0 pods when idle instead of a
   permanently reserved baseline. On cloud infra (EKS/GKE/AKS), fewer
   running pods directly means fewer nodes needed, which means lower
   compute bill.
2. **Right-sized scale-out** — Because scaling reacts to the *actual*
   business signal (HTTP RPS) rather than a proxy metric (CPU), you avoid
   both over-provisioning (paying for idle headroom) and under-provisioning
   (latency/errors during traffic spikes).
3. **Cluster Autoscaler synergy** — When KEDA scales pods down to zero or a
   minimum, unused nodes become eligible for removal by the Kubernetes
   Cluster Autoscaler / Karpenter, compounding savings at the node level,
   not just the pod level.
4. **Fewer wasted reserved instances** — Predictable scale-to-zero behavior
   lets you rely more on spot/preemptible capacity for bursty workloads
   instead of over-provisioning reserved capacity for peak load year-round.
5. **Observability-driven decisions** — Because Prometheus/Grafana are part
   of this stack from day one, you get real utilization data to right-size
   requests/limits, instead of guessing.

---

## Resource Utilization

- **Before (static replicas or CPU-based HPA)**: Pods are often sized for
  peak load and stay running at that count even during low-traffic hours,
  leading to poor average CPU/memory utilization (commonly under 20–30%
  outside peak).
- **After (KEDA + Prometheus RPS scaling)**: Replica count tracks the actual
  request curve, so utilization stays closer to the target band you define
  in the `ScaledObject`, and idle periods free up cluster capacity for other
  workloads instead of sitting reserved and unused.
- **Metrics-driven tuning**: Grafana dashboards built on the same Prometheus
  data used for scaling let you continuously tune `minReplicaCount`,
  `maxReplicaCount`, cooldown periods, and target thresholds based on real
  traffic patterns rather than guesswork.

---

## Why This Matters for Production

- **Traffic is rarely flat.** Real-world HTTP services see diurnal patterns,
  marketing-driven spikes, and regional traffic waves. Request-rate-based
  autoscaling responds to the thing that actually causes user-facing
  latency, not an indirect proxy like CPU.
- **SLA protection**: Faster, metric-accurate scale-out reduces the chance
  of request queuing/timeouts during sudden spikes (flash sales, viral
  posts, incident-driven traffic).
- **Operational consistency**: A single `ScaledObject` pattern can be reused
  across many services/teams, standardizing how autoscaling is configured
  cluster-wide instead of each team hand-rolling custom-metrics adapters.
- **Full-stack observability is a production requirement, not a nice-to-have.**
  Bundling Prometheus + Grafana with the scaler means you can see *why* a
  scaling event happened, correlate it with error rates/latency, and debug
  incidents — not just watch replica counts change blindly.
- **Battle-tested in the ecosystem**: KEDA is a CNCF graduated project and is
  commonly used in production alongside standard HPA/VPA/Cluster Autoscaler,
  so this pattern maps directly onto real managed-Kubernetes environments
  (EKS, AKS, GKE), not just local k3s.

---

## Study Notes / Learning Path

This repo is structured so it can be run either as:

- **Local single-VM / WSL R&D environment** — a full loop (cluster → app →
  monitoring → autoscaler → load test) on one machine, useful for learning
  the mechanics of event-driven autoscaling without cloud cost.
- **A DevOps self-study reference** — each numbered section above maps to a
  concept worth understanding in isolation:
  1. Cluster bootstrapping (Docker + k3s)
  2. Helm chart-based installs
  3. Prometheus Operator model (`ServiceMonitor`/`PodMonitor` CRDs)
  4. Ingress routing (Traefik)
  5. Custom-metrics-based autoscaling (KEDA `ScaledObject` → HPA)
  6. Load testing methodology (k6)
  7. Reading autoscaling behavior live via `kubectl -w` + Grafana

Suggested next steps for deeper study:
- Swap the Prometheus scaler for a queue-based scaler (RabbitMQ/Kafka) to
  see KEDA's event-driven model outside the HTTP use case.
- Add `minReplicaCount: 0` to observe true scale-to-zero and cold-start
  latency trade-offs.
- Pair this with Cluster Autoscaler in a cloud-managed cluster to observe
  node-level cost savings, not just pod-level.
- Apply the same pattern to GPU inference with a GPU node pool — see
  [kubernetes/gpu/README.md](kubernetes/gpu/README.md) (local fake-GPU mode
  or GKE with real L4 GPUs).

---

## Resources & References

### KEDA (event-driven autoscaling)
- Official docs: https://keda.sh/docs/latest/
- Concepts (ScaledObject, ScaledJob, scalers): https://keda.sh/docs/latest/concepts/
- Full scaler list (Prometheus, Kafka, RabbitMQ, SQS, cron, etc.): https://keda.sh/docs/latest/scalers/
- GitHub repo: https://github.com/kedacore/keda
- CNCF project page (graduated status): https://www.cncf.io/projects/keda/

### Kubernetes Autoscaling (core concepts)
- Horizontal Pod Autoscaler: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
- HPA walkthrough: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/
- Cluster Autoscaler: https://github.com/kubernetes/autoscaler/tree/master/cluster-autoscaler
- Karpenter (alternative node autoscaler, cloud-native): https://karpenter.sh/

### Prometheus & Monitoring
- Prometheus docs: https://prometheus.io/docs/introduction/overview/
- PromQL basics: https://prometheus.io/docs/prometheus/latest/querying/basics/
- kube-prometheus-stack Helm chart: https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack
- Prometheus Operator (ServiceMonitor/PodMonitor CRDs): https://prometheus-operator.dev/
- Grafana docs: https://grafana.com/docs/grafana/latest/
- Grafana + Prometheus data source setup: https://grafana.com/docs/grafana/latest/datasources/prometheus/

### Cluster Tooling
- k3s docs: https://docs.k3s.io/
- Helm docs: https://helm.sh/docs/
- Traefik Kubernetes Ingress: https://doc.traefik.io/traefik/providers/kubernetes-ingress/
- kubectl cheat sheet: https://kubernetes.io/docs/reference/kubectl/cheatsheet/

### Load Testing
- k6 docs: https://grafana.com/docs/k6/latest/
- k6 + Kubernetes/Prometheus integration guide: https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/

### GPU Workloads
- Kubernetes GPU scheduling: https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/
- Advertise extended resources (how the fake GPU works): https://kubernetes.io/docs/tasks/administer-cluster/extended-resource-node/
- GKE GPUs: https://cloud.google.com/kubernetes-engine/docs/how-to/gpus
- NVIDIA GPU Operator: https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/
- NVIDIA DCGM exporter: https://github.com/NVIDIA/dcgm-exporter
- vLLM production metrics: https://docs.vllm.ai/en/latest/serving/metrics.html
- KEDA cron scaler: https://keda.sh/docs/latest/scalers/cron/

### Broader Reading (cost/production practices)
- Kubernetes cost optimization guide (FinOps Foundation): https://www.finops.org/framework/
- CNCF cloud native landscape (for exploring adjacent tools): https://landscape.cncf.io/
- "Scaling Kubernetes to zero" — KEDA blog/case studies: https://keda.sh/blog/

## Troubleshooting

- **`kubectl get hpa` shows no metrics / `<unknown>` targets**: Confirm the
  `ServiceMonitor` for the app exists and Prometheus is actually scraping
  `/metrics` (check the Prometheus **Targets** page).
- **KEDA pods not starting**: Check `kubectl logs -n keda deploy/keda-operator`
  and confirm the `keda` namespace has network access to Prometheus.
- **Ingress not reachable**: Confirm Traefik is running (`kubectl get pods -n kube-system`
  on k3s) and that the ingress hostnames resolve locally (`/etc/hosts` entry
  or `nip.io`-style DNS for local testing).
- **Load test shows no scaling**: Double check the `ScaledObject`'s
  `triggers.metadata.query` against what's actually visible in the
  Prometheus UI for the same PromQL expression.
- **GPU pods stuck `Pending` (local)**: Run `kubectl describe node` and check
  that `Allocatable` shows `nvidia.com/gpu` and the node has the
  `gpu-node=true` label; re-run `kubernetes/gpu/local/fake-gpu-node.sh` if not.
  Pending pods beyond the fake GPU count are expected.
- **GPU pods stuck `Pending` (GKE)**: Check `kubectl get events -n llm` for
  `NotTriggerScaleUp` — usually GPU quota is 0 in the region or spot L4
  capacity is unavailable in the zone; request quota or try another zone.
- **vLLM pod restarts during startup**: The model download/load is slower than
  the `startupProbe` allows; increase `failureThreshold` in `gke/vllm.yaml`.