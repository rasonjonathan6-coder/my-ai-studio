#!/usr/bin/env bash
# Blocks sandbox containers from reaching the cloud instance-metadata endpoint.
#
# On Oracle Cloud (and AWS/GCP) 169.254.169.254 serves instance credentials to
# anything on the host. The sandbox executes model-authored commands, so leaving
# this reachable would let a build script read the host's cloud identity. This
# rule drops metadata traffic arriving on the docker bridge interface.
#
# Run as root on the host. Idempotent: re-running does not duplicate the rule.
set -uo pipefail

META_IP=169.254.169.254
IFACE="${1:-docker0}"

if [ "$(id -u)" -ne 0 ]; then
  echo "FAILED: must run as root (use sudo)"
  exit 1
fi

iface_exists() {
  # `ip` is not present in every base image, so /proc/net/dev is the reliable
  # check for a host interface.
  grep -qE "^\s*$1:" /proc/net/dev
}

if ! iface_exists "$IFACE"; then
  echo "NOT AVAILABLE: interface $IFACE does not exist; pass the docker bridge name as an argument"
  echo "interfaces: $(cut -d: -f1 /proc/net/dev | tr -d ' ' | grep -v '^$' | grep -v Inter | grep -v face | tr '\n' ' ')"
  exit 1
fi

if iptables -C DOCKER-USER -d "$META_IP" -j DROP 2>/dev/null; then
  echo "already blocked: DOCKER-USER -> $META_IP DROP"
else
  iptables -I DOCKER-USER -d "$META_IP" -j DROP
  echo "blocked: DOCKER-USER -> $META_IP DROP"
fi

# Verification: a container must no longer reach the endpoint.
if command -v docker >/dev/null 2>&1; then
  if docker run --rm --network bridge curlimages/curl:latest -s -m 5 "http://$META_IP/" >/dev/null 2>&1; then
    echo "WARNING: metadata endpoint still reachable from a container"
    exit 1
  fi
  echo "verified: metadata endpoint unreachable from a container"
fi
