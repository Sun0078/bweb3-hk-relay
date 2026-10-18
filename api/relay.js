export default async function handler(req, res) {
  const targetHost = req.headers["x-target-host"] || "https://web3.binance.com";
  const targetPath = req.query.__path || "";
  if (!targetPath.startsWith("/")) return res.status(400).json({ error: "Missing __path" });

  const urlObj = new URL(req.url, "http://localhost");
  urlObj.searchParams.delete("__path");
  const qs = urlObj.searchParams.toString();
  const finalUrl = `${targetHost}${targetPath}${qs ? `?${qs}` : ""}`;

  // 1. 纯净的基础请求头
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Encoding": "identity"
  };

  // 2. ⚡️ 核心修复：自动透传所有 x-oc- 开头的币安签名头，防止漏掉 SIGN 或 SIGNATURE
  Object.keys(req.headers).forEach(key => {
    if (key.toLowerCase().startsWith("x-oc-")) {
      headers[key.toUpperCase()] = req.headers[key];
    }
  });

  // 3. 8秒超时保护
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const r = await fetch(finalUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.body ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : undefined,
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const text = await r.text();
    res.status(r.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e) {
    clearTimeout(timer);
    console.error("[Vercel Relay Error]", e.message);
    res.status(e.name === 'AbortError' ? 504 : 502).json({ success: false, error: e.message });
  }
}
