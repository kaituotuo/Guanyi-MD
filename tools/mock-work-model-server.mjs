import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = Number(process.env.GUANYI_MOCK_MODEL_PORT) || 4189;

function json(response, status, payload) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.url?.endsWith('/models')) return json(response, 200, { data: [{ id: 'guanyi-work-chain-mock' }] });
  if (!request.url?.endsWith('/chat/completions') || request.method !== 'POST') return json(response, 404, { error: { message: 'not found' } });

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_error) { return json(response, 400, { error: { message: 'invalid json' } }); }
    const system = String(payload?.messages?.[0]?.content || '');
    const content = system.includes('检索规划器')
      ? JSON.stringify({
        route: 'direct',
        queries: ['观绎 名字由来', '周易 系辞 观', '论语 绎之为贵'],
        targetDocumentIds: ['D1', 'D999'],
        facets: ['“观”的出处', '“绎”的出处']
      })
      : JSON.stringify({
        supported: true,
        answer: '观绎的命名分别取意于观照万象与抽绎本心，回答依据来自本地文档中的经典出处。',
        evidence: [
          { id: 'W1', explanation: '说明“观”的出处与观照含义。' },
          { id: 'W2', explanation: '说明“绎”的出处与推阐含义。' }
        ],
        expression: '俯仰观物，绎述我心。',
        confidence: 'high'
      });
    return json(response, 200, { choices: [{ message: { content } }] });
  });
});

server.listen(port, host, () => process.stdout.write(`mock work model: http://${host}:${port}/v1\n`));
