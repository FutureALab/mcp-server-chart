/**
 * Intranet chart rendering service for @antv/mcp-server-chart.
 *
 * It speaks the same HTTP contract as AntV's public service, so the MCP server
 * can be pointed at it with VIS_REQUEST_SERVER and never needs the internet:
 *
 *   POST /render   { "type": "pie", "data": [...], ... }
 *              ->  { "success": true, "resultObj": "http://<host>/charts/<id>.png" }
 *   POST /render   { "tool": "generate_pin_map", "input": {...} }
 *              ->  { "success": false, "errorMessage": "..." }   (geographic charts are unsupported)
 *
 * Environment variables:
 *   PORT               server port                                  (default 3000)
 *   HOST               bind address                                 (default 0.0.0.0)
 *   CHART_OUTPUT_DIR   where rendered PNG files are stored          (default /var/lib/chart-renderer)
 *   PUBLIC_BASE_URL    base URL used in resultObj, e.g.
 *                      http://10.0.0.5:3000 (default: derived from the request)
 *   IMAGE_MODE         "url" or "data" (inline base64 data URL)     (default url)
 *   CHART_TTL_MS       how long rendered files are kept             (default 3600000)
 *   MAX_CONCURRENCY    parallel renders                             (default 4)
 *   MAX_BODY_BYTES     max request body size in bytes               (default 10485760)
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

// @antv/s2 (pulled in by @antv/gpt-vis-ssr for spreadsheet charts) requires its
// own stylesheet from Node, which only works inside a bundler:
//   require('./index.css') -> SyntaxError: Unexpected token '.'
// Server side rendering never needs those styles, so make such imports no-ops.
for (const extension of [".css", ".less", ".scss", ".sass", ".styl"]) {
  require.extensions[extension] = () => {};
}

const { render } = require("@antv/gpt-vis-ssr");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const OUTPUT_DIR = process.env.CHART_OUTPUT_DIR || "/var/lib/chart-renderer";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const IMAGE_MODE = (process.env.IMAGE_MODE || "url").toLowerCase();
const CHART_TTL_MS = Number.parseInt(process.env.CHART_TTL_MS || "3600000", 10);
const MAX_CONCURRENCY = Number.parseInt(process.env.MAX_CONCURRENCY || "4", 10);
const MAX_BODY_BYTES = Number.parseInt(
  process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024),
  10,
);

// Geographic charts need AntV's own online service (POI/geo data), so a private
// renderer cannot serve them. See the note in the project README.
const GEO_CHART_TYPES = new Set(["district-map", "path-map", "pin-map"]);
const GEO_ERROR_MESSAGE =
  "Geographic chart generation (district-map, path-map, pin-map) is not supported by the private render service. " +
  "Disable these tools with DISABLED_TOOLS, or keep using the official VIS_REQUEST_SERVER for them.";

function log(message, extra) {
  const line = `${new Date().toISOString()} [chart-renderer] ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
}

/* ------------------------------------------------------------------ */
/* Concurrency guard: rendering is CPU heavy, so limit parallel work.  */
/* ------------------------------------------------------------------ */
let active = 0;
const waiting = [];

function acquireSlot() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function isChartFile(name) {
  return /^[A-Za-z0-9._-]+\.png$/.test(name);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
async function handleRender(payload, req) {
  // The map tools of mcp-server-chart use a different payload shape.
  if (payload.tool !== undefined) {
    return { success: false, errorMessage: GEO_ERROR_MESSAGE };
  }

  const { type, source, ...options } = payload;
  if (typeof type !== "string" || type === "") {
    return {
      success: false,
      errorMessage: 'Missing required string field "type" in the request body.',
    };
  }
  if (GEO_CHART_TYPES.has(type)) {
    return { success: false, errorMessage: GEO_ERROR_MESSAGE };
  }

  await acquireSlot();
  let vis;
  try {
    vis = await render({ type, ...options });
    const buffer = vis.toBuffer();

    if (IMAGE_MODE === "data") {
      return {
        success: true,
        resultObj: `data:image/png;base64,${buffer.toString("base64")}`,
      };
    }

    const fileName = `${type}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
    await fsp.writeFile(path.join(OUTPUT_DIR, fileName), buffer);
    return { success: true, resultObj: `${baseUrl(req)}/charts/${fileName}` };
  } catch (error) {
    const message = error?.message
      ? error.message
      : `Unknown render error: ${error}`;
    log(`render failed (type=${type}): ${message}`);
    return { success: false, errorMessage: message };
  } finally {
    if (vis && typeof vis.destroy === "function") {
      try {
        vis.destroy();
      } catch {
        /* ignore */
      }
    }
    releaseSlot();
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  if (
    req.method === "GET" &&
    (url.pathname === "/healthz" || url.pathname === "/")
  ) {
    sendJson(res, 200, { status: "ok", imageMode: IMAGE_MODE });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/charts/")) {
    const name = decodeURIComponent(url.pathname.slice("/charts/".length));
    if (!isChartFile(name)) {
      sendJson(res, 400, { error: "Invalid chart file name." });
      return;
    }
    const filePath = path.join(OUTPUT_DIR, name);
    try {
      const stat = await fsp.stat(filePath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=3600",
      });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      sendJson(res, 404, { error: "Chart not found." });
    }
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: `Method ${req.method} not allowed.` });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    const message = error?.message ? error.message : String(error);
    log(`invalid request body: ${message}`);
    sendJson(res, 400, { success: false, errorMessage: message });
    return;
  }

  const startedAt = Date.now();
  const result = await handleRender(payload, req);
  const elapsed = Date.now() - startedAt;

  if (result.success) {
    log(`rendered ${payload.type} in ${elapsed}ms`);
  } else {
    log(`failed ${payload.type || payload.tool || "unknown"} in ${elapsed}ms`);
  }

  // Always answer 200 with the documented body shape: mcp-server-chart reads
  // `success` / `errorMessage` from the payload and would surface a transport
  // error instead of the real message if the status code was not 2xx.
  sendJson(res, 200, result);
});

async function cleanupExpiredCharts() {
  try {
    const entries = await fsp.readdir(OUTPUT_DIR);
    const now = Date.now();
    for (const entry of entries) {
      if (!isChartFile(entry)) continue;
      const filePath = path.join(OUTPUT_DIR, entry);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && now - stat.mtimeMs > CHART_TTL_MS) {
        await fsp.rm(filePath, { force: true });
      }
    }
  } catch (error) {
    log(`cleanup failed: ${error?.message ? error.message : error}`);
  }
}

async function main() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const timer = setInterval(cleanupExpiredCharts, 10 * 60 * 1000);
  timer.unref();

  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT} (image mode: ${IMAGE_MODE})`);
  });

  const shutdown = (signal) => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  log(`fatal: ${error?.stack ? error.stack : error}`);
  process.exit(1);
});
