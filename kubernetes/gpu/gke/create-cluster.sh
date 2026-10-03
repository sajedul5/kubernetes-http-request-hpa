#!/usr/bin/env bash
# GKE lab cluster:
#   - "default" pool: 1 x e2-standard-4 for Prometheus, Grafana, KEDA
#   - "gpu-l4" pool: spot L4 GPUs, autoscaling 0..3 (pay only while GPU pods exist)
#
# Before running: check the GPU quota (NVIDIA_L4_GPUS / PREEMPTIBLE_NVIDIA_L4_GPUS)
# in the region, it is often 0 on new projects. Set a billing budget alert too.

set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project)}"
CLUSTER="${CLUSTER:-gpu-lab}"
ZONE="${ZONE:-us-central1-a}"

gcloud container clusters create "$CLUSTER" \
  --project "$PROJECT" \
  --zone "$ZONE" \
  --release-channel regular \
  --num-nodes 1 \
  --machine-type e2-standard-4

# GKE adds the nvidia.com/gpu=present:NoSchedule taint and installs the driver
# automatically (gpu-driver-version=latest), so CPU pods never land here.
gcloud container node-pools create gpu-l4 \
  --project "$PROJECT" \
  --cluster "$CLUSTER" \
  --zone "$ZONE" \
  --machine-type g2-standard-8 \
  --accelerator type=nvidia-l4,count=1,gpu-driver-version=latest \
  --spot \
  --num-nodes 0 \
  --enable-autoscaling \
  --min-nodes 0 \
  --max-nodes 3

gcloud container clusters get-credentials "$CLUSTER" --project "$PROJECT" --zone "$ZONE"

kubectl get nodes
