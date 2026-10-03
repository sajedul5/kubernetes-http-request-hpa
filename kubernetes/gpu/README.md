# GPU Inference Autoscaling (KEDA + GPU Node Pool)

The same pattern as the main project — scale on the real demand signal from
Prometheus — applied to GPU inference, where each replica costs a GPU and the
cost benefit is much larger.

```
k6 Job ─► Service vllm:8000 ─► vLLM pods (1 GPU each)
                                   │  vllm:num_requests_running / vllm:num_requests_waiting
                              ServiceMonitor ─► Prometheus ◄── KEDA (every 15s)
                                                                 │
                     running + waiting / 12 per replica  (+ cron pre-warm)
                                                                 │
                                         HPA ─► more vLLM pods ─► Pending (no free GPU)
                                                                 │
                                    Cluster Autoscaler adds a GPU node (pool min 0)
```

Two ways to run it:

| | `local/` | `gke/` |
|---|---|---|
| Cluster | k3s / kind / minikube (the main README setup) | GKE + spot L4 node pool |
| GPU | Fake: node advertises `nvidia.com/gpu` | Real NVIDIA L4 |
| Server | Mock vLLM (Python, same metric names) | Real vLLM + Qwen2.5-0.5B |
| Cost | Free | ~$0.25–0.35/hr per spot L4 node + ~$0.15/hr base node (check current prices) |
| Learn | KEDA queue logic, GPU scheduling, GPU exhaustion | Node autoscaling, real cold start, real $ numbers |

## Layout

```
kubernetes/gpu/
├── namespace.yaml          # llm namespace
├── service.yaml            # shared: Service vllm:8000
├── servicemonitor.yaml     # shared: Prometheus scrapes /metrics
├── scaledobject.yaml       # shared: KEDA trigger (concurrency + cron)
├── loadtest-job.yaml       # in-cluster k6 Job (runs loadtest/k6-llm.js)
├── local/
│   ├── fake-gpu-node.sh    # advertise fake GPUs on a local node
│   └── mock-vllm.yaml      # mock vLLM server (ConfigMap + Deployment)
└── gke/
    ├── create-cluster.sh   # GKE + spot L4 pool (autoscale 0..3)
    ├── vllm.yaml           # real vLLM Deployment
    ├── gpu-placeholder.yaml# optional: keep a spare GPU node warm
    └── delete-cluster.sh   # ALWAYS run after the lab
```

## Prerequisites

Prometheus (kube-prometheus-stack) and KEDA installed as in the main
[README](../../README.md) sections 3 and 5. On GKE install them the same way
after `create-cluster.sh`.

---

## Option A — Local (no GPU)

```bash
# 1. Make the node look like a GPU node (4 fake GPUs)
./kubernetes/gpu/local/fake-gpu-node.sh

# 2. Deploy the mock vLLM + shared manifests
kubectl apply -f kubernetes/gpu/namespace.yaml
kubectl apply -f kubernetes/gpu/local/mock-vllm.yaml
kubectl apply -f kubernetes/gpu/service.yaml -f kubernetes/gpu/servicemonitor.yaml
kubectl apply -f kubernetes/gpu/scaledobject.yaml

# 3. Load test
kubectl create configmap k6-llm -n llm --from-file=loadtest/k6-llm.js
kubectl apply -f kubernetes/gpu/loadtest-job.yaml
```

What to observe:

- Replicas grow with concurrency: ~40 VUs → 4 pods, ~80 VUs → 6 pods.
- **Only 4 pods run, pods 5–6 stay `Pending`** with
  `Insufficient nvidia.com/gpu`. This is GPU exhaustion — on a cloud cluster
  this is exactly the event that makes the Cluster Autoscaler add a GPU node.
- Requests queue (`vllm:num_requests_waiting` rises) while pods are Pending —
  this is what users feel during a cold start.

Undo: `./kubernetes/gpu/local/fake-gpu-node.sh --remove`

---

## Option B — GKE with real GPUs

```bash
# 1. Cluster + spot L4 pool (min 0). Check GPU quota first.
./kubernetes/gpu/gke/create-cluster.sh

# 2. Install kube-prometheus-stack + KEDA (main README, sections 3 and 5)

# 3. Deploy vLLM + shared manifests
kubectl apply -f kubernetes/gpu/namespace.yaml
kubectl apply -f kubernetes/gpu/gke/vllm.yaml
kubectl apply -f kubernetes/gpu/service.yaml -f kubernetes/gpu/servicemonitor.yaml
kubectl apply -f kubernetes/gpu/scaledobject.yaml

# 4. Load test
kubectl create configmap k6-llm -n llm --from-file=loadtest/k6-llm.js
kubectl apply -f kubernetes/gpu/loadtest-job.yaml

# 5. ALWAYS clean up
./kubernetes/gpu/gke/delete-cluster.sh
```

What to measure (write the numbers down — this is the R&D output):

| Measurement | How |
|---|---|
| Cold-start breakdown | `kubectl get events -n llm -w` + `kubectl get nodes -w`: pod Pending → node Ready → image pulled → pod Ready |
| Scale-up reaction | Time from queue rising (Grafana) to new replica Ready |
| Cost per 1k requests | GPU node-hours × price ÷ `vllm:request_success_total` |
| Static vs autoscaled | Same test with `minReplicaCount: 6` vs the default |
| Placeholder effect | Re-run with `kubectl apply -f kubernetes/gpu/gke/gpu-placeholder.yaml` |

---

## Watch it live

```bash
kubectl get scaledobject,hpa -n llm
kubectl get pods -n llm -o wide -w
kubectl get nodes -L cloud.google.com/gke-accelerator -w   # GKE
```

Useful PromQL (Prometheus UI / Grafana):

```promql
sum(vllm:num_requests_running{namespace="llm"})            # busy slots
sum(vllm:num_requests_waiting{namespace="llm"})            # queue = users waiting
rate(vllm:e2e_request_latency_seconds_sum[1m])
  / rate(vllm:e2e_request_latency_seconds_count[1m])       # avg latency
kube_deployment_status_replicas{namespace="llm"}           # replicas
```

---

## Design notes

- **Why not scale on GPU utilization?** `DCGM_FI_DEV_GPU_UTIL` reads ~100%
  whenever any kernel is active, even at low throughput, and GPU memory is
  constant once the model is loaded. Neither reflects user demand.
- **Why running + waiting, not just waiting?** Queue-only scaling reads 0 as
  soon as the queue drains, so the HPA would remove pods that are still
  fully busy, the queue comes back, and replicas oscillate.
- **Threshold (12) vs `--max-num-seqs` (16):** scale out at ~75% of a pod's
  concurrency limit so the new pod is ready before the queue grows. Tune both
  from a load test of your real model.
- **`minReplicaCount: 1`:** a GPU cold start is minutes (node + driver +
  image + model load). Use `0` only for dev/staging.
- **Slow scale-down (15 min window, 1 pod / 5 min):** removing a GPU pod is
  cheap, bringing it back is slow — avoid flapping.
- **Cron trigger:** KEDA uses the highest of all triggers, so during office
  hours there are at least 2 replicas before traffic arrives.
- **Spot:** ~60–70% cheaper but can be preempted with ~30s notice. For
  production, keep the warm floor on an on-demand pool and burst on spot.
