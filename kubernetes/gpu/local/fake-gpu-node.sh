#!/usr/bin/env bash
# Advertise fake NVIDIA GPUs on a local node (k3s/kind/minikube) so the scheduler
# treats it like a GPU node. No real GPU or driver is needed.
#
#   ./fake-gpu-node.sh               # first node, 4 fake GPUs
#   GPUS=2 ./fake-gpu-node.sh <node> # specific node, 2 fake GPUs
#   ./fake-gpu-node.sh --remove      # undo
#
# Note: no taint is added here. On a single-node cluster a NoSchedule taint would
# block monitoring/KEDA pods too. Real GPU pools (see ../gke) do use a taint.

set -euo pipefail

REMOVE=false
if [[ "${1:-}" == "--remove" ]]; then
  REMOVE=true
  shift
fi

NODE="${1:-$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')}"
GPUS="${GPUS:-4}"

if $REMOVE; then
  kubectl label node "$NODE" gpu-node- || true
  kubectl patch node "$NODE" --subresource=status --type=json \
    -p '[{"op":"remove","path":"/status/capacity/nvidia.com~1gpu"}]' || true
  echo "Removed fake GPUs from $NODE"
  exit 0
fi

kubectl label node "$NODE" gpu-node=true --overwrite

kubectl patch node "$NODE" --subresource=status --type=json \
  -p "[{\"op\":\"add\",\"path\":\"/status/capacity/nvidia.com~1gpu\",\"value\":\"$GPUS\"}]"

echo "Node $NODE now advertises $GPUS x nvidia.com/gpu:"
kubectl get node "$NODE" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}{"\n"}'
