# Private chart-render service for @antv/mcp-server-chart.
#
# It wraps @antv/gpt-vis-ssr (AntV GPT-Vis SSR binding) in a tiny HTTP service
# that speaks the same contract as https://antv-studio.alipay.com/api/gpt-vis,
# so the MCP server can be pointed at it with VIS_REQUEST_SERVER and never has
# to reach the internet.
#
# The build context is the repository root:
#
#   docker build -f docker/renderer/Dockerfile -t mcp-server-chart-renderer:local .
#
# Mirrors help on restricted networks. APT_MIRROR is a host only: the "/debian"
# and "/debian-security" paths of the base image sources are preserved.
#
#   docker build -f docker/renderer/Dockerfile \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg APT_MIRROR=http://mirrors.aliyun.com \
#     -t mcp-server-chart-renderer:local .

ARG NODE_VERSION=22
ARG GPT_VIS_SSR_VERSION=0.3.8

# ---------------------------------------------------------------------------
# Stage 1: install the renderer dependencies (@antv/gpt-vis-ssr + node-canvas).
#
# node-canvas downloads a prebuilt binary, so no C++ toolchain is needed here.
# If your platform has no matching prebuild, add build-essential, pkg-config,
# python3 and the -dev packages of cairo/pango/libjpeg/giflib/librsvg.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG NPM_REGISTRY
ARG GPT_VIS_SSR_VERSION

WORKDIR /app

RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
 && npm install --omit=dev --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
      "@antv/gpt-vis-ssr@${GPT_VIS_SSR_VERSION}" \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: runtime image. Native libraries required by node-canvas plus CJK
# fonts, so Chinese labels in charts are rendered instead of tofu boxes.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG APT_MIRROR

RUN set -eu; \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt_update() { apt-get -o Acquire::Retries=10 update; }; \
    apt_install() { \
      apt-get -o Acquire::Retries=10 -y --no-install-recommends install "$@"; \
    }; \
    ok=""; \
    for attempt in 1 2 3 4 5; do \
      echo "runtime apt attempt ${attempt}"; \
      if apt_update && apt_install \
           fontconfig fonts-dejavu-core fonts-noto-cjk \
           libcairo2 libgif7 libjpeg62-turbo libpango-1.0-0 \
           libpangocairo-1.0-0 libpixman-1-0 librsvg2-2; then \
        ok=1; break; \
      fi; \
      rm -rf /var/lib/apt/lists/*; sleep 5; \
    done; \
    [ "${ok}" = 1 ]; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CHART_OUTPUT_DIR=/var/lib/chart-renderer

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY docker/renderer/server.js ./server.js

RUN mkdir -p "${CHART_OUTPUT_DIR}"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
