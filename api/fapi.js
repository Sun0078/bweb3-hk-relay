export const config = {
  runtime: 'edge',
  regions: ['hkg1'], // 强制全球所有请求汇聚到香港边缘节点出站
};

export default async function handler(request) {
  const url = new URL(request.url);
  // 将访问 /api/fapi/... 完整映射到 https://fapi.binance.com/fapi/...
  const targetPath = url.pathname.replace(/^\/api\/fapi/, '/fapi');
  const targetUrl = `https://fapi.binance.com${targetPath}${url.search}`;

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
