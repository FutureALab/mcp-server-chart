// @antv/s2（@antv/gpt-vis-ssr 渲染 spreadsheet / 透视表时依赖它）会从 Node 里
// require 自己的样式表，这种导入只有打包器能处理：
//   require('./index.css') -> SyntaxError: Unexpected token '.'
// 服务端渲染用不到样式，把这类扩展名注册成空模块即可。
// 必须在 require('@antv/gpt-vis-ssr') 之前执行，否则加载时就抛错。
for (const extension of ['.css', '.less', '.scss', '.sass', '.styl', '.svg']) {
    require.extensions[extension] = () => {};
}

require('dotenv').config();
const express = require('express');
const { render } = require('@antv/gpt-vis-ssr');
const MinIO = require('minio');

// ---------------------------------------------------------------------------
// 渲染异常兜底
//
// @antv/g2-ssr / @antv/s2-ssr 在数据不满足要求时会在 Promise 链之外抛异常，
// 例如 violin 每个分类只有一个值时：
//   TypeError: Cannot read properties of undefined (reading '0')
//     at @antv/g2-ssr/dist/g2-ssr.cjs:77
// 这种异常不会被 `await render(spec)` 的 try/catch 捕获，render() 也永远不会
// settle；Node 默认会直接结束进程，整个渲染服务随之不可用，之后所有图表请求
// 都会失败（socket hang up / ECONNREFUSED），表现就是"连续返回 500"。
//
// 所以这里做两件事：
//   1. 兜住 uncaughtException / unhandledRejection，只记录日志，不让进程退出；
//   2. 把因此中断的渲染请求立刻标记为失败，并给每次渲染加超时，
//      保证只有这一个坏请求失败，其他图表仍然可用。
// ---------------------------------------------------------------------------
const RENDER_TIMEOUT_MS =
    Number(process.env.RENDER_TIMEOUT_MS) > 0
        ? Number(process.env.RENDER_TIMEOUT_MS)
        : 30000;

// 正在渲染的请求，用于把兜底异常落到对应的请求上
const inFlightRenders = new Set();

function failInFlightRenders(error) {
    for (const abort of Array.from(inFlightRenders)) {
        abort(error);
    }
    inFlightRenders.clear();
}

process.on('uncaughtException', (error) => {
    console.error('【未捕获异常】渲染依赖抛出异常，已忽略以避免服务退出:', error);
    failInFlightRenders(error instanceof Error ? error : new Error(String(error)));
});

process.on('unhandledRejection', (reason) => {
    console.error('【未处理的 Promise 拒绝】已忽略以避免服务退出:', reason);
    failInFlightRenders(reason instanceof Error ? reason : new Error(String(reason)));
});


// 获取 gpt-vis-ssr 版本
let gptVisSsrVersion = 'unknown';
try {
    const gptVisSsrPackagePath = require.resolve('@antv/gpt-vis-ssr/package.json');
    const packageJson = require(gptVisSsrPackagePath);
    gptVisSsrVersion = packageJson.version;
} catch (err) {
    console.log('无法获取 gpt-vis-ssr 版本信息:', err.message);
}


const app = express();

// 设置响应头
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

// 解析 JSON 请求体
app.use(express.json({ limit: '10mb' }));

// MinIO 配置
const minioClient = new MinIO.Client({
    endPoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'chart-images';

// MCP 客户端（浏览器 / Claude Desktop / Dify ...）会直接打开返回的图片地址，
// 所以 bucket 必须允许匿名读取，否则 GET 图片只会拿到 403。
const PUBLIC_READ = (process.env.MINIO_PUBLIC_READ || 'true') !== 'false';

const PUBLIC_READ_POLICY = {
    Version: '2012-10-17',
    Statement: [
        {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`]
        }
    ]
};

function ensurePublicRead() {
    if (!PUBLIC_READ) return;
    minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(PUBLIC_READ_POLICY), function (err) {
        if (err) return console.error('设置 Bucket 匿名读策略失败:', err);
        console.log(`Bucket ${BUCKET_NAME} 已允许匿名读取（MINIO_PUBLIC_READ=false 可关闭）`);
    });
}

// 确保 Bucket 存在
minioClient.bucketExists(BUCKET_NAME, function (err, exists) {
    if (err) return console.error('检查 Bucket 失败:', err);
    if (exists) {
        ensurePublicRead();
        return;
    }
    minioClient.makeBucket(BUCKET_NAME, '', function (err) {
        if (err) return console.error('创建 bucket 失败:', err);
        console.log(`Bucket ${BUCKET_NAME} 创建成功`);
        ensurePublicRead();
    });
});

/**
 * 清理 spec 对象中的 undefined 和 null 值
 */
function clean(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) {
        return obj
            .map(item => clean(item))
            .filter(item => item !== undefined);
    }
    if (typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
            if (value !== undefined && value !== null) {
                const cleanedValue = clean(value);
                if (cleanedValue !== undefined) {
                    cleaned[key] = cleanedValue;
                }
            }
        }
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
    return obj;
}

/**
 * 释放渲染结果持有的画布资源
 */
async function destroyRenderResult(result) {
    if (!result) return;
    try {
        if (typeof result.destroy === 'function') {
            await result.destroy();
        } else if (typeof result.dispose === 'function') {
            await result.dispose();
        } else if (typeof result.close === 'function') {
            await result.close();
        }
    } catch (cleanupError) {
        console.warn('渲染资源释放失败:', cleanupError.message);
    }
}

/**
 * 渲染 spec，并保证：
 * - 渲染依赖在 Promise 链之外抛异常（进程级 uncaughtException）时，当前请求
 *   立即收到失败，而不是让服务退出；
 * - 渲染卡死（例如抛异常后 render() 永不 settle）时有超时兜底。
 */
async function renderSpec(spec) {
    let abort;
    const aborted = new Promise((_, reject) => {
        abort = (error) => reject(error);
    });

    let renderSettled = false;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`图表渲染超时（超过 ${RENDER_TIMEOUT_MS}ms）`));
        }, RENDER_TIMEOUT_MS);
        // 计时器不应该让进程一直保持存活
        if (typeof timer.unref === 'function') timer.unref();
    });

    inFlightRenders.add(abort);

    const pending = render(spec);
    pending.then(
        () => {
            renderSettled = true;
        },
        () => {
            renderSettled = true;
        }
    );

    try {
        return await Promise.race([pending, aborted, timeout]);
    } finally {
        clearTimeout(timer);
        inFlightRenders.delete(abort);
        if (!renderSettled) {
            // 请求已经失败了但渲染还在跑：它可能稍后成功，拿到结果后直接销毁，
            // 避免画布资源泄漏。
            pending.then((result) => destroyRenderResult(result)).catch(() => {});
        }
    }
}

/**
 * 图表生成接口
 * 支持 flow-diagram 等类型
 */
app.post('/generate', async (req, res) => {
    const userSpec = req.body;

    // 输入校验
    if (!userSpec || typeof userSpec !== 'object') {
        return res.status(400).json({
            success: false,
            errorMessage: '请求体必须是有效 JSON 对象'
        });
    }

    let spec;
    let renderResult;
    try {
        // 深拷贝并清理 spec，避免修改原始对象
        spec = clean(JSON.parse(JSON.stringify(userSpec)));
    } catch (err) {
        return res.status(400).json({
            success: false,
            errorMessage: 'JSON 格式无效'
        });
    }

    // 强制确保 data 存在
    spec.data = spec.data || { nodes: [], edges: [] };

    // 只有图形类图表（flow-diagram / network-graph 等）的 data 才是
    // { nodes, edges } 结构，其他图表的 data 是数组（waterfall / spreadsheet /
    // line ...）。之前这里无条件往 data 上写 nodes / edges，数组也会被挂上这两个
    // 属性，交给下游渲染器时很容易出问题，因此只对对象形态的 data 做归一化。
    if (!Array.isArray(spec.data)) {
        spec.data.nodes = Array.isArray(spec.data.nodes) ? spec.data.nodes : [];
        spec.data.edges = Array.isArray(spec.data.edges) ? spec.data.edges : [];

        // ✅ 关键修复：确保所有节点 id 是字符串
        spec.data.nodes = spec.data.nodes.map((node, index) => ({
            ...node,
            id: String(node?.id || `node_${index}`).trim(),
            type: node?.type || 'default-node',
            label: node?.label != null ? String(node.label) : ''
        }));

        // ✅ 可选：确保边的 source/target 是字符串
        spec.data.edges = spec.data.edges
            .filter(edge => edge && edge.source && edge.target)
            .map(edge => ({
                ...edge,
                source: String(edge.source),
                target: String(edge.target)
            }));
    }

    // 🔥 关键：确保 extensions 不会导致问题
    if (Array.isArray(spec.extensions)) {
        spec.extensions = spec.extensions.filter(ext => ext !== undefined);
    } else {
        delete spec.extensions; // 或设为空数组
    }

    // 日志：打印处理后的 spec（调试用）
    console.log('处理后的图表配置:', JSON.stringify(spec, null, 2));

    try {
        // 调用 @antv/gpt-vis-ssr 渲染图表（带超时与兜底异常保护）
        renderResult = await renderSpec(spec);

        // 检查是否支持 toBuffer
        if (typeof renderResult?.toBuffer !== 'function') {
            console.error('renderResult 缺少 toBuffer 方法:', renderResult);
            return res.json({
                success: false,
                errorMessage: '渲染结果不支持图像导出'
            });
        }

        // 获取图像 Buffer
        const imageBuffer = await renderResult.toBuffer();

        // 生成唯一文件名
        const fileName = `charts/${Date.now()}_${Math.random().toString(36).substr(2, 8)}.png`;

        const metaData = {
            'Content-Type': 'image/png'
        };

        // 上传到 MinIO
        try {
            await new Promise((resolve, reject) => {
                minioClient.putObject(BUCKET_NAME, fileName, imageBuffer, metaData, (err, etag) => {
                    if (err) reject(err);
                    else resolve(etag);
                });
            });
            console.log(`图像上传成功: ${BUCKET_NAME}/${fileName}`);
        } catch (uploadError) {
            console.error('MinIO 上传失败:', uploadError);
            return res.status(500).json({
                success: false,
                errorMessage: `图像上传失败: ${uploadError.message}`
            });
        }

        // 生成公开访问 URL
        const publicDomain = process.env.MINIO_PUBLIC_DOMAIN;
        if (!publicDomain) {
            console.error('MINIO_PUBLIC_DOMAIN 环境变量未配置');
            return res.status(500).json({
                success: false,
                errorMessage: '服务器配置错误：MINIO_PUBLIC_DOMAIN 未设置'
            });
        }

        const imageUrl = `${publicDomain}/${BUCKET_NAME}/${fileName}`;

        // 返回成功响应
        res.json({
            success: true,
            resultObj: imageUrl,
            message: '图表生成并上传成功'
        });

    } catch (error) {
        const message = error?.message || String(error) || '未知错误';
        console.error('【渲染失败】', message);
        console.error('错误堆栈:', error?.stack);

        // 渲染失败（数据不合法 / 该图表类型不支持 / 渲染依赖报错）按 README 约定
        // 用 200 + success:false 返回，把真实原因带回调用方。之前返回 500 时，
        // MCP 服务端的 axios 只会抛出 "Request failed with status code 500"，
        // 真实原因（例如 "Unknown chart type: waterfall"）全部丢失。
        const hint = message.startsWith('Unknown chart type')
            ? '（当前镜像安装的 @antv/gpt-vis-ssr 版本不支持该图表类型，请升级依赖后重新构建渲染镜像）'
            : '';
        res.json({
            success: false,
            errorMessage: `图表渲染失败: ${message}${hint}`
        });
    } finally {
        // 主动释放渲染过程中持有的资源，避免长时间运行导致内存泄漏
        await destroyRenderResult(renderResult);
    }
});

// 404 处理
app.use((req, res) => {
    res.status(404).json({
        success: false,
        errorMessage: '接口不存在'
    });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({
        success: false,
        errorMessage: '服务器内部错误'
    });
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`服务运行在 http://localhost:${PORT}`);
    console.log(`MinIO Bucket: ${BUCKET_NAME}`);
    console.log(`gpt-vis-ssr version: ${gptVisSsrVersion}`);
});

module.exports = app;
