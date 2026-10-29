const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const BINANCE_HOST = 'fapi.binance.com';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. 清洗请求头，伪装桌面浏览器 User-Agent，避免币安 WAF 报 403
  const clientHeaders = { ...req.headers };
  delete clientHeaders['host'];
  delete clientHeaders['cf-connecting-ip'];
  delete clientHeaders['cf-ipcountry'];
  delete clientHeaders['cf-ray'];
  delete clientHeaders['cf-visitor'];

  const options = {
    hostname: BINANCE_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: {
      ...clientHeaders,
      'host': BINANCE_HOST,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*'
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
