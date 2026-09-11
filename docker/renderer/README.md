# 私有图表渲染服务（VIS_REQUEST_SERVER）

`mcp-server-chart` 默认把图表配置发到 AntV 的公有服务
`https://antv-studio.alipay.com/api/gpt-vis` 生成图片，再返回图片 URL 给模型。
环境变量 `VIS_REQUEST_SERVER` 允许把这个地址替换成你自己的服务。

本目录就是那个服务的最小实现：用 AntV 的
[`@antv/gpt-vis-ssr`](https://github.com/antvis/GPT-Vis/tree/main/bindings/gpt-vis-ssr)
在 Node 侧渲染 GPT-Vis 图表（`render(options)` → PNG Buffer），然后
把图片存盘、返回可访问的 URL。GPT-Vis 仓库本身只提供 SSR 库，不含 HTTP 服务，
所以需要这一层封装。

## 协议（与官方服务一致）

| 项目 | 内容 |
| :--- | :--- |
| Method | `POST` |
| Body | GPT-Vis 的 `options` 原样透传，例如 `{"type":"line","data":[{"time":"2025-05","value":512}]}` |
| 成功 | `200 {"success":true,"resultObj":"http://<host>/charts/<id>.png"}` |
| 失败 | `200 {"success":false,"errorMessage":"..."}` |

渲染失败必须返回 `200`：`mcp-server-chart` 只读取响应体里的 `success` /
`errorMessage`，返回非 2xx 只会变成一条无信息的传输层错误。

额外接口：`GET /healthz`（健康检查）、`GET /charts/<file>.png`（图片访问）。

## 环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CHART_OUTPUT_DIR` | `/var/lib/chart-renderer` | 渲染产物目录 |
| `PUBLIC_BASE_URL` | 由请求的 `Host` / `X-Forwarded-*` 推导 | **返回值里图片地址的前缀，必须能被 MCP 客户端访问** |
| `IMAGE_MODE` | `url` | `url` 返回图片地址；`data` 直接返回 base64 data URL（无需静态文件服务，但响应体更大） |
| `CHART_TTL_MS` | `3600000` | 渲染产物保留时长，超时由后台任务清理 |
| `MAX_CONCURRENCY` | `4` | 并行渲染数，渲染是 CPU 密集型操作 |
| `MAX_BODY_BYTES` | `10485760` | 请求体上限 |

## 构建与运行

构建上下文是仓库根目录：

```bash
cd /Users/hanxuelei/typescript_project/mcp-server-chart

docker build -f docker/renderer/Dockerfile -t mcp-server-chart-renderer:local .
```

国内网络可加镜像参数：

```bash
docker build -f docker/renderer/Dockerfile \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg APT_MIRROR=http://mirrors.aliyun.com \
  -t mcp-server-chart-renderer:local .
```

运行（`PUBLIC_BASE_URL` 换成 MCP 客户端真正能访问到的地址）：

```bash
docker run -d \
  --name chart-renderer \
  --restart unless-stopped \
  -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://192.168.1.10:3000 \
  -v chart-renderer-data:/var/lib/chart-renderer \
  mcp-server-chart-renderer:local
```

验证：

```bash
curl http://127.0.0.1:3000/healthz

curl -s -X POST http://127.0.0.1:3000/render \
  -H 'Content-Type: application/json' \
  -d '{"type":"line","data":[{"time":"2025-05","value":512},{"time":"2025-06","value":1024}],"title":"月度访问量"}'
# {"success":true,"resultObj":"http://192.168.1.10:3000/charts/line-....png"}

curl -o chart.png "http://192.168.1.10:3000/charts/line-....png"
```

## 接上 mcp-server-chart

### 方式一：MCP 客户端配置（本机/局域网直连）

```json
{
  "mcpServers": {
    "mcp-server-chart": {
      "command": "npx",
      "args": ["-y", "@antv/mcp-server-chart"],
      "env": {
        "VIS_REQUEST_SERVER": "http://192.168.1.10:3000/render",
        "DISABLED_TOOLS": "generate_district_map,generate_path_map,generate_pin_map"
      }
    }
  }
}
```

### 方式二：docker compose

仓库根目录的 `docker-compose.yaml` 已经加了 `chart-renderer` 服务，并给
`mcp-server-chart` 注入了容器网络内的地址：

```yaml
environment:
  - VIS_REQUEST_SERVER=http://chart-renderer:3000/render
```

注意这里用的是 compose 的服务名，不是 `127.0.0.1`：容器里的 `127.0.0.1`
指的是容器自己。

## 常见问题

1. **模型拿到图片地址却打不开**：`PUBLIC_BASE_URL` 填了容器/服务端视角的地址。
   它必须是 MCP 客户端（浏览器、Claude Desktop、Dify 等）能访问的地址，例如
   宿主机 IP 或域名。
2. **地理图表不可用**：`generate_district_map` / `generate_path_map` /
   `generate_pin_map` 依赖 AntV 的在线 POI 与地图数据，私有渲染服务无法提供，
   会返回 `success:false`。建议用 `DISABLED_TOOLS` 关掉这几个工具，或让它们继续
   走官方服务。
3. **中文标题显示成方框**：宿主或镜像里缺中文字体。镜像已安装
   `fonts-noto-cjk`；直接跑 `node server.js` 时需自行安装系统中文字体。
4. **Apple Silicon 上很慢**：`linux/amd64` 镜像会走模拟。请用本机架构重新构建
   （`docker build` 不带 `--platform` 即可）。
5. **服务无鉴权**：只暴露在内网，或用 Nginx 之类的反向代理加一层认证；
   反向代理记得透传 `X-Forwarded-Proto` / `X-Forwarded-Host`。

## 不用 Docker

```bash
npm install @antv/gpt-vis-ssr@0.3.8
PORT=3000 CHART_OUTPUT_DIR=./charts PUBLIC_BASE_URL=http://127.0.0.1:3000 node server.js
```
