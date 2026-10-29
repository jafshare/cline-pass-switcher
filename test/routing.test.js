import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  DEEPSEEK_1017_UPSTREAM,
  applyReasoningMapping,
  defaultHasFor,
  defaultProvidersFor,
  defaultReasoningMapping,
  mergeProviderRouting,
  normalizeHas,
  normalizeProviders,
  normalizeReasoningMapping,
  parseSlugList,
  resolveModelConfig,
  routingCandidates,
  unpinProbeBody,
} from '../lib/routing.js';

// 这批用例对齐 ClinePassBridge 的 capability_defaults / capability_has /
// provider_routing / model_providers 测试，锁住移植后最容易回归的语义。

test('默认能力只认精确上游 ID，与客户端别名无关', () => {
  assert.deepEqual(defaultHasFor(DEEPSEEK_1017_UPSTREAM), ['vision', 'implicit-caching']);
  for (const upstream of [
    'cline-pass/deepseek-v4.1-flash',            // 无后缀模型不补能力
    'cline-pass/deepseek-v4.1-flash-1017-preview', // 近似 ID 不算
    'deepseek-v4.1-flash-1017',                   // 缺 cline-pass/ 前缀不算
    'cline-pass/DeepSeek-v4.1-flash-1017',        // 大小写不同不算
    'cline-pass/glm-5.3',
  ]) {
    assert.equal(defaultHasFor(upstream), null, `${upstream} 不应获得能力默认值`);
  }
});

test('默认上游用包含匹配，所以无后缀 DeepSeek 也会默认钉 deepseek', () => {
  assert.deepEqual(defaultProvidersFor('x', 'cline-pass/deepseek-v4-pro'), ['deepseek']);
  assert.deepEqual(defaultProvidersFor('deepseek-flash', 'cline-pass/other'), ['deepseek']);
  assert.equal(defaultProvidersFor('gpt', 'cline-pass/glm-5.3'), null);
});

test('has 三态：缺失/null 取默认，显式 [] 关闭，自定义值原样保留', () => {
  const id = 'cline-pass/deepseek-v4.1-flash-1017';
  assert.deepEqual(resolveModelConfig({}, { id, upstreamId: id }).has, ['vision', 'implicit-caching']);
  assert.deepEqual(resolveModelConfig({ has: null }, { id, upstreamId: id }).has, ['vision', 'implicit-caching']);
  assert.deepEqual(resolveModelConfig({ has: [] }, { id, upstreamId: id }).has, []);
  assert.deepEqual(resolveModelConfig({ has: ['prompt-caching'] }, { id, upstreamId: id }).has, ['prompt-caching']);
  // 显式 [] 不得被判成「来自默认值」
  assert.equal(resolveModelConfig({ has: [] }, { id, upstreamId: id }).hasFromDefault, false);
  assert.equal(resolveModelConfig({}, { id, upstreamId: id }).hasFromDefault, true);
});

test('能力默认值按别名独立，改一个别名不影响另一个', () => {
  const id = 'cline-pass/deepseek-v4.1-flash-1017';
  const a = resolveModelConfig({}, { id: 'first', upstreamId: id });
  const b = resolveModelConfig({}, { id: 'second', upstreamId: id });
  a.has[0] = 'prompt-caching';
  assert.deepEqual(b.has, ['vision', 'implicit-caching']);
  assert.deepEqual(defaultHasFor(id), ['vision', 'implicit-caching'], '默认值表不能被调用方改动');
});

test('非 1017 上游即使别名长得像 1017 也不补能力', () => {
  const r = resolveModelConfig({}, { id: 'deepseek-v4.1-flash-1017', upstreamId: 'cline-pass/deepseek-v4.1-flash' });
  assert.equal(r.has, null);
});

test('has 归一化：转小写、去首尾空白、保留顺序', () => {
  assert.deepEqual(normalizeHas([' Vision', ' implicit-caching ']), ['vision', 'implicit-caching']);
  assert.deepEqual(normalizeProviders([' DeepSeek ', 'WAFER']), ['deepseek', 'wafer']);
});

test('非法能力配置被拒绝而不是静默去重', () => {
  assert.throws(() => normalizeHas(['two words']), ConfigError);
  assert.throws(() => normalizeHas(['']), ConfigError);
  assert.throws(() => normalizeHas(['vision', 'Vision']), ConfigError, '大小写归一后重复也算重复');
  assert.throws(() => normalizeHas('vision'), ConfigError, '必须是数组');
  assert.throws(() => normalizeHas(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']), ConfigError, '最多 8 个');
});

test('解析 UI 文本为 slug 列表', () => {
  assert.deepEqual(parseSlugList('Vision, implicit-caching ,vision'), ['vision', 'implicit-caching']);
  assert.deepEqual(parseSlugList(''), []);
  assert.deepEqual(parseSlugList(null), []);
});

// ---------- 请求体注入 ----------

test('only/order 同时写入顶层 provider 与 providerOptions.gateway', () => {
  const out = mergeProviderRouting({ messages: [] }, { only: ['deepseek'], order: ['deepseek'], has: ['vision'] });
  assert.deepEqual(out.provider, { only: ['deepseek'], order: ['deepseek'] });
  assert.deepEqual(out.providerOptions.gateway, { only: ['deepseek'], order: ['deepseek'], has: ['vision'] });
});

test('has 只写 gateway，绝不写顶层 provider', () => {
  const out = mergeProviderRouting({ messages: [] }, { has: ['vision', 'implicit-caching'] });
  assert.equal(out.provider, undefined, '没有 only/order 时不应凭空造出顶层 provider');
  assert.deepEqual(out.providerOptions.gateway, { has: ['vision', 'implicit-caching'] });
});

test('gateway 专属选项不混进顶层简写，sort 各管道用各自关键字', () => {
  const out = mergeProviderRouting({ messages: [] }, {
    only: ['deepseek'], allowFallbacks: false, gatewaySort: 'cost', providerSort: 'price',
  });
  assert.deepEqual(out.providerOptions.gateway, { only: ['deepseek'], allowFallbacks: false, sort: 'cost' });
  assert.deepEqual(out.provider, { only: ['deepseek'], sort: 'price' });
});

test('config 策略丢弃客户端路由提示，但其他 provider 命名空间保留', () => {
  const out = mergeProviderRouting(
    {
      messages: [],
      provider: { only: ['novita'], order: ['baseten'] },
      providerOptions: { gateway: { only: ['alibaba'], sort: 'price' }, deepseek: { reasoningEffort: 'max' } },
    },
    { only: ['deepseek'] },
    { policy: 'config' },
  );
  assert.deepEqual(out.providerOptions.gateway, { only: ['deepseek'] });
  assert.deepEqual(out.providerOptions.deepseek, { reasoningEffort: 'max' });
});

test('client 策略逐字段保留客户端值，配置只补缺失项', () => {
  const out = mergeProviderRouting(
    { messages: [], providerOptions: { gateway: { only: ['alibaba'] } } },
    { only: ['deepseek'], order: ['deepseek'], has: ['vision'] },
    { policy: 'client' },
  );
  assert.deepEqual(out.providerOptions.gateway.only, ['alibaba'], '客户端 only 胜出');
  assert.deepEqual(out.providerOptions.gateway.order, ['deepseek'], 'order 由配置补齐');
  assert.deepEqual(out.providerOptions.gateway.has, ['vision'], 'has 由配置补齐');
});

test('client 策略下客户端显式 [] / null 原样保留，不被配置回填', () => {
  for (const raw of [[], null]) {
    const out = mergeProviderRouting(
      { messages: [], providerOptions: { gateway: { has: raw, only: raw } } },
      { only: ['deepseek'], has: ['vision'] },
      { policy: 'client' },
    );
    assert.deepEqual(out.providerOptions.gateway.has, raw);
    assert.deepEqual(out.providerOptions.gateway.only, raw);
  }
});

test('客户端顶层 provider 简写会并入 gateway，gateway 同名字段优先', () => {
  const out = mergeProviderRouting(
    { messages: [], provider: { only: ['novita'], sort: 'latency' }, providerOptions: { gateway: { only: ['alibaba'] } } },
    {},
    { policy: 'client' },
  );
  assert.deepEqual(out.providerOptions.gateway.only, ['alibaba']);
  assert.equal(out.providerOptions.gateway.sort, 'latency');
});

test('无任何路由字段时不产生空 providerOptions', () => {
  const out = mergeProviderRouting({ messages: [] }, {}, { policy: 'config' });
  assert.equal(out.provider, undefined);
  assert.equal(out.providerOptions, undefined);
});

test('注入不修改入参对象', () => {
  const body = { messages: [], providerOptions: { deepseek: { reasoningEffort: 'max' } } };
  const snapshot = JSON.stringify(body);
  mergeProviderRouting(body, { only: ['deepseek'], has: ['vision'] });
  assert.equal(JSON.stringify(body), snapshot);
});

// ---------- 探测 ----------

test('探测体保留 has、剥离 only/order', () => {
  const probe = {
    messages: [],
    provider: { only: ['deepseek'], order: ['wafer'] },
    providerOptions: { gateway: { only: ['deepseek'], order: ['wafer'], sort: 'latency', allowFallbacks: false, has: ['vision'] } },
  };
  const { body, has, hasPresent } = unpinProbeBody(probe);
  assert.equal(hasPresent, true);
  assert.deepEqual(has, ['vision']);
  assert.equal('provider' in body, false);
  assert.deepEqual(body.providerOptions, { gateway: { has: ['vision'] } });
});

test('探测保留 has 的字段存在性：[] 和 null 不还原成缺省', () => {
  for (const raw of [[], null]) {
    const { body, has, hasPresent } = unpinProbeBody({
      messages: [], providerOptions: { gateway: { only: ['deepseek'], has: raw } },
    });
    assert.equal(hasPresent, true);
    assert.deepEqual(has, raw);
    assert.equal(Object.hasOwn(body.providerOptions.gateway, 'has'), true);
  }
});

test('没有能力条件时探测体不留下空 providerOptions', () => {
  const { body, hasPresent } = unpinProbeBody({ messages: [], provider: { only: ['deepseek'] } });
  assert.equal(hasPresent, false);
  assert.equal('providerOptions' in body, false);
});

test('finalProvider 覆盖 resolvedProvider，即使出现在更早的帧里', () => {
  for (const raw of [
    '{"resolvedProvider":"wafer","finalProvider":"deepseek","fallbacksAvailable":["baseten"]}',
    '{"finalProvider":"deepseek","resolvedProvider":"wafer","fallbacksAvailable":["baseten"]}',
    'data: {"resolvedProvider":"wafer","fallbacksAvailable":["baseten"]}\n\ndata: {"finalProvider":"deepseek"}\n\n',
    '{"error":{"message":"failed: {\\"resolvedProvider\\":\\"wafer\\",\\"finalProvider\\":\\"deepseek\\",\\"fallbacksAvailable\\":[\\"baseten\\"]}"}}',
  ]) {
    const { candidates, served } = routingCandidates(raw);
    assert.equal(served, 'deepseek', raw);
    assert.deepEqual(candidates, ['baseten', 'deepseek'], raw);
  }
});

test('不凭空造候选：私有通道与空候选都不补 served', () => {
  assert.deepEqual(routingCandidates('{"resolvedProvider":"openai-compatible-private"}'), {
    candidates: [], served: 'openai-compatible-private',
  });
  assert.deepEqual(routingCandidates('{"finalProvider":"deepseek","fallbacksAvailable":[]}'), {
    candidates: [], served: 'deepseek',
  });
  assert.deepEqual(routingCandidates('{"finalProvider":"deepseek","fallbacksAvailable":["deepseek"]}'), {
    candidates: ['deepseek'], served: 'deepseek',
  });
});

test('候选去重并转小写', () => {
  const { candidates } = routingCandidates('{"fallbacksAvailable":["Fireworks","fireworks","Alibaba"," deepseek "]}}');
  assert.deepEqual(candidates, ['fireworks', 'alibaba', 'deepseek']);
});

// ---------- 思考强度映射 ----------

test('DeepSeek 预填规则表但默认关闭，其他模型预填空表', () => {
  const ds = defaultReasoningMapping('cline-pass/deepseek-v4.1-flash-1017');
  assert.equal(ds.enabled, false);
  assert.equal(ds.rules.medium, 'high');
  assert.equal(ds.rules.ultra, 'max');
  const other = defaultReasoningMapping('cline-pass/glm-5.3');
  assert.deepEqual(other.rules, {});
});

test('映射只在启用时生效，未设置也能补值', () => {
  const rules = { unset: 'high', medium: 'max' };
  assert.equal(applyReasoningMapping({ messages: [] }, { enabled: false, rules }).applied, null);
  const applied = applyReasoningMapping({ messages: [] }, { enabled: true, rules });
  assert.deepEqual(applied.applied, { from: 'unset', to: 'high' });
  assert.equal(applied.body.reasoning_effort, 'high');
  const changed = applyReasoningMapping({ reasoning_effort: 'Medium' }, { enabled: true, rules });
  assert.equal(changed.body.reasoning_effort, 'max');
});

test('目标 unset 删除顶层字段，其他强度保留原值', () => {
  const removed = applyReasoningMapping({ reasoning_effort: 'low' }, { enabled: true, rules: { low: 'unset' } });
  assert.equal('reasoning_effort' in removed.body, false);
  const passthrough = applyReasoningMapping({ reasoning_effort: 'low' }, { enabled: true, rules: { high: 'max' } });
  assert.equal(passthrough.applied, null);
  assert.equal(passthrough.body.reasoning_effort, 'low');
});

test('已有嵌套思考指令时不补默认强度', () => {
  const r = applyReasoningMapping({ thinking: { type: 'enabled' } }, { enabled: true, rules: { unset: 'max' } });
  assert.equal(r.applied, null);
});

test('非法映射配置被拒绝', () => {
  assert.throws(() => normalizeReasoningMapping({ rules: { supreme: 'max' } }), ConfigError);
  assert.throws(() => normalizeReasoningMapping({ rules: { low: 'supreme' } }), ConfigError);
  assert.equal(normalizeReasoningMapping(undefined), null);
  assert.deepEqual(normalizeReasoningMapping({ enabled: true, rules: { low: 'high' } }), { enabled: true, rules: { low: 'high' } });
});
