const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const BINANCE_HOST = 'fapi.binance.com';

// 内存轻量缓存池（杜绝 418 频次轰炸）
const cache = new Map();
const CACHE_TTL_MS = 5000; // 缓存 5 秒

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlPath = req.url;

  // 1. 如果命中 5 秒内的内存缓存，直接 1ms 秒回，不打扰币安
  const cached = cache.get(urlPath);
  if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Cache': 'HIT-RENDER-MEM'
    });
    return res.end(cached.data);
  }

  // 2. 构造干净的白名单 Header，防止 403
  const options = {
    hostname: BINANCE_HOST,
    port: 443,
    path: urlPath,
    method: req.method,
    headers: {
      'host': BINANCE_HOST,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let responseBody = '';

    proxyRes.on('data', (chunk) => {
      responseBody += chunk;
    });

    proxyRes.on('end', () => {
      // 只有在正常 200 响应时才存入缓存
      if (proxyRes.statusCode === 200) {
        cache.set(urlPath, {
          time: Date.now(),
          data: responseBody
        });
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(responseBody);
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy Gateway Error', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Binance Anti-418 Relay Server running on port ${PORT}`);
});
