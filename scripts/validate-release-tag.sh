#!/usr/bin/env bash
set -euo pipefail

# Validates a release tag:
#   1. well-formed semver: v<major>.<minor>.<patch>[-prerelease][+build]
#   2. points at the currently checked-out commit
#
# Usage: validate-release-tag.sh <tag>
#    or: RELEASE_TAG=v1.2.3 validate-release-tag.sh

tag="${1:-${RELEASE_TAG:-}}"

if [[ -z "$tag" ]]; then
  echo "usage: $0 <tag> (e.g. v1.2.3)" >&2
  exit 1
fi

identifier='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
semver_re="^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-${identifier}(\.${identifier})*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$"

if ! [[ "$tag" =~ $semver_re ]]; then
  echo "error: '$tag' is not a valid release tag (expected v<major>.<minor>.<patch>[-pre][+build])" >&2
  exit 1
fi

head_commit="$(git rev-parse HEAD)"
tag_commit="$(git rev-parse --verify --quiet "${tag}^{commit}" || true)"

if [[ -z "$tag_commit" ]]; then
  echo "error: tag '$tag' not found in this repository" >&2
  exit 1
fi

if [[ "$head_commit" != "$tag_commit" ]]; then
  echo "error: tag '$tag' points at $tag_commit, but HEAD is $head_commit" >&2
  exit 1
fi

echo "ok: tag '$tag' -> $tag_commit"
