// 上游路由纯函数：默认值、归一化、双写注入、候选解析、思考强度映射。
// 无 IO、无全局状态 —— server.js 与 node:test 共用同一份实现。
//
// 移植自 ClinePassBridge（Go）的 upstream-capability-filter 逻辑：
// - only/order 限制并排序提供方，has 按能力标签过滤候选，三者作用不同；
//   实测仅 only=[deepseek] 仍落私有通道，仅 has 落 fireworks，组合才得 deepseek。
// - 默认值按「精确上游 ID」判断是否补 has，按「id/upstream 含 deepseek」补 providers。
// - 三态语义：缺失/null = 采用默认值，显式 [] = 永久关闭，自定义非空 = 原样保留。

export const DEEPSEEK_1017_UPSTREAM = 'cline-pass/deepseek-v4.1-flash-1017';
export const DEFAULT_HAS = Object.freeze(['vision', 'implicit-caching']);
export const MAX_MODEL_PROVIDERS = 8;
export const MAX_MODEL_HAS = 8;
export const PROVIDER_POLICY_CONFIG = 'config';
export const PROVIDER_POLICY_CLIENT = 'client';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.status = 400;
  }
}

// has 只认精确上游 ID，与客户端别名无关（别名同名的其他模型不得继承能力默认值）。
export function defaultHasFor(upstreamId) {
  return upstreamId === DEEPSEEK_1017_UPSTREAM ? [...DEFAULT_HAS] : null;
}

// providers 用包含匹配，所以无后缀的 deepseek 模型也会默认钉到 deepseek。
export function defaultProvidersFor(id, upstreamId) {
  const haystack = `${id || ''} ${upstreamId || ''}`.toLowerCase();
  return haystack.includes('deepseek') ? ['deepseek'] : null;
}

// 归一化 slug 列表：数组必须、去首尾空白、转小写、拒空、拒内部空白、拒重复、限个数。
// 与参考实现一致，非法输入直接报错而不是静默去重 —— has 是网关精确匹配，写错就没有候选。
export function normalizeSlugs(value, { max = MAX_MODEL_HAS, label = '能力标签' } = {}) {
  if (!Array.isArray(value)) throw new ConfigError(`${label}必须是字符串数组`);
  if (value.length > max) throw new ConfigError(`单个模型最多配置 ${max} 个${label}`);
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new ConfigError(`${label}必须是非空字符串`);
    const slug = raw.trim().toLowerCase();
    if (!slug) throw new ConfigError(`${label}不能为空`);
    if (/\s/.test(slug)) throw new ConfigError(`${label}不能包含空白字符：${slug}`);
    if (seen.has(slug)) throw new ConfigError(`${label}在同一模型内不能重复：${slug}`);
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export function normalizeProviders(value) {
  return normalizeSlugs(value, { max: MAX_MODEL_PROVIDERS, label: '上游' });
}

export function normalizeHas(value) {
  return normalizeSlugs(value, { max: MAX_MODEL_HAS, label: '能力标签' });
}

// 解析 UI/接口里的逗号或空格分隔文本，返回去重后的 slug（不校验，交给 normalizeHas）。
export function parseSlugList(text) {
  return [...new Set(String(text ?? '').split(/[,\s]+/).filter(Boolean).map((s) => s.toLowerCase()))];
}

// 应用三态默认值。undefined/null 表示「从未设置」，显式 [] 表示「主动关闭」。
// 返回值里的 providers/has 为归一化后的新数组或 null（null = 不写该字段）。
export function resolveModelConfig(raw, { id, upstreamId } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const modelId = id ?? input.id ?? upstreamId ?? '';
  const upstream = upstreamId ?? input.upstreamId ?? modelId;

  let providers;
  if (input.providers === undefined || input.providers === null) {
    providers = defaultProvidersFor(modelId, upstream);
  } else {
    providers = normalizeProviders(input.providers);
  }

  let has;
  if (input.has === undefined || input.has === null) {
    has = defaultHasFor(upstream);
  } else {
    has = normalizeHas(input.has);
  }

  return {
    providers: providers ?? [],
    has,
    // 是否来自默认值（用于 UI 提示与升级迁移判断）
    providersFromDefault: input.providers === undefined || input.providers === null,
    hasFromDefault: input.has === undefined || input.has === null,
  };
}

// 路由字段合并。decision 是本次尝试「已算好」的配置决策（only/order/has/sort…），
// 客户端提示按策略与之合并，最后把 only/order 双写到顶层 provider 与
// providerOptions.gateway —— 不猜管道，两条路由路径各自取用自己认识的形式。
//
// has 只写 providerOptions.gateway：能力标签是 gateway 的概念，顶层简写没有这个字段。
// sort 的值由调用方按管道分别给出（gatewaySort / providerSort），因为两条管道的关键字不同。
export function mergeProviderRouting(body, decision = {}, { policy = PROVIDER_POLICY_CONFIG } = {}) {
  const out = { ...(body || {}) };
  const opts = { ...(out.providerOptions || {}) };
  const { gatewaySort, providerSort, ...configured } = decision;

  // 客户端提示：顶层 provider 简写与 gateway 并存时，gateway 逐字段优先。
  let gateway = { ...(opts.gateway || {}) };
  const shorthand = out.provider && typeof out.provider === 'object' ? out.provider : {};
  for (const [key, value] of Object.entries(shorthand)) {
    if (!(key in gateway)) gateway[key] = value;
  }

  // 策略为 config 时配置说了算：客户端提示整体丢弃，而不是让请求失败。
  if (policy === PROVIDER_POLICY_CONFIG) gateway = {};
  // 客户端优先时逐字段保留：它给了就保留（包括显式 [] / null），没给才用配置补。
  for (const [key, value] of Object.entries(configured)) {
    if (!(key in gateway) && value !== undefined && value !== null) gateway[key] = value;
  }
  if (gatewaySort !== undefined && gatewaySort !== null && !('sort' in gateway)) gateway.sort = gatewaySort;

  delete out.provider;

  const otherOpts = Object.entries(opts).filter(([key]) => key !== 'gateway');
  if (Object.keys(gateway).length === 0) {
    if (otherOpts.length === 0) delete out.providerOptions;
    else out.providerOptions = Object.fromEntries(otherOpts);
    return out;
  }

  // 顶层简写镜像 only/order。sort 用该管道自己的关键字单独写，其余 gateway 专属
  // 选项（allowFallbacks 等）不进入这个形式。
  const mirrored = {};
  for (const key of ['only', 'order']) {
    if (key in gateway) mirrored[key] = gateway[key];
  }
  if (providerSort !== undefined && providerSort !== null) mirrored.sort = providerSort;
  if (Object.keys(mirrored).length) out.provider = mirrored;
  out.providerOptions = { ...Object.fromEntries(otherOpts), gateway };
  return out;
}

// 探测请求体：保留能力过滤，剥离提供方允许列表与排序等路由提示，
// 让现有钉住不影响候选列表的读取。has 的字段存在性原样保留（[] 和 null 不还原成缺省）。
export function unpinProbeBody(body) {
  const out = { ...(body || {}) };
  const has = out.providerOptions?.gateway?.has;
  const present = out.providerOptions?.gateway ? Object.hasOwn(out.providerOptions.gateway, 'has') : false;
  delete out.provider;
  delete out.providerOptions;
  if (present) out.providerOptions = { gateway: { has } };
  return { body: out, has, hasPresent: present };
}

const FALLBACKS_RE = /"fallbacksAvailable"\s*:\s*\[(.*?)\]/s;
const SERVED_RE = /"(resolvedProvider|finalProvider)"\s*:\s*"([^"]+)"/g;
const QUOTED_RE = /"([^"]+)"/g;

// 从原始上游帧里读候选与实际上游。路由块可能内联在 SSE 帧里，也可能是错误消息中
// 转义过的 JSON 字符串，统一反转义后一套正则读两种形态。
export function routingCandidates(raw) {
  const text = String(raw ?? '').replaceAll('\\"', '"');
  const candidates = [];
  const seen = new Set();

  const listMatch = FALLBACKS_RE.exec(text);
  if (listMatch) {
    for (const item of listMatch[1].matchAll(QUOTED_RE)) {
      const slug = item[1].trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      candidates.push(slug);
    }
  }

  let served = '';
  for (const match of text.matchAll(SERVED_RE)) {
    const provider = match[2].trim();
    if (!provider) continue;
    // 最终路由决策覆盖临时的 resolvedProvider，即使后者出现在更早的帧里。
    if (!served || match[1] === 'finalProvider') served = provider;
    if (match[1] === 'finalProvider') break;
  }

  // fallbacksAvailable 不含实际提供方，只在网关确实回报了候选项时补回去：
  // 候选为空不能证明 served 可被钉住，私有通道也会回报 served 但没有候选。
  if (candidates.length && served && !seen.has(served.toLowerCase())) {
    candidates.push(served.toLowerCase());
  }
  return { candidates, served };
}

// ---------- 思考强度映射 ----------
// 只转换 Chat Completions 顶层 reasoning_effort，不改 provider 命名空间，也不开关思考本身。
const REASONING_SOURCES = ['unset', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const REASONING_TARGETS = ['unset', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function defaultReasoningRules() {
  return {
    unset: 'unset', none: 'none', minimal: 'low', low: 'low',
    medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max',
  };
}

// DeepSeek 模型预填规则表但仍需手动开启；其他模型预填空表。
export function defaultReasoningMapping(upstreamId) {
  const deepseek = String(upstreamId ?? '').toLowerCase().includes('deepseek');
  return { enabled: false, rules: deepseek ? defaultReasoningRules() : {} };
}

export function normalizeReasoningMapping(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('思考强度映射必须是对象');
  const enabled = value.enabled === true;
  const raw = value.rules === undefined || value.rules === null ? {} : value.rules;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('思考强度映射的 rules 必须是对象');
  const rules = {};
  for (const [from, to] of Object.entries(raw)) {
    if (!REASONING_SOURCES.includes(from)) throw new ConfigError(`无效的思考强度来源：${from}`);
    if (!REASONING_TARGETS.includes(to)) throw new ConfigError(`无效的思考强度目标：${to}`);
    rules[from] = to;
  }
  return { enabled, rules };
}

// 在首次尝试前应用一次，落库的日志元数据与实际外发值来自同一份快照。
export function applyReasoningMapping(body, mapping) {
  if (!body || !mapping || mapping.enabled !== true) return { body, applied: null };
  const rules = mapping.rules || {};
  let from = 'unset';
  const raw = body.reasoning_effort;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') return { body, applied: null }; // 保留非法值交给上游校验
    const value = raw.trim().toLowerCase();
    if (value) {
      if (value === 'unset') return { body, applied: null }; // unset 是配置哨兵，不是可接受的输入值
      from = value;
    }
  }
  // 显式声明了嵌套思考指令时不算「未设置」，不去补默认强度。
  if (from === 'unset' && (body.reasoning != null || body.thinking != null)) return { body, applied: null };
  if (!Object.hasOwn(rules, from)) return { body, applied: null };
  const to = rules[from];
  const out = { ...body };
  if (to === 'unset') delete out.reasoning_effort;
  else out.reasoning_effort = to;
  return { body: out, applied: { from, to } };
}
