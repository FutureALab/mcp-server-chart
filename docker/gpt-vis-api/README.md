# 私有图表渲染服务（VIS_REQUEST_SERVER）

`mcp-server-chart` 默认把图表配置发到 AntV 的公有服务
`https://antv-studio.alipay.com/api/gpt-vis` 生成图片。环境变量
`VIS_REQUEST_SERVER` 可以把它换成你自己的服务，本目录就是那个服务的最小实现：
用 [`@antv/gpt-vis-ssr`](https://github.com/antvis/GPT-Vis/tree/main/bindings/gpt-vis-ssr)
在 Node 侧把图表渲染成 PNG，上传到 MinIO，并把可访问的图片地址返回给 MCP 服务。

## 接口

| 项目 | 内容 |
| :--- | :--- |
| Method | `POST` |
| Path | `/generate` |
| Body | GPT-Vis 的 `options` 原样透传，例如 `{"type":"line","data":[{"time":"2025-05","value":512}]}` |
| 成功 | `200 {"success":true,"resultObj":"http://<minio-domain>/<bucket>/charts/<id>.png"}` |
| 失败 | `200 {"success":false,"errorMessage":"..."}` |

注意 `VIS_REQUEST_SERVER` 必须带上 `/generate`，例如
`http://chart-renderer:3000/generate`（compose 内部）或
`http://127.0.0.1:3000/generate`（本机）。

## 环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 监听端口 |
| `MINIO_ENDPOINT` | - | MinIO 地址，compose 里是服务名 `minio` |
| `MINIO_PORT` | - | MinIO S3 端口，默认 `9000` |
| `MINIO_USE_SSL` | - | `true` / `false` |
| `MINIO_ACCESS_KEY` | - | MinIO 账号 |
| `MINIO_SECRET_KEY` | - | MinIO 密码 |
| `MINIO_BUCKET` | `chart-images` | 存放图片的 bucket，启动时自动创建 |
| `MINIO_PUBLIC_READ` | `true` | 启动时把 bucket 设为匿名可读。客户端要直接打开图片地址，设为 `false` 会让所有图片返回 `403` |
| `MINIO_PUBLIC_DOMAIN` | - | **返回给 MCP 客户端的图片地址前缀，必须是客户端能访问的地址** |
| `RENDER_TIMEOUT_MS` | `30000` | 单张图的渲染超时，超时后该请求返回 `success:false`，服务继续处理其他请求 |

## 本地运行

```bash
cd docker/gpt-vis-api
pnpm install
pnpm start          # 等价于 node --max-old-space-size=4096 src/index.js
```

需要可用的 MinIO，可以直接复用仓库根目录的 compose：

```bash
docker compose up -d minio
MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=19200 MINIO_USE_SSL=false \
MINIO_ACCESS_KEY=admin MINIO_SECRET_KEY=12345678 \
MINIO_PUBLIC_DOMAIN=http://127.0.0.1:19200 \
pnpm start
```

## 镜像

`Dockerfile` 安装了 node-canvas 与中文字体所需的系统依赖（含 Chromium 运行库），
构建上下文是本目录：

```bash
docker build -t mcp-server-chart-renderer:local .
```

仓库根目录的 `docker-compose.yaml` 会用 `./docker/gpt-vis-api` 作为构建上下文，
发布流程 `.github/workflows/docker-release.yml` 会把它打包成
`mcp-server-chart-renderer-<version>-linux-amd64.tar`。

## 常见问题

1. **图片地址打不开**：`MINIO_PUBLIC_DOMAIN` 填成了容器内视角的地址。它必须是
   MCP 客户端（浏览器 / Claude Desktop / Dify ...）能访问的地址，例如宿主机 IP。
2. **图片地址返回 403**：bucket 不允许匿名读取。服务默认会设置匿名读策略，
   只有在 `MINIO_PUBLIC_READ=false` 或没有权限设置 bucket policy 时才会出现。
3. **地理图表不可用**：`generate_district_map` / `generate_path_map` /
   `generate_pin_map` 依赖 AntV 的在线 POI 与地图数据，私有渲染服务无法提供。
   建议用 `DISABLED_TOOLS` 关掉这三个工具（compose 里已默认关闭）。
4. **个别图表一直返回 500**：先看返回体里的 `errorMessage`（渲染失败按 README
   约定用 `200 {"success":false,...}` 返回，不再只给一个 500 状态码）。如果提示
   `Unknown chart type: xxx`，说明镜像里的 `@antv/gpt-vis-ssr` 版本太旧、还不支持
   这个图表类型——例如 `0.2.2` 没有 `waterfall` 与 `spreadsheet`，所有
   `generate_waterfall_chart` / `generate_spreadsheet` 请求都会 500；升级
   `package.json` 里的版本（当前 `0.3.8`）后重新构建镜像即可。
5. **某个图表失败后所有图表都失败**：渲染依赖（`@antv/g2-ssr` / `@antv/s2-ssr`）
   在数据不满足要求时会抛进程级异常，例如 `violin` 每个分类只有一个值时抛
   `TypeError: Cannot read properties of undefined (reading '0')` 且 `render()`
   永不返回，Node 默认会直接退出进程，后续请求全部变成
   `socket hang up` / `connect ECONNREFUSED`。服务已对这类异常做了兜底：只有该请求
   失败（`success:false`），不会退出进程；超过 `RENDER_TIMEOUT_MS` 仍未返回的渲染
   也会被超时中断。
