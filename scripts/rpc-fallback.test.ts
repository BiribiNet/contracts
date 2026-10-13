import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPublicClient } from 'viem';
import { createRpcFallback, parseRpcUrls, resolveSepoliaRpcUrls } from './utils/rpcFallback';

async function endpoint(handler: (body: any) => { status?: number; result?: unknown; error?: unknown }) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    const response = handler(body);
    res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...response }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test('RPC lists preserve priority, support JSON and whitespace, and reject invalid endpoints without printing them', () => {
  assert.deepEqual(parseRpcUrls('[" https://a.example/rpc ","https://b.example/rpc","https://a.example/rpc"]'), [
    'https://a.example/rpc',
    'https://b.example/rpc',
  ]);
  assert.deepEqual(parseRpcUrls('https://a.example/rpc,\nhttps://b.example/rpc'), [
    'https://a.example/rpc',
    'https://b.example/rpc',
  ]);
  for (const value of ['', '[]', '[null]', '[invalid', 'wss://secret.example/private-key'])
    assert.throws(() => parseRpcUrls(value));
});

test('explicit environment URLs override saved settings and the legacy single URL remains supported', () => {
  const saved = (key: string) => (key.endsWith('URLS') ? '["https://saved.example"]' : undefined);
  assert.deepEqual(resolveSepoliaRpcUrls({ ARBITRUM_SEPOLIA_RPC_URL: 'https://override.example' }, saved), [
    'https://override.example',
  ]);
  assert.deepEqual(
    resolveSepoliaRpcUrls(
      {
        ARBITRUM_SEPOLIA_RPC_URLS: 'https://a.example,https://b.example',
        ARBITRUM_SEPOLIA_RPC_URL: 'https://ignored.example',
      },
      saved,
    ),
    ['https://a.example', 'https://b.example'],
  );
  assert.deepEqual(resolveSepoliaRpcUrls({}, saved), ['https://saved.example']);
});

for (const failure of [
  { status: 429 },
  { status: 503 },
  { error: { code: -32005, message: 'Request exceeds defined limit.' } },
]) {
  test(`reads fail over after ${JSON.stringify(failure)}`, async () => {
    const a = await endpoint((body) => (body.method === 'eth_chainId' ? { result: '0x66eee' } : failure));
    const b = await endpoint((body) => ({ result: body.method === 'eth_chainId' ? '0x66eee' : '0x2a' }));
    try {
      const client = createPublicClient({ transport: createRpcFallback([a.url, b.url], 421614) });
      assert.equal(await client.getBlockNumber(), 42n);
      assert.ok(a.requests.some((request) => request.method === 'eth_blockNumber'));
      assert.ok(b.requests.some((request) => request.method === 'eth_blockNumber'));
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
}

test('wrong-chain endpoints cannot serve chain reads or signed transactions', async () => {
  const a = await endpoint(() => ({ result: '0x1' }));
  const b = await endpoint((body) => ({ result: body.method === 'eth_chainId' ? '0x66eee' : '0x2a' }));
  try {
    const client = createPublicClient({ transport: createRpcFallback([a.url, b.url], 421614) });
    assert.equal(await client.getBlockNumber(), 42n);
    assert.ok(a.requests.every((request) => request.method === 'eth_chainId'));
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('transaction failover sends identical signed bytes to the next endpoint', async () => {
  const hash = '0x' + 'a'.repeat(64);
  const a = await endpoint((body) => (body.method === 'eth_chainId' ? { result: '0x66eee' } : { status: 503 }));
  const b = await endpoint((body) => ({ result: body.method === 'eth_chainId' ? '0x66eee' : hash }));
  try {
    const client = createPublicClient({ transport: createRpcFallback([a.url, b.url], 421614) });
    assert.equal(await client.sendRawTransaction({ serializedTransaction: '0x1234' }), hash);
    const sends = [...a.requests, ...b.requests].filter((request) => request.method === 'eth_sendRawTransaction');
    assert.equal(sends.length, 2);
    assert.deepEqual(
      sends.map((request) => request.params),
      [['0x1234'], ['0x1234']],
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('execution reverts remain failures rather than being sent to another RPC', async () => {
  const a = await endpoint((body) =>
    body.method === 'eth_chainId' ? { result: '0x66eee' } : { error: { code: 3, message: 'execution reverted' } },
  );
  const b = await endpoint(() => ({ result: '0x2a' }));
  try {
    const client = createPublicClient({ transport: createRpcFallback([a.url, b.url], 421614) });
    await assert.rejects(client.getBlockNumber());
    assert.equal(b.requests.length, 0);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
