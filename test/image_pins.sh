#!/usr/bin/env bash
# shellcheck disable=SC2015
#   `cond && ok "…" || bad "…"` is safe here: ok() and bad() always return 0.
#
# Every image a compose file uses must be pinned by digest, and that digest
# must be exactly what the registry serves for the tag beside it. An app
# installed next month then gets the bytes that were tested today, and a tag
# that was ever re-pushed shows up here as a mismatch instead of as a silent
# change on somebody's Umbrel.
#
# A tag that is not published yet (a PR raising a version) cannot have a
# digest; it is allowed unpinned, with a notice, and must be pinned once the
# image exists. A published tag without a pin fails.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); green "  ✓ $1"; }
bad()   { FAIL=$((FAIL + 1)); red "  ✗ $1"; if [[ $# -gt 1 ]]; then printf '      %s\n' "$2"; fi; return 0; }

ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

# The digest the registry serves for repo:tag, or "" when the tag does not exist.
published_digest() { # repo tag
  local repo="$1" tag="$2" token
  token="$(curl -fsS -m 20 "https://ghcr.io/token?scope=repository:${repo}:pull" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')" || return 1
  curl -sS -m 20 -o /dev/null -D - -H "Authorization: Bearer ${token}" -H "Accept: ${ACCEPT}" \
    "https://ghcr.io/v2/${repo}/manifests/${tag}" \
    | tr -d '\r' | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }'
}

refs="$(grep -hoE 'image: ghcr\.io/[^[:space:]]+' "${REPO_ROOT}"/doge-*/docker-compose.yml | sed 's/^image: ghcr\.io\///' | sort -u)"
[[ -n "${refs}" ]] && ok "found the ghcr.io images the apps use" || { bad "found the ghcr.io images the apps use"; exit 1; }

while IFS= read -r ref; do
  repo="${ref%%:*}"
  rest="${ref#*:}"
  tag="${rest%%@*}"
  pinned=""
  [[ "${rest}" == *@sha256:* ]] && pinned="sha256:${rest##*@sha256:}"
  if [[ -n "${pinned}" && ! "${pinned}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    bad "${repo}:${tag}: the pin is not a sha256 digest" "${pinned}"; continue
  fi
  live="$(published_digest "${repo}" "${tag}")" || { bad "${repo}:${tag}: the registry could not be asked"; continue; }
  if [[ -z "${live}" ]]; then
    if [[ -z "${pinned}" ]]; then
      info "  · ${repo}:${tag} is not published yet; pin its digest once it is"
      PASS=$((PASS + 1))
    else
      bad "${repo}:${tag}: pinned, but the tag does not exist in the registry"
    fi
    continue
  fi
  if [[ -z "${pinned}" ]]; then
    bad "${repo}:${tag} is published but not pinned" "add @${live}"
  elif [[ "${pinned}" == "${live}" ]]; then
    ok "${repo}:${tag} is pinned to exactly what the registry serves"
  else
    bad "${repo}:${tag}: the registry now serves a different image than the pin" "pinned ${pinned}, served ${live}"
  fi
done <<< "${refs}"

echo
if [[ ${FAIL} -eq 0 ]]; then green "${PASS} checks passed, 0 failed"; exit 0
else red "${PASS} passed, ${FAIL} FAILED"; exit 1; fi
