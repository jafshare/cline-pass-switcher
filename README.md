# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

**零依赖**的 Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 🧠 **DeepSeek 组合钉住与能力过滤（2026-10-29 新增）** —— `only/order` 限制提供方，`has` 按能力标签过滤候选；`cline-pass/deepseek-v4.1-flash-1017` 默认同时下发两者，仅设任一都不够（见下节）
- 🎚️ **思考强度映射** —— 按模型把客户端 `reasoning_effort` 转成上游接受的值，DeepSeek 预填规则表、默认关闭
- 👥 **账号池** —— 多账号管理、手动切换、轮询均衡、逐账号连通性测试与用量统计
- 📊 **观测** —— 每条请求自动记录实际命中的渠道、背后模型、耗时（含流式）
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
node server.js        # 仅需 Node ≥ 18，无需 npm install
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。
没有 key 也能启动：页面会提示配置入口。

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端访问代理的凭据） |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ name, key, enabled }]` |
| `accountMode` | `single` 手动指定 / `roundrobin` 轮询 |
| `activeAccount` | 单账号模式下使用的下标 |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `providerPolicy` | `config` 配置优先（默认）/ `client` 客户端优先，见上文「上游策略」 |
| `knownModels` | 订阅模型清单（控制台主表） |
| `perModel` | 每模型的钉住配置：`{ upstreams: string[], exclude: string[], has: string[]\|null, pinMode: strict\|preferred, sort: cost\|ttft\|tps, reasoningMapping: { enabled, rules } }` |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。
参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`；直连管道顶层 `provider` 即实际上游；
2. **保留能力条件探测**（主路径）：按已保存的 `has` 发一个很小的真实请求，剥离 `only/order` 等提供方提示，从原始响应帧读候选 —— 这样「候选」才是符合当前能力条件的候选；
3. **假上游探测**（兜底）：仅当上游既没回报候选也没回报提供方时，才带不存在的 `only:["__probe__"]` 让网关在路由层报错并列出精确的可用渠道清单（零 token，两条管道的清单不一致，要分别取）；
4. **OpenRouter 公开接口** `GET /api/v1/models/{slug}/endpoints`：补充上下文长度/在线率（对直连管道有直接参考意义）。

### DeepSeek 组合钉住与能力过滤（`has`）

`only` 限制提供方，`has` 按能力标签过滤候选，两者作用不同。**实测（2026-10-23，单账号）：仅 `only=[deepseek]` 仍落 `openai-compatible-private` 私有通道，仅 `has=[vision,implicit-caching]` 会落 `fireworks`，两者组合才得到 `finalProvider=deepseek`。** 所以指定 DeepSeek 时必须一起设置。

```json
{
  "model": "cline-pass/deepseek-v4.1-flash-1017",
  "messages": [{ "role": "user", "content": "只回复 OK" }],
  "providerOptions": {
    "gateway": { "only": ["deepseek"], "has": ["vision", "implicit-caching"] }
  }
}
```

**默认值规则**（判据不同，不可混用）：

| 配置 | 判据 | 默认值 |
|---|---|---|
| `providers` | `id` 或上游 ID 含 `deepseek`（包含匹配） | `["deepseek"]` |
| `has` | 上游 ID **精确等于** `cline-pass/deepseek-v4.1-flash-1017` | `["vision", "implicit-caching"]` |

因此无后缀的 `deepseek-v4.1-flash` 会默认钉 `deepseek`，但**不会**获得能力过滤 —— 实测该模型即使组合设置仍落私有通道。

**三态语义**（这是最容易回归的地方）：

| 配置中的 `has` | 含义 | 行为 |
|---|---|---|
| 键缺失 / `null` | 从未设置 | 采用模型默认值 |
| `[]` | 操作者显式清空 | **永久关闭，不再回填** |
| 非空数组 | 自定义 | 原样保留（转小写、去空白、拒重复） |

升级时，已有 1017 映射若此前从未配置能力，会开始带上两项能力；已有提供方列表保持原值。想退出能力过滤，在界面清空输入框保存即可，重载后仍保持清空。

**写入位置**：`only`/`order` 同时写入顶层 `provider` 与 `providerOptions.gateway`（两条路由路径各自取用自己认识的形式，不猜管道）；`has` **只**写入 `providerOptions.gateway`。

**上游策略** `<code>providerPolicy</code>`：

- `config`（默认）：忽略客户端传入的 `provider` / `providerOptions.gateway` 路由提示，由本页配置决定；
- `client`：客户端传入的字段逐优先，缺失的字段由配置补齐；客户端显式发送 `has: []` 或 `has: null` 也原样保留。

**判断是否命中**：看请求历史的「实际上游」列，对应 `routing.finalProvider`。仅看 `canonicalSlug` 中的模型名不够 —— `canonicalSlug` 已是 `deepseek/...` 时 `finalProvider` 仍可能是 `fireworks`。

![能力过滤与思考强度](docs/screenshot-capability-filter.png)

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

---

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 账号池增删改、显隐密钥、逐账号连通性测试、单账号/轮询模式、用量统计 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求历史 | 自动记录每条请求的账号、实际渠道、耗时、尝试序列（最近 100 条，含流式） |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式、错误统一为
`{"error":{"message":...}}`、附加 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account` 等响应头。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

**Q：只用官方 API 写 `provider.only` 为什么不生效？**
对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。本项目对 `only/order` 两种形式都写，所以不必判断模型走哪条管道。

**Q：想钉 DeepSeek，为什么填了 `only=[deepseek]` 还是走私有通道？**
因为公开候选路由还需要能力条件。加上 `has=[vision,implicit-caching]`（1017 模型默认已带，也可点「应用 DeepSeek 预设」恢复）。两者作用不同：`only` 限制提供方，`has` 过滤候选；实测仅 `only` 仍落 `openai-compatible-private`，仅 `has` 落 `fireworks`，组合才是 `deepseek`。

**Q：清空了能力过滤，为什么又自己回来了？**
不会。三态语义下「键缺失/null」才补默认值，界面清空存的是 `[]`（显式关闭），重载后保持清空。若用接口手写配置，请写 `"has": []`；删除该键等于「从未设置」，会被补默认值。

**Q：无后缀的 `deepseek-v4.1-flash` 配了组合还是私有通道？**
实测该模型即使 `only + has` 组合也仍落私有通道，只有 `-1017` 变体命中 `deepseek`。这是上游路由行为，不是配置错误。

**Q：两条管道的渠道清单为什么不一样？**
钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**
经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

---

## 开发与测试

```bash
node server.js        # 启动
npm test              # 运行测试（Node ≥ 18 自带 test runner，零依赖）
```

- `lib/routing.js` —— 纯函数：默认值判定、三态解析、slug 归一化、双写路由合并、探测候选解析、思考强度映射。无 IO，UI 与测试共用。
- `test/routing.test.js` —— 语义单测（28 例）：三态存活、别名不串味、大小写归一、双写形态、策略合并表。
- `test/capture.e2e.test.js` —— 端到端（9 例）：起 mock 上游捕获**真实外发请求体**，验证默认钉住、清空存活、策略行为与探测剥离。

> 这批测试锁的是移植后最容易回归的地方：默认值判据、`[]` 与「缺失」的区分、以及 `only/order` 是否真的同时下发。

---

## 安全提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- 对外部署务必设置 `proxyKey`（控制台可随时轮换）；
- 「重试博弈」`maxRetries > 0` 时会放大请求量，注意额度消耗。

## License

[MIT](LICENSE)
