# dsh-prompt-enhancer

> 仓库：<https://github.com/0518a/dsh-prompt-enhancer>　·　许可证：MIT　·　版本：1.5.1

DSH Web 输入框的**提示词增强器**：在输入框右下角（发送键之前）放一枚「叶子 + 闪耀」图标，点一下就把当前草稿润色成结构化提示词；润色过程中显示进度环，润色完成后变成撤销箭头，再点一下即可回到润色前的原始文字。

对标 workbuddy 的「一键润色」交互，但整套实现是 DSH 原生的：插槽、标准 props、Connection RPC 信封、`ctx.llm` 辅助调用，没有 DOM 注入、没有键盘/输入事件劫持、也不改任何 DSH 内置文件。

---

## 1. 三态与交互（核心规格）

按钮只有三个状态，状态机是纯函数（`lib/client/index.js` 里的 `reduce`），图标、点击行为、撤销回退全部由它派生。

| 状态 | `data-state` | 图标 | 点击行为 | 前置条件 |
| --- | --- | --- | --- | --- |
| ① 未润色 | `idle` | 叶子 + 闪耀（用户矢量，evenodd 挖空） | 发起润色 | 草稿非空、编辑器未锁定 |
| ② 润色中 | `polishing` | 进度环（淡轨道 + 90° 圆头亮弧，匀速旋转） | **不响应**（无 `onClick`，按钮 `disabled`） | — |
| ③ 已润色 | `done` | 逆时针撤销箭头（描边 2，圆头圆角） | 撤销并回退 | 草稿仍等于写回结果 |

### 状态迁移

```
                       点击叶子（草稿非空）
   ┌──────────┐ ───────────────────────────────► ┌────────────┐
   │ ① idle   │                                  │ ② polishing│
   └──────────┘ ◄─────────────────────────────── └────────────┘
        ▲      失败 / 期间草稿被改 / 结果为空 / 草稿漂移   │
        │                                              │ Host 返回润色文本
        │            点击撤销箭头                        ▼
        │        ┌───────────────────────────► ┌────────────┐
        └────────┘                             │ ③ done     │
                                               └────────────┘
```

- **① → ②**：`reduce(state, { type: 'request', draft })`
  记录 `original = draft`（撤销的唯一依据），`requestId += 1`，状态置 `polishing`；同时立刻向 Host 发一次 RPC。
- **② → ③**：`{ type: 'settle', requestId, text, draft }`
  只有「仍在 polishing」且 `requestId` 与当前一致时才接受；并且要求 **当前草稿仍等于 `original`**。
  满足则 `polished = text`、状态置 `done`，随后调用 `inputActions.setDraft(text)` 把这一个结果写回编辑器。
- **③ → ①（撤销）**：`{ type: 'undo' }`
  回写 `inputActions.setDraft(original)`，状态回到 `idle`，快照清空。
- **③ → ①（草稿漂移）**：`{ type: 'sync', draft }` —— 见第 2 节，删除/改写后自动退出撤销态。

### 三条保守规则（防止误伤用户输入）

1. **过期响应直接丢弃**：`requestId` 单调递增，任何编号不匹配的返回（例如用户点了撤销又重新润色后，第一次的迟到响应）都不改写状态。
2. **润色期间用户改过草稿 → 丢弃结果**：settle 时若 `draft !== original`，不写回草稿，只给一句「润色期间草稿被修改，本次结果已丢弃」的提示，状态回到 `idle`。
3. **撤销只在草稿仍等于写回结果时回退**：当前草稿 === `baseline`（写回后被观测到的草稿）才回写 `original`，否则只把按钮状态复位。

### 撤销回退机制

- `original` 是**点击叶子那一刻的完整草稿字符串**，在 ①→② 时冻结。
- 润色结果写回走 `inputActions.setDraft()`，撤销回退走同一个 API 写回 `original`，两者严格配对，中间不会有第二次覆盖。
- `baseline` 是**写回之后实际观测到的草稿**：编辑器可能规范化换行/引用芯片，所以不能假设它等于模型输出；撤销可用性以它为准。
- 由于 DSH 的 `setDraft` 直接作用于该 Session 的 Lexical 编辑器（会并入编辑器历史），撤销按钮之外的 **Ctrl/Cmd+Z** 同样可以退回；两条路径互不冲突。
- 附件（图片/文件）不在本插件的管辖范围内：润色只替换文本，`attachmentIds` 原样保留。

### 其它可见反馈（不新增第 4 个状态，不改变图标语义）

| 场景 | 表现 |
| --- | --- |
| 草稿为空 / 全空白 | 按钮禁用，tooltip 提示「先输入一点内容，再点叶子图标润色」 |
| 正在提交（`submitting` / `adjudicating`） | 按钮禁用，避免与提交事务抢草稿 |
| Host 报错（超时、限流、模型失败…） | 回到 `idle`，按钮转为错误配色，tooltip 显示 Host 的错误原文，6 秒后自动恢复 |
| 完成润色后又删除 / 改写草稿 | **立即回到 `idle`**（叶子），不再停留在撤销态（见下节修复说明） |
| 没有 Session（`useInput` 为 `undefined`） | 不渲染任何东西 |
| 语言切换 | 跟随 `ctx.locale`，tooltip 在中/英文之间切换 |

---

### 改写口径（v1.5：只润色，不反问、也不要求你澄清）

点一下 = 让模型**改写草稿本身**，而不是把草稿当成一句要回答的话，更不是让它来问你「它指哪个」。规则：

| 规则 | 说明 |
| --- | --- |
| 只改写，不回答 | 不执行草稿里的任务、不评价草稿、不输出解释 |
| 不反问 | 禁止「你指的是哪一个」「它具体指什么」「请告诉我」「请补充」「能否说明」「哪一段」这类句子 |
| **不把澄清写进结果** | 输出里同样不得出现「若…未提供，请先确认」「请向我确认具体是哪一个」这类要求用户补充信息的句子（v1.5 新增：v1.4 只堵了「直接反问」，漏了「把澄清要求写成提示词的一部分」） |
| 指代原样保留 | 「它 / 这个 / 那个 / 上面说的 / 前者」原样出现，不替换成占位符、不展开猜测、也不加「指代不明」的说明 |
| 指代不明时按「已确定」处理 | 直接把提示词写成在已知输入上可执行的样子（补要点、结构、输出形式），必要时写一句「依据上下文理解其中指代的所指并直接据此作答」 |
| 具体信息不丢不改 | 数字、名称、路径、版本、报错文本、字段名一律原样保留 |

系统指令里内置了一个示例，草稿「它是怎么样工作的」对应输出：

> 请讲解它的工作原理，分三部分说明：① 核心流程与关键环节；② 涉及的主要机制与关键概念；③ 典型使用场景与限制。依据上下文理解其中「它」的所指，并直接据此作答。

**三层防护**（前两层在 Host 半 [lib/index.js](lib/index.js)，第三层在浏览器半 [lib/client/index.js](lib/client/index.js)）：

1. **指令层**：`DEFAULT_INSTRUCTION` 含「禁止反问」「禁止把澄清写进结果」「指代不明按已确定处理」三条硬约束 + 上面那个示例；`frameDraft` 再声明一次「草稿只是要被改写的素材，不要执行它、不要回答它、不要针对它提问」。
2. **Host 重试 + 清洗**：`looksLikeClarification(output, draft)` 与草稿逐条对照（只有短语**出现在输出却不在草稿里**才算，所以用户自己写的「请告诉我这个函数的用途」「请确认交付时间」不会误伤）。命中 → 用同一份取消信号**追加纠正指令重试一次**；两次都带澄清 → **逐句剔除**那几句（返回值带 `sanitized: true`）；剔除后没有可用内容 → 返回失败信封，草稿保持原样。
3. **展示层兜底**：浏览器半在写回前再跑一遍同源的判定与剔除（`scrubPolish`）。即使进程里跑的是较旧的 Host 半、或遇到没被列举的措辞，输入框里也不会出现澄清句；整段都不可用时按失败处理并给出 tooltip 提示。

> 为什么还需要第 3 层：**Host 半的代码改动不会热加载**（见下节），浏览器半会。两层判定同源，行为不会打架。

### 改完代码要做什么（重要）

| 改的是 | 生效方式 |
| --- | --- |
| `lib/client/index.js`（图标、三态、展示层兜底） | 改文件即生效：Host 侧会换 client bundle 的 rev，页面通常无需重启（必要时 `Ctrl+R`） |
| `lib/index.js`（润色指令、反问防护、RPC 通道） | **必须重启 DSH**。在 Plugin Manager 里关闭再启用 bundle 不会清掉进程里的 ESM 模块缓存（已实测：schema 仍是旧版） |

自查「进程里跑的是哪一版 Host 半」：

1. 设置 → Plugins → `dsh-prompt-enhancer` 的配置 schema 里是否出现 `guard` 字段（v1.5 新增）；
2. 或看 DSH 启动日志里的一行：`dsh-prompt-enhancer: host half ready (v1.5.0, guard=true, retry+sanitize)`。

把 `guard` 设为 `false` 可整体关闭这套防护（退回「照搬模型输出」）。

---

### 按钮视觉细节（v1.5.1：点击不再出现灰/黑方块）

现象：点一下叶子按钮后，按钮位置出现一个灰/黑色小方块（润色中尤其明显）。

定位：这个格子是插槽 `conversation.input.right` 里的**我们自己的 `<button>`**（渲染顺序在模型选择器之前），所以方框只可能来自三处：

1. 宿主/UA 叠加在裸 `button` 上的 hover/active 底色（DSH shell 只重置了 `button{font-family:inherit}`，其余交给各组件自己管）；
2. **Chromium 触屏/触控板点击时的默认高亮**（`-webkit-tap-highlight-color`，一块跟随元素圆角的半透明灰黑方块，只由点击产生）；
3. 按下瞬间按钮获得焦点，宿主或父级任何 `:focus` / `:focus-within` 样式给这个格子铺底色。

修复（三层同时下手，任何一条残留都不再成立）：

| 措施 | 作用 |
| --- | --- |
| `.dsh-pe-button{all:unset; …}` | 抹掉 UA 与宿主可能叠加到 button 上的全部样式（类名写成双份提高优先级） |
| `-webkit-tap-highlight-color:transparent` + `appearance:none` | 关掉点击高亮与原生控件外观 |
| hover/active/focus/disabled **每个态都显式写 `background:transparent`** | 按钮在任何状态下都不画底色；hover 反馈改成「只换文字色」 |
| `onMouseDown` 里 `preventDefault()` | 点击不再让按钮抢焦点，宿主的 `:focus` / `:focus-within` 类样式无从触发；键盘 Tab 聚焦与 Enter/Space 激活不受影响 |

回归用例：解析注入的样式表，断言其中**每一处 `background` 都必须是 `transparent`**，并断言 `all:unset`、`-webkit-tap-highlight-color:transparent`、`onMouseDown → preventDefault` 都存在——这一整类 bug 以后无法悄悄回归。

---

## 2. 图标设计（v1.3 起：导入用户矢量 `leaf_star_vector.svg`）

三个状态共用同一套「单一 `currentColor` + 大块填充 / 圆头描边」的图形语言，切换时视觉重量基本一致：

| 状态 | 图形 | 结构 | 光学尺寸（24 视框，含描边） |
| --- | --- | --- | --- |
| `idle` | **叶子 + 闪耀**（用户提供矢量） | **1 个 `<path>`，3 个子路径 + `fill-rule="evenodd"`**：叶身外轮廓 37 点 → 内轮廓 21 点（挖空）→ 四角闪耀 20 点 | 17.3 × 18.8，中心 (12.0, 12.0) |
| `polishing` | **进度环** | 2 个 `<circle>`：淡轨道（opacity .22）+ 90° 圆头亮弧，整体匀速旋转 | 外径 18.2 |
| `done` | **撤销箭头** | 1 个 `<path>`，描边 2 / 圆头圆角：左箭头 + 右凸半圆回钩 | 17.0 × 17.0 |

> 挖空的实现方式：外轮廓 + 内轮廓两条子路径走 `evenodd` 规则，两条轮廓之间的区域只穿过一次 → 填充；内轮廓内部穿过两次 → 留白。于是**不用描边也能得到 1.59~2.61（均值 1.78）的「描边带」**，重量与进度环的 2.2 / 撤销箭头的 2 同族。若改成 `nonzero`，内轮廓会被同向填充吞掉、叶子变成实心块——所以 `fill-rule` 是这套图标的硬前提。

### 归一化链路（可复现）

`tools/verify/import-svg.mjs` 一条命令完成，处理链如下：

```
源 leaf_star_vector.svg
  viewBox 1504×1536，内容包围盒 559×606（左上角，四周大片留白）
→ 等比缩放 0.031023 + 居中，装进 24×24 视框（最长边 18.8，与其它两态对齐）
→ Douglas-Peucker 简化闭合环（容差 0.08 = 视框的 0.33%）
→ 1 位小数取整、去掉 .0
→ 省略隐式 `L` 命令（只保留一个 M，后续坐标直接跟）
= 668 字符 / 78 个点 / 3 个子路径 / 1 条路径
```

```powershell
node tools/verify/import-svg.mjs leaf_star_vector.svg
```

脚本会一并导出 5 份候选到 `tools/verify/out/import.json`（容差 0.04 / 0.08 / 0.15，以及内轮廓收缩 0.86 / 0.78 的加粗版）并打印每份的**带厚统计**与**内轮廓是否被外轮廓包含**，方便在「忠实」与「更粗壮」之间挑。当前采用**忠实**版本（0.08，不额外加粗）：实测带厚 1.59~2.61 已经落在同族区间。

### 质检口径（`tools/verify/test-icon.mjs`，13 项）

- 语法 / 体积：只用绝对 `M`/`L`/`Z`、1 位小数、无多余 `.0`、点数与路径长度在预算内；
- 几何：所有坐标落在 24×24 且留边、包围盒居中、三态光学尺寸互相匹配；
- **evenodd 前提**：内轮廓严格位于外轮廓内部；带厚在 [1.2, 3.4]；闪耀与叶身带的最小间距 > 0.8（否则重叠处会被 evenodd 挖成洞）；外轮廓面积 > 内轮廓 ×2；闪耀在叶子左上方；
- 进度环：dash 之和等于周长、亮弧占比 20%~35%、外径与叶身宽度相当。

### 视觉预览

`tools/verify/render-icon.mjs` + `tools/verify/rasterize.py` 会把**运行时同一份路径数据**光栅化成对照图（深色底 / 浅色底 × 16 / 20 / 24 / 48 px），输出在 `tools/verify/out/icon-preview.png`：

```powershell
node tools/verify/render-icon.mjs
python tools/verify/rasterize.py
```

（光栅化器实现了 `nonzero` 与 `evenodd` 两种填充规则，因此预览图里叶子的挖空与浏览器一致。）

---

## 3. Bug 修复：删除草稿后图标停留在「撤销」态（v1.1）

**现象**：润色完成后把句子删掉，按钮仍然是撤销图标。

**原因**：`done` 态只在「点击撤销」「收到新响应」「润色期间草稿被改」三条路径上退出。用户自己删除/改写草稿属于**状态机之外**的变化，旧实现没有任何人监听它，于是状态机一直以为「草稿里还留着刚写回的润色结果」。

**修复**：给状态机加上第四个数据 `baseline`（写回之后**观测到**的草稿）与一个 `sync` 事件：

1. 每次渲染后用 effect 把当前草稿喂给 `reduce`：`{ type: 'sync', draft }`；
2. 写回尚未落地时（草稿仍等于 `original`）**继续等待**，绝不误清撤销入口；
3. 一旦草稿与 `baseline` 不同 —— 无论被删空、被改写、还是被改回原文 —— 立即回到 `idle`（叶子），并清空 `original` / `polished` / `baseline`；
4. 模型「原样返回」这种写回等于空操作的情况，`settle` 时就把 `baseline` 置为原文，因此同样能被删除动作正确复位。

`sync` 是幂等的纯函数：草稿没漂移时返回原状态引用，不会触发多余渲染。

---

## 4. 实现位置（都是新增文件，零侵入）

| 文件 | 作用 |
| --- | --- |
| `lib/client/index.js` | 浏览器半：手写 DSH client bundle，注册进 `conversation.input.right`，内含三态状态机、图标与按钮组件 |
| `lib/index.js` | Host 半：注册 `/dsh-prompt-enhancer/polish` RPC 通道，调用 `ctx.llm.stream()` 完成润色 |
| `cordis.patch.yml` | bundle 挂载声明 |
| `tools/verify/*.mjs`、`rasterize.py` | 矢量导入工具、85 项离线验证、图标光栅化预览（见第 2 与第 8 节） |

复用的 DSH 契约：

- 插槽 `conversation.input.right`（"Compact controls before the composer submit action"），注册形如 `ctx.slots.inject(slot, () => ctx.slots.register({ name, id, order }, Component))`；
- 标准 props `useInput`（`SnapshotSelectorHook<InputState>`）读草稿、`inputActions.setDraft(text)` 写草稿；
- Connection 通用 RPC：浏览器 `ctx.get('connection').rpc.call(channel, endpoint, payload)` ↔ Host `webServer.register({ kind: 'prefix', path })`，信封为 `client-request` / `server-response`，并复用 `connection.requestRejection()` 的 Host/Origin/Cookie 栅栏；
- 模型调用走 `ctx.llm.stream()`，属于**辅助调用**：不写入 session log、不进入对话上下文、不影响 KV Cache。

---

## 5. 安装

### 方式 A：命令行（推荐）

```powershell
# 发布包
dsh plugin --profile desktop add dsh-prompt-enhancer
# 直接从 GitHub 安装
dsh plugin --profile desktop add "git+https://github.com/0518a/dsh-prompt-enhancer.git"
# 本地目录 / 开发中（link 安装，改文件即时生效）
dsh plugin --profile desktop add link:"<本目录的绝对路径>"
```

### 方式 B：图形界面

设置 → Plugins → 安装 Bundle，填 npm 包名；或以 `link:` 形式指向本目录。

### 方式 C：手工写入 profile

1. 把本目录放到 `~/.dsh/profiles/<profile>/node_modules/dsh-prompt-enhancer`（或直接 `link`）；
2. 在 profile 的 `package.json` 里加入依赖与 bundle 行：

```json
{
  "dependencies": { "dsh-prompt-enhancer": "link:<本目录的绝对路径>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-prompt-enhancer"] } }
}
```

3. 在 `~/.dsh/profiles/<profile>` 下执行 `pnpm install`，重启 DSH；
4. 刷新已打开的页面（client bundle 由 Host 侧服务，改文件后 HMR 会换 rev，通常无需重载页面）。

安装成功后：输入框右下角、麦克风左侧出现叶子 + 闪耀图标；`设置 → Plugins → Plugin list` 能看到 `dsh-prompt-enhancer`。

---

## 6. 配置（可选）

默认无需任何配置：模型路由按 **插件配置 → 该 Session 已记录的 `request/header` 路由 → `ctx.agentDefaultModel.currentSelection()`** 依次解析，所以只要是能正常对话的 Session，叶子按钮就能直接工作。

需要固定一个小模型来润色时，在 profile 的 `cordis.patch.yml` 里覆盖同一 id 的行：

```yaml
- id: dsh-prompt-enhancer
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    timeoutMs: 30000
    maxTokens: 1600
    temperature: 0.4
    maxPromptChars: 12000
    instruction: |
      你是一个提示词工程师……（整段替换默认润色指令）
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | 未设置 | 成对生效；设置后不再跟随 Session 当前模型 |
| `timeoutMs` | `30000` | 单次润色超时，超时返回失败信封而非挂住界面 |
| `maxTokens` | `1600` | 输出上限，防止模型把「润色」写成一篇长文 |
| `temperature` | `0.4` | 越低越忠实于原意 |
| `maxPromptChars` | `12000` | 草稿字符上限 |
| `instruction` | 内置中文指令 | 润色 system prompt，要求：只输出改写结果、保持原语言与全部具体信息、不新增需求、长短适中 |
| `guard` | `true` | 反问/澄清防护总开关（v1.5 新增）；设 `false` 则照搬模型输出 |

---

## 7. 工程约束与已知边界

- 只依赖平台基线模块 `react`，因此 `dsh.client.external` 为空，不引入任何前端依赖；
- Host 半唯一的运行期依赖是 `@deepseek-ai/schemastery`。**注意**：用 `link:` 方式安装时 pnpm 不会安装被链接包的依赖，而 Node 的裸模块解析是从**本目录**向上找的（不会回到 profile 的 node_modules），所以本目录自带的 `node_modules/@deepseek-ai/{schemastery,cosmokit}` 是 link 安装下的必需项，请不要删除；按 npm 包正常安装时 pnpm 会自行安装该依赖。`files` 字段不发布这个目录；
- 润色是**辅助模型调用**，与 session-title 同级：不写日志、不进上下文；但它确实会消耗一次模型配额；
- 撤销依赖 DSH 的 `setDraft`（并入编辑器历史）。若连续润色两次，撤销按钮语义是「回到**本次**润色前」；再往前请用编辑器自带的 Ctrl/Cmd+Z；
- 草稿漂移复位以「写回后观测到的草稿」为锚点，因此**用户在编辑器里做的任何后续编辑（含删空）都会退出撤销态**——这是有意为之：撤销只在「还能退回原句」时有意义；
- 当前只润色文本草稿，不触碰引用芯片与附件。

---

## 8. 离线验证（85 项）

不需要浏览器、不需要 DSH 运行时，用 Node 直接跑（需要 Node ≥ 22）：

```powershell
cd dsh-prompt-enhancer
node tools/verify/test-host.mjs     # Host 半 35 项（含改写口径 / 反问防护 / 清洗回归）
node tools/verify/test-client.mjs   # Client 半 37 项（含草稿漂移 / 展示层兜底 / 底色回归）
node tools/verify/test-icon.mjs     # 图标资源 13 项（几何 / 精度 / 点数预算 / evenodd 结构）
# 或：npm test
```

`test-client.mjs` 用 `vm.runInThisContext` 真实加载 `lib/client/index.js`，配一个极简 React 替身把组件挂起来，逐帧断言：

1. bundle 以包名注册、`factory(require)` 只请求 `react`、导出 `apply`/`inject`、注入了样式标签；
2. `apply` 把单元格注册进 `conversation.input.right`（`id`/`order` 正确）；
3. ① 叶子 → 点击 → ② 进度环（且不重复请求、无 `onClick`）→ 完成 → ③ 撤销箭头且草稿被替换 → 点击撤销 → ① 叶子且草稿复原；
4. **bug 回归**：润色完成 → 删空 / 逐字删除 / 改写 / 改回原文 → 图标立即回到叶子；写回未落地时不误清；编辑器规范化写回仍保持可撤销；漂移复位后能再次润色且撤销回到本轮原文；
5. 异常路径：Host 失败、润色期间草稿被改、空草稿、提交中锁定、无 Session 不渲染、无 connection 时可读报错；
6. `reduce` / `actionOf` / `iconKindOf` 的三态映射与「过期响应被忽略 / idle·polishing 下 sync 为空操作」。

`test-host.mjs` 真实导入 `lib/index.js`，用假 `ctx`（含假 `llm.stream`）驱动 HTTP 路由，断言：信封协议、栅栏 401、404/415/400/体积上限、成功与失败信封、路由优先级、错误码映射，以及**改写口径**——默认指令禁止反问、`frameDraft` 声明素材属性、`looksLikeClarification` 与草稿对照不误伤、正常改写只调一次、首次反问会追加纠正指令重试一次、两次反问报错且失败信封不写回。

`test-icon.mjs` 解析运行时的同一份路径数据（`tools/verify/svg-path.mjs`），断言：只用绝对 `M`/`L`/`Z`、1 位小数、无多余 `.0`、点数与体积预算、包围盒居中留边，以及 evenodd 成立的四条前提（内轮廓严格在外轮廓内、带厚 1.2~3.4、闪耀与叶身带间距 > 0.8、外轮廓面积 > 内轮廓 ×2），再加进度环的 dash 与占比。

最近一次运行：**Host 35/35、Client 37/37、图标 13/13，共 85/85 全部通过**。

---

## 9. 本机安装与在线验证记录

本插件已装进当前 desktop profile（`~/.dsh/profiles/desktop`），安装命令：

```powershell
# 通过 DSH 的 plugin-manager 完成（等价于 GUI 的「安装 Bundle」）
# 结果：dependencies += "dsh-prompt-enhancer": "link:<本目录的绝对路径>"
#       dsh.profile.bundles += "dsh-prompt-enhancer"
```

在线验证（无需重启、无需刷新页面，热加载即时生效）：

| 验证点 | 手段 | 结果 |
| --- | --- | --- |
| Client 半已加载并占位 | Inspect `client / Slots / listSubTree` → `conversation.input.right` | `occupants: [{ id: "dsh-prompt-enhancer", order: 50, active: true }]` ✅ |
| Host 半已加载 | Inspect `host / Config / listConfigs name=dsh-prompt-enhancer` | `{ entryId: "include:dsh-prompt-enhancer", status: "schema" }` ✅ |
| RPC 路由已挂载且带信任栅栏 | 未带浏览器 Cookie 直接 POST | `/dsh-prompt-enhancer/polish` → `401 unauthorized`；未安装的通道 → `405` ✅ |
| 三态状态机、图标切换、展示层兜底、按钮底色 | `node tools/verify/test-client.mjs` | 37/37 ✅ |
| 信封协议、错误映射、路由优先级、改写口径与清洗 | `node tools/verify/test-host.mjs` | 35/35 ✅ |
| 图标几何与设计约束（含 evenodd 结构） | `node tools/verify/test-icon.mjs` | 13/13 ✅ |
| 图标肉眼校验 | `render-icon.mjs` + `rasterize.py` | 见 `tools/verify/out/icon-preview.png`（深/浅底 × 16/20/24/48px）✅ |

**剩下一步需要你在界面上确认**：在输入框里打一句话，点右下角的叶子图标 —— 应当依次看到「进度环 → 撤销箭头 → 草稿变成润色后的版本」，点撤销箭头应恢复原文；如果直接删掉这句润色后的文字，图标应当立刻变回叶子。最后一步是唯一无法离线替代的真实模型调用（它需要本机已配置好的模型凭据）。

---

## 10. 更新记录

| 版本 | 变化 |
| --- | --- |
| 1.5.1 | 修掉「点击后按钮位置出现灰/黑方块」：样式改为 `all:unset` + 双份类名提高优先级、四态显式 `background:transparent`、关掉 `-webkit-tap-highlight-color` 与原生外观、hover 只换文字色；点击时 `onMouseDown → preventDefault()` 不再抢焦点。新增「样式表里每一处 background 都必须是 transparent」的回归断言（Client 35 → 37 项）。 |
| 1.5.0 | 修掉「把澄清写进提示词」的口子：草稿「它是怎么样工作的」不再产出「若…未提供，请先向我确认具体是哪一个对象」。① 指令层新增「禁止把澄清写进结果」「指代不明按已确定处理」+ 内置示例；② Host 半加 `sanitized` 兜底——重试后仍带澄清就逐句剔除、剔除为空则失败不写回；③ 浏览器半增加同源展示层兜底 `scrubPolish`，Host 半不重启也能立刻生效；④ 新增 `guard` 开关；⑤ Host 27 → 35、Client 32 → 35 项用例。 |
| 1.4.0 | 改写口径修正：润色只在草稿基础上进行，**禁止向用户反问/索要补充**（「你指的是哪一个」「请告诉我」等）；指代原样保留，模糊处改写成可执行的默认处理。新增 `looksLikeClarification(output, draft)` 与草稿对照的反问检测 + 一次纠正重试，两次都反问则返回失败信封、草稿不受影响。Host 用例 20 → 27。 |
| 1.3.0 | 图标改用你提供的 `leaf_star_vector.svg`：单条路径 + 3 个子路径 + `fill-rule="evenodd"`（外轮廓 / 内轮廓挖空 / 闪耀），新增 `tools/verify/import-svg.mjs` 做「源视框 → 24×24 等比缩放居中 → Douglas-Peucker 简化 → 1 位小数 → 省略隐式 L」归一化并导出多份候选；质检扩到 13 项，重点校验 evenodd 成立的四个前提；光栅化预览器支持 evenodd。 |
| 1.2.0 | 图标改为参考图样式：一笔画**叶子（描边）+ 左上方闪耀**，取代鲸鱼剪影；叶身改为开放描边轮廓（内部留白不糊），新增折浪识别点；图标质检扩到 13 项（首尾点重合、闪耀面积比、叶身/闪耀分离度）。 |
| 1.1.0 | ① 图标重做：五角星 → 鲸鱼 + 闪耀（当时的 DeepSeek 印象稿）；进度环加轨道；撤销箭头改为圆头描边；三者光学尺寸对齐并加入几何断言 + 光栅化预览。② 修复 bug：润色后删除/改写草稿时图标不再停留在撤销态（新增 `baseline` + `sync` 事件与回归用例）。 |
| 1.0.0 | 首个版本：三态（星星 / 进度环 / 撤销）、Host 润色通道、离线 40 项验证、本机安装并在线生效。 |
