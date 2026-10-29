const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const BINANCE_HOST = 'fapi.binance.com';

const server = http.createServer((req, res) => {
  // 允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 转发路径与参数
  const options = {
    hostname: BINANCE_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: BINANCE_HOST,
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy Gateway Error', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Binance Relay Server running on port ${PORT}`);
});
