#!/usr/bin/env sh
#
# Load every image tarball produced by .github/workflows/docker-release.yml, so
# the stack in docker-compose.yaml can start without any registry access.
#
#   sh docker/load-images.sh /path/to/downloaded/tarballs
#   docker compose up -d
#
# The directory argument defaults to the current directory. Loading the combined
# "mcp-server-chart-all-*.tar" file is enough on its own; the per-image tarballs
# are only there if you prefer to load them separately.
set -eu

tarball_dir=${1:-.}

found=0
for tarball in "$tarball_dir"/*.tar; do
  [ -f "$tarball" ] || continue
  found=1
  echo "==> docker load --input ${tarball}"
  docker load --input "$tarball"
done

if [ "$found" -eq 0 ]; then
  echo "No *.tar files found in ${tarball_dir}" >&2
  exit 1
fi

echo
echo "Images loaded. Start the stack from this repository's root:"
echo
echo "  docker compose up -d"
echo
echo "The MCP server is then reachable at http://127.0.0.1:1122/mcp"
echo "(streamable HTTP), or at http://127.0.0.1:1123/sse with:"
echo
echo "  docker compose --profile sse up -d"
