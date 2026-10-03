#!/usr/bin/env bash
# Always run this after a lab session: an idle GPU node still bills by the hour.

set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project)}"
CLUSTER="${CLUSTER:-gpu-lab}"
ZONE="${ZONE:-us-central1-a}"

gcloud container clusters delete "$CLUSTER" --project "$PROJECT" --zone "$ZONE" --quiet
