#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/k8s"
sudo kubectl apply -f 00-namespace.yaml
sudo kubectl apply -f 01-pvc.yaml
sudo kubectl apply -f 02-db.yaml
sudo kubectl apply -f 03-auth.yaml
sudo kubectl apply -f 04-cronjob.yaml
sudo kubectl apply -f 05-ingress.yaml
