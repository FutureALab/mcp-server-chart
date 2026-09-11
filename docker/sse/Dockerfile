# Ubuntu based image (glibc) for the AntV MCP chart server, SSE transport.
#
# The server is compiled from this repository's source code, so no published
# @antv/mcp-server-chart release on npm is required. It is built for
# linux/amd64 by .github/workflows/docker-release.yml when a release is
# published, and can also be built locally from the repository root:
#   docker build -f docker/sse/Dockerfile -t mcp-server-chart-sse .
FROM ubuntu:24.04 AS base

# Node.js major version installed from NodeSource.
ARG NODE_VERSION=22

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

WORKDIR /app

# Production dependencies used by the runtime image.
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

# Compile the TypeScript sources of this repository.
FROM base AS builder
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund --ignore-scripts
COPY src ./src
RUN npm run build

# Runtime image: only the compiled output and production dependencies.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY package*.json ./

EXPOSE 1123

# The server has to listen on 0.0.0.0 inside a container, otherwise it would
# only be reachable from within the container namespace.
CMD ["node", "build/index.js", "--transport", "sse", "--host", "0.0.0.0", "--port", "1123"]
