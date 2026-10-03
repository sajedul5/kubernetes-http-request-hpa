# Kubernetes Autoscaling on HTTP Requests (KEDA + Prometheus + Grafana)

**In one sentence:** when more people use the app, Kubernetes starts more
copies (pods) of it automatically; when traffic drops, it removes them.

Most autoscaling looks at CPU. This project scales on **requests per second**
— the thing that actually makes users wait. It runs on one laptop or VM, so
you can learn the whole flow for free. An optional part shows the same idea
for **GPU workloads** (AI models), where it saves the most money.

| You will learn | Tool |
|---|---|
| Run a Kubernetes cluster on one machine | k3s |
| Collect and graph app metrics | Prometheus, Grafana |
| Scale pods on a custom metric | KEDA |
| Generate traffic and watch scaling live | k6 |
| Scale GPU (AI) workloads and their nodes | KEDA + GPU node pool |

---

## Contents

1. [How it works](#how-it-works)
2. [Repo layout](#repo-layout)
3. [Step-by-step setup](#step-by-step-setup)
4. [Watch it scale](#watch-it-scale)
5. [GPU autoscaling (optional)](#gpu-autoscaling-optional)
6. [Why KEDA?](#why-keda)
7. [Cost benefit](#cost-benefit)
8. [Troubleshooting](#troubleshooting)
9. [Next steps](#next-steps)
10. [Links](#links)

---

## How it works

```
 Users / k6 ──► Traefik (ingress) ──► Node.js app pods
                                          │  /metrics
                                          ▼
                                     Prometheus  ──►  Grafana (graphs)
                                          ▲
                                          │ asks every 30s:
                                          │ "how many requests per second?"
                                        KEDA
                                          │ creates and updates
                                          ▼
                                    HPA ──► adds / removes pods
```

1. The app counts every request and shows the numbers at `/metrics`.
2. Prometheus reads `/metrics` every 15 seconds.
3. KEDA asks Prometheus: *"how many requests per second right now?"*
4. KEDA's rule: **1 pod for every 20 requests/second**, minimum 2, maximum 10.
   - 50 req/s → 3 pods · 150 req/s → 8 pods · 500 req/s → 10 pods (max)
5. KEDA tells Kubernetes (via a standard HPA) how many pods to run.

**Scaling speed:** pods are added quickly (can double every 15s) and removed
slowly (after 5 quiet minutes, at most half per minute), so a short dip in
traffic doesn't kill pods you will need again.

---

## Repo layout

```
app/                          Node.js app (Express + prom-client), Dockerfile
kubernetes/
├── app/                      Namespace, Deployment, Service, Ingress, ServiceMonitor
├── keda/scaledobject.yaml    The scaling rule (requests/sec → pods)
├── monitoring/               Prometheus Helm values + ingresses for Prometheus/Grafana
└── gpu/                      Optional GPU autoscaling lab (see its own README)
loadtest/
├── k6.js                     Load test for the HTTP app
└── k6-llm.js                 Load test for the GPU / LLM lab
```

---

## Step-by-step setup

**You need:** Ubuntu (VM or bare metal) or WSL2, about 4 CPU and 8 GB RAM,
and internet access.

### Step 1 — Create the cluster

```bash
wget https://raw.githubusercontent.com/sajedul5/devops/main/setup-docker-k3s.sh
chmod +x setup-docker-k3s.sh
./setup-docker-k3s.sh
```

✅ Check: `kubectl get nodes` shows one node with status `Ready`.

### Step 2 — Get the code

```bash
git clone https://github.com/sajedul5/kubernetes-http-request-hpa.git
cd kubernetes-http-request-hpa
```

### Step 3 — Install Prometheus and Grafana

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring

helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values kubernetes/monitoring/prometheus-values.yaml
```

Open them in the browser via ingress. First change the hostnames in
`kubernetes/monitoring/*-ingress.yaml` to `grafana.<YOUR-IP>.nip.io` and
`prometheus.<YOUR-IP>.nip.io` ([nip.io](https://nip.io) turns any IP into a
free hostname).

```bash
kubectl apply -f kubernetes/monitoring/prometheus-ingress.yaml
kubectl apply -f kubernetes/monitoring/grafana-ingress.yaml
```

✅ Check: `kubectl get pods -n monitoring` — all pods `Running`.
Grafana login: `admin` / the password in `prometheus-values.yaml`
(**change it** before using this anywhere public).

### Step 4 — Deploy the app

Change the host in `kubernetes/app/ingress.yaml` to `app.<YOUR-IP>.nip.io`, then:

```bash
kubectl apply -f kubernetes/app/
```

✅ Check: `kubectl get pods -n http-request-hpa` shows 2 pods `Running`, and
`curl http://app.<YOUR-IP>.nip.io` returns `Hello from Kubernetes`.

### Step 5 — Install KEDA and the scaling rule

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace

kubectl apply -f kubernetes/keda/scaledobject.yaml
```

✅ Check: `kubectl get hpa -n http-request-hpa` shows an HPA created by KEDA,
with a number (not `<unknown>`) in the `TARGETS` column.

### Step 6 — Send traffic

Install k6:

```bash
sudo apt update && sudo apt install -y curl gnupg ca-certificates
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list >/dev/null
sudo apt update && sudo apt install -y k6
```

Change the URL in `loadtest/k6.js` to your app's address, then:

```bash
k6 run loadtest/k6.js
```

The test runs for 8 minutes: warm up → medium → high → back to zero users.

---

## Watch it scale

Open two more terminals while k6 runs:

```bash
kubectl get pods -n http-request-hpa -w     # pods appear and disappear live
kubectl get hpa  -n http-request-hpa -w     # current req/s vs target, replica count
```

| Time | What you should see |
|---|---|
| 0–2 min (warm up) | Requests rise, pods go from 2 to more |
| 2–6 min (high load) | Pods reach the maximum of 10 |
| 6–8 min (load drops) | Pods stay for ~5 min (by design) |
| After the test | Pods slowly go back to 2 |

In **Grafana**, graph the same number KEDA uses:

```promql
sum(rate(http_requests_total{job="nodejs-service"}[1m]))
```

---

## GPU autoscaling (optional)

The same idea for AI model servers (LLM, speech-to-text, text-to-speech).
Each pod needs one whole GPU, so it matters much more: GPUs cost
~$1–4 per hour each, while a small CPU pod costs almost nothing.

```
More requests ─► KEDA adds a model pod ─► no free GPU, pod waits (Pending)
                                              │
                         Cluster Autoscaler adds a GPU machine (node)
Fewer requests ─► KEDA removes pods ─► empty GPU machine is removed ─► you stop paying
```

**Two ways to try it:**

| | Local — free | Cloud (GKE) — real GPUs |
|---|---|---|
| GPU | Fake (Kubernetes is told the node has 4 GPUs) | Real NVIDIA L4 |
| Model server | Small mock server that behaves like vLLM | Real vLLM + a small model |
| Cost | $0 | A few dollars per session |
| Good for learning | The scaling logic, GPU scheduling | Real start-up times and real cost |

Quick start (local):

```bash
./kubernetes/gpu/local/fake-gpu-node.sh                 # make the node look like it has 4 GPUs
kubectl apply -f kubernetes/gpu/namespace.yaml
kubectl apply -f kubernetes/gpu/local/mock-vllm.yaml
kubectl apply -f kubernetes/gpu/service.yaml -f kubernetes/gpu/servicemonitor.yaml
kubectl apply -f kubernetes/gpu/scaledobject.yaml

kubectl create configmap k6-llm -n llm --from-file=loadtest/k6-llm.js
kubectl apply -f kubernetes/gpu/loadtest-job.yaml       # load test runs inside the cluster
kubectl get pods -n llm -w
```

✅ Expected: pods grow with the load, and **pods 5 and 6 stay `Pending`**
because there are only 4 GPUs. On a cloud cluster, this is exactly the moment
a new GPU machine is added.

Full guide, GKE steps and cleanup: **[kubernetes/gpu/README.md](kubernetes/gpu/README.md)**

### Three things to know about GPU scaling

1. **Don't scale on "GPU utilization".** It shows ~100% even when the GPU is
   barely working. Scale on **requests in progress + requests waiting**
   instead (that's what this repo does).
2. **Starting a GPU pod is slow: about 5–15 minutes** (new machine + driver +
   large image + loading the model). So keep at least 1 pod always running in
   production and pre-start pods before busy hours (this repo uses a KEDA
   cron trigger for 9:00–21:00 on weekdays).
3. **Spot GPUs are ~60–70% cheaper** but the cloud can take them back with
   30 seconds' notice. Run the always-on pod on normal GPUs and the extra
   pods on spot.

---

## Why KEDA?

Plain Kubernetes HPA only scales on CPU and memory out of the box. Scaling on
anything else (like requests/second) needs a lot of extra setup. KEDA makes
it a single small YAML file.

| | Plain HPA | KEDA |
|---|---|---|
| Scale on CPU / memory | ✅ | ✅ |
| Scale on requests/sec, queue length, etc. | ⚠️ Complex extra setup | ✅ One YAML file |
| Built-in sources (Prometheus, Kafka, RabbitMQ, SQS, cron …) | ❌ | ✅ 60+ |
| Scale down to 0 pods | ❌ (minimum 1) | ✅ |
| Combine several rules | ❌ | ✅ |

KEDA still creates a normal HPA behind the scenes, so all standard
Kubernetes tools keep working. It is a CNCF graduated project and runs on any
Kubernetes (k3s, EKS, GKE, AKS).

> **About scale-to-zero:** this demo keeps at least 2 pods. Setting
> `minReplicaCount: 0` here would **not** work well: the metric comes from the
> app's own pods, so with 0 pods there is nothing to measure and nothing
> wakes the app up. For real scale-to-zero, measure traffic at the ingress
> (Traefik metrics) or use the
> [KEDA HTTP Add-on](https://github.com/kedacore/http-add-on).

---

## Cost benefit

**Where the money is saved:** fewer pods → fewer machines (nodes) → smaller
cloud bill. Pods alone cost nothing; the saving comes when the cluster
autoscaler (or Karpenter) can **remove machines**. On a single local machine
there is no saving — locally this project is for learning.

| Situation | Without autoscaling | With autoscaling |
|---|---|---|
| Normal day/night traffic | Sized for peak, mostly idle (often <30% used) | Pods follow traffic |
| Sudden traffic spike | Slow responses or errors | More pods within ~1–2 min |
| Dev / test environments | Running 24×7 | Can scale down outside working hours |

**GPU example** (one L4 GPU ≈ $0.85/hour on-demand, spot ≈ 30–40% of that;
check current prices). Daily load: 8 GPUs for 6 h, 4 GPUs for 8 h, 1 GPU for 10 h.

| Setup | GPU-hours per day | ≈ Cost per month | Saving |
|---|---|---|---|
| Always 8 GPUs (sized for peak) | 192 | $4,900 | — |
| Autoscaling (+10% buffer) | ~99 | $2,520 | **~48%** |
| Autoscaling, extra GPUs on spot | ~99 | $1,550 | **~68%** |
| Dev GPU: working hours only vs 24×7 | 220 vs 720 per month | $190 vs $610 | **~70%** |

**Rule of thumb:** autoscaling is worth it when peak traffic is more than
~1.5× the average, or when an environment sits idle more than ~30% of the time.

**The trade-offs:** Prometheus + Grafana need ~1–2 CPU and 2–4 GB RAM; new
pods take time to start (seconds for this app, minutes for GPUs); and there
are more components to maintain.

---

## Troubleshooting

| Problem | What to check |
|---|---|
| HPA `TARGETS` shows `<unknown>` | Prometheus UI → **Status → Targets**: is `nodejs-service` listed and `UP`? |
| KEDA pods not starting | `kubectl logs -n keda deploy/keda-operator` |
| App / Grafana URL not opening | Is Traefik running? (`kubectl get pods -n kube-system`). Is the hostname `<name>.<YOUR-IP>.nip.io`? |
| Load test runs but no scaling | Paste the query from `scaledobject.yaml` into the Prometheus UI — does it return a number? |
| Load test shows errors at high load | Expected: the test can send more traffic than 10 pods handle at 20 req/s each. Raise `maxReplicaCount` or `threshold`. |
| GPU pods `Pending` (local) | `kubectl describe node` should show `nvidia.com/gpu` under Allocatable. If not, re-run `fake-gpu-node.sh`. Pods beyond 4 GPUs stay Pending by design. |
| GPU pods `Pending` (GKE) | `kubectl get events -n llm` — `NotTriggerScaleUp` usually means GPU quota is 0 or no spot L4 is available in that zone. |
| vLLM pod keeps restarting at start | Model loading is slower than the startup probe allows. Increase `failureThreshold` in `kubernetes/gpu/gke/vllm.yaml`. |

---

## Next steps

- **Find the real capacity of one pod:** run k6 until responses get slow, then
  set `threshold` to ~70% of that. The `20` req/s here is low on purpose so the
  demo scales quickly — a real Node.js pod can handle far more.
- **Try a queue instead of HTTP:** swap the Prometheus trigger for RabbitMQ or
  Kafka.
- **Try true scale-to-zero:** use Traefik metrics or the KEDA HTTP Add-on and
  measure how long the first request waits.
- **Try it on a cloud cluster** with Cluster Autoscaler or Karpenter to see
  machines being added and removed, not just pods.
- **Try the GPU lab:** [kubernetes/gpu/README.md](kubernetes/gpu/README.md).

---

## Links

| Topic | Links |
|---|---|
| KEDA | [Docs](https://keda.sh/docs/latest/) · [Concepts](https://keda.sh/docs/latest/concepts/) · [All scalers](https://keda.sh/docs/latest/scalers/) · [Cron scaler](https://keda.sh/docs/latest/scalers/cron/) · [HTTP Add-on](https://github.com/kedacore/http-add-on) |
| Kubernetes autoscaling | [HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) · [HPA walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/) · [Cluster Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/cluster-autoscaler) · [Karpenter](https://karpenter.sh/) |
| Monitoring | [Prometheus](https://prometheus.io/docs/introduction/overview/) · [PromQL basics](https://prometheus.io/docs/prometheus/latest/querying/basics/) · [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) · [Prometheus Operator](https://prometheus-operator.dev/) · [Grafana](https://grafana.com/docs/grafana/latest/) |
| GPU | [Scheduling GPUs](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/) · [Extended resources (fake GPU)](https://kubernetes.io/docs/tasks/administer-cluster/extended-resource-node/) · [GKE GPUs](https://cloud.google.com/kubernetes-engine/docs/how-to/gpus) · [NVIDIA GPU Operator](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/) · [DCGM exporter](https://github.com/NVIDIA/dcgm-exporter) · [vLLM metrics](https://docs.vllm.ai/en/latest/serving/metrics.html) |
| Tools | [k3s](https://docs.k3s.io/) · [Helm](https://helm.sh/docs/) · [Traefik ingress](https://doc.traefik.io/traefik/providers/kubernetes-ingress/) · [kubectl cheat sheet](https://kubernetes.io/docs/reference/kubectl/cheatsheet/) · [k6](https://grafana.com/docs/k6/latest/) |
| Cost | [FinOps framework](https://www.finops.org/framework/) · [KEDA blog](https://keda.sh/blog/) · [CNCF landscape](https://landscape.cncf.io/) |
