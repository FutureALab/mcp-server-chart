# Ubuntu based image (glibc) for the AntV MCP chart server, SSE transport.
# It is built for linux/amd64 by .github/workflows/docker-release.yml when a
# release is published, but can also be built locally (docker/docker-compose.yml).
FROM ubuntu:24.04

# Node.js major version installed from NodeSource.
ARG NODE_VERSION=22
# Version of @antv/mcp-server-chart installed into the image, e.g. "0.9.11".
ARG MCP_SERVER_CHART_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Set workdir
WORKDIR /app

# Global install of @antv/mcp-server-chart
RUN npm install -g "@antv/mcp-server-chart@${MCP_SERVER_CHART_VERSION}" \
    && npm cache clean --force

EXPOSE 1123

# The server has to listen on 0.0.0.0 inside a container, otherwise it would
# only be reachable from within the container namespace.
CMD ["mcp-server-chart", "--transport", "sse", "--host", "0.0.0.0", "--port", "1123"]
