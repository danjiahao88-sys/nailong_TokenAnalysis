# 奶龙 Agent 管理台

一个本地运行的 AI Coding Agent 资产管理仪表盘：统一查看本机的 Skill、MCP Server、用过的大模型与模型开销。

- 单页前端：原生 HTML / CSS / JS，无框架、无外部请求、无 CDN。
- 本地服务：Node.js 原生 `http`，零第三方依赖。
- 所有数据只从本机文件读取，不会上传；路径不存在时显示「未检测到」，不会报错。

## 启动

需要 Node.js 18+（读取 SQLite 建议 Node 22.5+）。

```bash
node server.js
```

然后打开 <http://localhost:4173>。

可选参数：

```bash
node server.js --port 5173                 # 自定义端口，占用时会自动顺延
node server.js --project D:\work\my-project  # 指定项目级扫描目录
```

也可以用环境变量 `PORT`、`PROJECT_DIR`，或者直接 `npm start`。

> 不要直接双击 `index.html`。浏览器在 `file://` 下无法读取本地文件，必须通过 `node server.js` 启动。

## 数据来源与配置位置

| 模块 | 扫描路径 | 缺失时如何配置 |
| --- | --- | --- |
| Skill（全局） | `~/.qoder/skills/`、`~/.cursor/skills/`、`~/.claude/skills/`、`~/.codex/skills/`、`~/.qwen/skills/`、`~/.trae-cn/builtin_skills/` | 按 `<skill-name>/SKILL.md` 结构创建，frontmatter 写 `name`、`description` |
| Skill（项目） | 项目目录下 `.qoder/skills/`、`.cursor/skills/`、`.claude/skills/`、`.codex/skills/`、`.qwen/skills/` | 同上 |
| Skill（插件） | `~/.qoder/plugins/<plugin>/skills/`、`~/.trae-cn/plugins/<registry>/<plugin>/<version>/skills/`、项目 `.qoder-plugin/skills/` | 插件目录结构保持一致即可自动扫描 |
| MCP | `%APPDATA%\Trae CN\User\mcp.json`、`~/.trae-cn/mcp.json`、项目 `.trae/mcp.json`、`~/.qoder/mcp.json`、项目 `.qoder/mcp.json`、`~/.qoder/settings.json` 的 `mcpServers`，以及 `~/.cursor/mcp.json`、项目 `.mcp.json` | 在 `mcp.json` 中写 `"mcpServers": { "名字": { "command": "...", "args": [], "env": {} } }` |
| 大模型 | Trae CN `state.vscdb`、`~/.codex/config.toml` 与会话、Qoder `logs/runs/*/manifest.json` | 使用过对应客户端后自动出现 |
| 用量 | `~/.qoder/usage.json`、`~/.qoder/projects/**/*.jsonl`（credits）、`~/.qoder/sessions/*.jsonl`、`~/.himan-tracker/*.sqlite`、`~/.agentic-metric/`、`~/.codex/sessions/**/*.jsonl(.zst)` | 安装 himan-tracker 或 agentic-metric；或把用量记录放到上述路径 |

### MCP 示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\work"]
    }
  }
}
```

### Skill 示例

```
~/.qoder/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: 一句话说明这个技能做什么
---

正文……
```

## 页面功能

- 顶部统计：模型开销 / 用过的大模型 / Skill / MCP。
- 四张统计卡（按重要性排序）：模型开销（Token 总量 + 费用）、大模型数量与厂商分布、全局/项目 Skill 占比、MCP 已配置与异常数量。
- 平台筛选：按钮即时过滤 Skill 与 MCP 两个列表（纯前端）。
- 模型开销：Token 环形图、Input / Output / Cache 拆分、费用、最近 7 天柱状图。
- 用过的大模型：列出本机会话与配置中出现过的模型，标注厂商、类型与来源。
- 模型详情页：点击任意模型卡片进入该模型的详情页（`?model=<模型 ID>`），统计卡、模型信息、模型开销、Skill 与 MCP 均按该模型及其所属平台过滤；页面标题旁提供「返回总览」。
- 模型开销归属：能从会话记录中识别模型时，Token 与费用会按模型拆分统计（Codex 会话的 `provenance.model` 会带上模型名）；Trae CN 本地只记录「选过哪个模型」，不保存逐模型 Token 数，因此这类模型的详情页会明确显示「本机没有记录该模型的 Token 用量」。Qoder 的会话记录里 `input_tokens` / `output_tokens` 均为 0，只有 `credits`，页面会单独展示 credits 与请求次数；Codex 本地代理把 `deepseek-v4.1-flash` 记成 `deepseek-v4-flash`，两者按同一模型合并统计。
- 空状态：使用 `assets/nailoong-family.png` 官网奶龙家族插图，顶部头像为 `assets/nailoong.png`。
- 底部「刷新数据」：重新读取全部本地文件；Codex 会话扫描结果会缓存 5 分钟，连续浏览总览与详情页不会重复扫描大文件，点「刷新数据」会强制重扫。

## 用量解析说明

- 会对 JSON / JSONL 做通用的字段识别：任何包含 `token` 的字段都会尝试归类为 input、output、cache 或 total；`cost` / `price` / `spend` 等字段会作为实际费用。
- `himan-tracker` 的 SQLite 通过 Node 内置 `node:sqlite` 读取，自动寻找含 Token 字段的表和日期字段；Node 版本过低时会在数据源列表里显示原因。
- 如果记录里没有实际费用，会按默认单价估算：输入 $3、输出 $15、缓存 $0.3（每百万 Token），界面会标注「预估费用」。
- 所有时间按本机时区聚合，趋势展示最近 7 个自然日。

## 隐私

页面没有外部依赖、没有遥测、没有上传接口；`server.js` 只监听 `127.0.0.1`，仅读取上述本地路径。
