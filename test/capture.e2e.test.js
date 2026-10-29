// 端到端校验：真正发出请求时，DeepSeek 的默认钉住组合是否落到外发请求体里。
// 用 mock 上游捕获 server.js 实际发出的 body，避免只看配置接口自说自话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_PORT = 3611;
const SERVER_PORT = 3612;

// 起一个假上游：记录收到的每个请求体，按需返回错误或成功。
function startMockUpstream() {
  const received = [];
  let reply = (body) => ({
    status: 200,
    json: {
      id: 'chatcmpl-mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      provider_metadata: {
        gateway: { routing: { finalProvider: 'deepseek', canonicalSlug: 'deepseek/deepseek-v4.1-flash-1017', fallbacksAvailable: ['deepseek', 'fireworks'] } },
      },
      model: 'deepseek/deepseek-v4.1-flash-1017',
    },
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 忽略非 JSON */ }
      received.push(body);
      const out = reply(body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return {
    received,
    setReply(fn) { reply = fn; },
    listen() {
      return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve()));
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

// 用子进程起真实 server.js，DATA_DIR 指到临时目录以便注入账号与配置。
async function startBridge(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(SERVER_PORT), BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];
  child.stderr.on('data', (d) => errors.push(d.toString()));
  // 轮询 /api/meta 直到服务就绪，避免固定 sleep 带来的偶发失败。
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/meta`);
      if (res.ok) return { child, errors };
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server 未就绪：${errors.join('')}`);
}

function makeDataDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-e2e-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

const baseConfig = (overrides = {}) => ({
  port: SERVER_PORT,
  upstreamBase: `http://127.0.0.1:${UPSTREAM_PORT}`,
  accounts: [{ name: 'test', key: 'sk_test_123', enabled: true }],
  accountMode: 'single',
  activeAccount: 0,
  knownModels: ['cline-pass/deepseek-v4.1-flash-1017', 'cline-pass/glm-5.3'],
  perModel: {},
  ...overrides,
});

async function chat(model, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_test_123' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
  return { status: res.status, json: await res.json() };
}

test('全新安装：1017 默认外发 only=order=deepseek 且带 has 能力过滤', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  const { child } = await startBridge(dir);
  try {
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    // 顶层 provider 与 providerOptions.gateway 双写，两条路由路径都能读到
    assert.deepEqual(sent.provider?.only, ['deepseek']);
    assert.deepEqual(sent.provider?.order, ['deepseek']);
    assert.deepEqual(sent.providerOptions?.gateway?.only, ['deepseek']);
    assert.deepEqual(sent.providerOptions?.gateway?.has, ['vision', 'implicit-caching']);
    assert.equal(sent.provider?.has, undefined, 'has 不得写进顶层 provider');
  } finally {
    child.kill();
    await mock.close();
  }
});

test('非 DeepSeek 模型不被默认钉住，也不带能力过滤', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  const { child } = await startBridge(dir);
  try {
    const r = await chat('cline-pass/glm-5.3');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    assert.equal(sent.provider, undefined);
    assert.equal(sent.providerOptions, undefined);
  } finally {
    child.kill();
    await mock.close();
  }
});

test('显式清空 has 后不再回填默认能力（三态语义）', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig({
    perModel: { 'cline-pass/deepseek-v4.1-flash-1017': { upstreams: ['deepseek'], exclude: [], has: [] } },
  }));
  const { child } = await startBridge(dir);
  try {
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    assert.equal(sent.providerOptions?.gateway?.has, undefined, '清空的能力过滤不能被重新种回');
    assert.deepEqual(sent.providerOptions?.gateway?.only, ['deepseek']);
  } finally {
    child.kill();
    await mock.close();
  }
});

test('清空 has 经配置接口落盘并重载后仍保持空数组', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  let child = (await startBridge(dir)).child;
  try {
    const saved = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        perModel: { 'cline-pass/deepseek-v4.1-flash-1017': { upstreams: ['deepseek'], exclude: [], has: [] } },
      }),
    });
    assert.equal(saved.status, 200);
    // 重载：新进程读同一个 DATA_DIR
    child.kill();
    child = (await startBridge(dir)).child;
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    assert.equal(sent.providerOptions?.gateway?.has, undefined);
  } finally {
    child.kill();
    await mock.close();
  }
});

test('client 策略下客户端只保留自己的 only，其余由配置补齐', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig({ providerPolicy: 'client' }));
  const { child } = await startBridge(dir);
  try {
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017', {
      providerOptions: { gateway: { only: ['wafer'] } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    assert.deepEqual(sent.providerOptions?.gateway?.only, ['wafer'], '客户端 only 胜出');
    assert.deepEqual(sent.providerOptions?.gateway?.has, ['vision', 'implicit-caching'], 'has 由配置补齐');
  } finally {
    child.kill();
    await mock.close();
  }
});

test('config 策略（默认）丢弃客户端路由提示', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  const { child } = await startBridge(dir);
  try {
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017', {
      provider: { only: ['novita'] },
      providerOptions: { gateway: { only: ['alibaba'], has: ['prompt-caching'] } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = mock.received.at(-1);
    assert.deepEqual(sent.providerOptions?.gateway?.only, ['deepseek']);
    assert.deepEqual(sent.providerOptions?.gateway?.has, ['vision', 'implicit-caching']);
  } finally {
    child.kill();
    await mock.close();
  }
});

test('非法能力配置被接口拒绝，且不会半写入', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  const { child } = await startBridge(dir);
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        perModel: { 'cline-pass/deepseek-v4.1-flash-1017': { upstreams: [], exclude: [], has: ['two words'] } },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /空白/);
    // 配置未被改动：默认值仍然生效
    const r = await chat('cline-pass/deepseek-v4.1-flash-1017');
    assert.equal(r.status, 200);
    assert.deepEqual(mock.received.at(-1).providerOptions?.gateway?.has, ['vision', 'implicit-caching']);
  } finally {
    child.kill();
    await mock.close();
  }
});

test('思考强度映射在首次尝试前生效并记入日志', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig({
    perModel: {
      'cline-pass/deepseek-v4.1-flash-1017': {
        upstreams: [], exclude: [],
        reasoningMapping: { enabled: true, rules: { medium: 'high', unset: 'low' } },
      },
    },
  }));
  const { child } = await startBridge(dir);
  try {
    await chat('cline-pass/deepseek-v4.1-flash-1017', { reasoning_effort: 'Medium' });
    assert.equal(mock.received.at(-1).reasoning_effort, 'high');
    const hist = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/history`)).json();
    assert.deepEqual(hist.history[0].reasoning, { from: 'medium', to: 'high' });
  } finally {
    child.kill();
    await mock.close();
  }
});

test('探测保留已保存的 has 并剥离 only/order', async () => {
  const mock = startMockUpstream();
  await mock.listen();
  const dir = makeDataDir(baseConfig());
  const { child } = await startBridge(dir);
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash-1017' }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const probe = mock.received.at(-1);
    assert.equal(probe.provider, undefined, '探测必须剥离顶层 provider');
    assert.deepEqual(probe.providerOptions, { gateway: { has: ['vision', 'implicit-caching'] } });
    const out = await res.json();
    assert.deepEqual(out.upstreams, ['deepseek', 'fireworks']);
    assert.equal(out.lastProvider, 'deepseek');
  } finally {
    child.kill();
    await mock.close();
  }
});
