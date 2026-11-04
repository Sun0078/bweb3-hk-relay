// binance-relay v3 — 以用户原 Render 中继（fapi 路径代理 + 5 秒缓存防 418）为底合并扩展。
// 保留原设计：/fapi/*、/futures/* 路径代理 -> fapi.binance.com，白名单浏览器头，
//            200 响应 5 秒内存缓存，CORS 全开，OPTIONS 204。
// 新增（按三个 Worker 的实际调用契约补齐，原中继缺失的部分）：
//   A) 查询式 ?__path=<path[?query]>[&其余参数]：
//      /api/v3/* -> api.binance.com；其余（/api/v1/dex/*、/bapi/* 等 Web3）-> web3.binance.com
//      透传全部请求头（含 X-OC-* 签名头）、方法与请求体 —— radar-binance / radar-macro 的调用方式
//   B) 路径式 /api/v3/* -> api.binance.com（与 A 等价的路径形态，便于自检与后续调用）
//   C) /gt/* -> https://api.geckoterminal.com/api/v2/*（CoinGecko 平替：60s 缓存 + 限速整形 + 429 退避）
// 安全收紧（相对原版）：缓存只对 GET 生效（原版按 URL 缓存 POST 会串体）；
// 上游状态码与响应体一律原样透传（418/429/403/451 不吞、不改、不伪装成功）。
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 10000;

/* ================= 币安侧：5 秒缓存（原设计，仅 GET、仅 200） ================= */
const cache = new Map();
const CACHE_TTL_MS = 5000;

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
};

function pickBinanceHost(pathname) {
  if (pathname.startsWith("/fapi/") || pathname.startsWith("/futures/")) return "fapi.binance.com";
  if (pathname.startsWith("/api/v3/")) return "api.binance.com";
  return "web3.binance.com"; // /api/v1/dex/*、/bapi/* 等 Web3 路径
}

// 解析 __path 式：返回 { host, path } 或 null（非 __path 请求）
function parseQueryStyle(reqUrl) {
  const u = new URL(reqUrl, "http://relay.local");
  const qp = u.searchParams.get("__path");
  if (!qp) return null;
  const rest = new URLSearchParams(u.searchParams);
  rest.delete("__path");
  const restStr = rest.toString();
  let full = qp;
  if (restStr) full += (full.includes("?") ? "&" : "?") + restStr;
  const pathOnly = full.split("?")[0];
  return { host: pickBinanceHost(pathOnly), path: full };
}

function proxyBinance(req, res, host, pathAndQuery, chunks, forwardHeaders) {
  const body = Buffer.concat(chunks);
  const cacheKey = host + pathAndQuery;
  if (req.method === "GET") {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT-RENDER-MEM" });
      return res.end(cached.data);
    }
  }

  const headers = forwardHeaders
    ? Object.assign({}, req.headers, { host })
    : Object.assign({ host }, BROWSER_HEADERS);
  delete headers["content-length"];
  if (body.length > 0) headers["content-length"] = Buffer.byteLength(body);

  const options = { hostname: host, port: 443, path: pathAndQuery, method: req.method, headers };
  const proxyReq = https.request(options, (proxyRes) => {
    let responseBody = "";
    proxyRes.on("data", (chunk) => { responseBody += chunk; });
    proxyRes.on("end", () => {
      if (req.method === "GET" && proxyRes.statusCode === 200) {
        cache.set(cacheKey, { time: Date.now(), data: responseBody });
        if (cache.size > 2000) cache.clear();
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(responseBody);
    });
  });
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy Gateway Error", message: err.message }));
  });
  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

/* ================= GeckoTerminal 平替：缓存 + 整形 + 退避 =================
   四个 Worker 的重复 GT 调用在中继处合并成一次出网；出网速率整形到公共 API
   限流之下（基线间隔 5s ≈ 12/分钟）；429 时指数退避并优先回旧缓存。
   缓存 TTL 60s 与 GT 服务端自身 1 分钟缓存对齐，不引入额外陈旧度。 */
const GT_BASE = "https://api.geckoterminal.com/api/v2";
const GT_CACHE_TTL_MS = 60 * 1000;
const GT_MIN_INTERVAL_MS = 5000;
const gtCache = new Map();
let gtNextAt = 0;
let gtCooldownUntil = 0;
let gtBackoffMs = 60 * 1000;

async function handleGt(req, res) {
  const target = GT_BASE + req.url.slice(3); // 去掉 "/gt"
  const hit = gtCache.get(target);
  if (hit && hit.exp > Date.now()) {
    res.writeHead(hit.status, { "Content-Type": hit.ct || "application/json", "X-Relay-Cache": "hit" });
    return res.end(hit.buf);
  }
  if (Date.now() < gtCooldownUntil) {
    if (hit) {
      res.writeHead(hit.status, { "Content-Type": hit.ct || "application/json", "X-Relay-Cache": "stale" });
      return res.end(hit.buf);
    }
    res.writeHead(429, { "Content-Type": "application/json", "X-Relay-Cache": "cooldown" });
    return res.end(JSON.stringify({ relay_error: "gt_cooldown" }));
  }
  const wait = Math.max(0, gtNextAt - Date.now());
  gtNextAt = Date.now() + wait + GT_MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const t0 = Date.now();
  try {
    const up = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json;version=20230203" },
      signal: AbortSignal.timeout(15000),
    });
    const buf = Buffer.from(await up.arrayBuffer());
    const ct = up.headers.get("content-type") || "application/json";
    if (up.status === 429) {
      gtCooldownUntil = Date.now() + gtBackoffMs;
      gtBackoffMs = Math.min(gtBackoffMs * 2, 5 * 60 * 1000);
      console.error(`[gt] 429 -> cooldown ${gtCooldownUntil - Date.now()}ms`);
      if (hit) {
        res.writeHead(hit.status, { "Content-Type": hit.ct || "application/json", "X-Relay-Cache": "stale" });
        return res.end(hit.buf);
      }
    } else if (up.status === 200) {
      gtBackoffMs = 60 * 1000;
      gtCache.set(target, { status: 200, ct, buf, exp: Date.now() + GT_CACHE_TTL_MS });
      if (gtCache.size > 2000) gtCache.clear();
    }
    res.writeHead(up.status, { "Content-Type": ct, "X-Relay-Cache": "miss" });
    res.end(buf);
    console.log(`[gt] GET ${target} -> ${up.status} ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[gt] GET ${target} FAILED ${e && e.message || e}`);
    if (hit) {
      res.writeHead(hit.status, { "Content-Type": hit.ct || "application/json", "X-Relay-Cache": "stale" });
      return res.end(hit.buf);
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ relay_error: "gt_upstream_failed", detail: String(e && e.message || e) }));
  }
}

/* ================= 主服务 ================= */
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 健康检查
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("binance-relay ok");
  }

  // GeckoTerminal 平替
  if (req.method === "GET" && req.url.startsWith("/gt/")) {
    handleGt(req, res);
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // A) 查询式 __path（binance / macro）：透传签名头与请求体
    const qs = parseQueryStyle(req.url);
    if (qs) return proxyBinance(req, res, qs.host, qs.path, chunks, true);
    // 原路径式（whale 的 /fapi、/futures）+ B) /api/v3 路径式：按前缀分流，白名单头
    const u = new URL(req.url, "http://relay.local");
    const host = pickBinanceHost(u.pathname);
    return proxyBinance(req, res, host, req.url, chunks, false);
  });
});

server.listen(PORT, () => {
  console.log(`Binance Relay v3 running on port ${PORT}`);
});
