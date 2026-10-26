'use strict';

/**
 * 奶龙 Agent 管理台 · 前端逻辑
 * 只负责渲染、筛选与刷新，数据全部来自 /api/data。
 */

const state = {
  data: null,
  filter: 'all',
  error: '',
  loading: false,
  detailId: new URLSearchParams(window.location.search).get('model') || ''
};

const EMPTY_DATA = {
  generatedAt: null,
  meta: {},
  platforms: [],
  models: [],
  skills: [],
  mcpServers: [],
  usage: {
    available: false,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cost: 0,
    credits: 0,
    requests: 0,
    daily: [],
    byModel: [],
    message: '暂无本地用量记录。',
    sources: []
  },
  notes: []
};

const PLATFORM_CLASS = {
  qoder: 'tag-qoder',
  trae: 'tag-trae',
  cursor: 'tag-cursor',
  claude: 'tag-claude',
  codex: 'tag-codex',
  qwen: 'tag-qwen',
  copilot: 'tag-copilot'
};

const PLATFORM_FALLBACK = {
  qoder: { label: 'Qoder', emoji: '🟡' },
  trae: { label: 'Trae CN', emoji: '🟩' },
  cursor: { label: 'Cursor', emoji: '⚫' },
  claude: { label: 'Claude', emoji: '🟠' },
  codex: { label: 'Codex', emoji: '🔵' },
  qwen: { label: 'Qwen', emoji: '🟢' },
  copilot: { label: 'Copilot', emoji: '⚪' }
};

const $ = (id) => document.getElementById(id);

/* ------------------------------ 工具函数 ------------------------------ */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 与服务端一致：把 Trae 会话内的模型标识归一化后再比较 */
function modelKey(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(solo_agent|solo_coder|agent|dev_builder|chat|builder)_\d+_+_?/i, '')
    .replace(/^\d+_-_/, '')
    .replace(/^[-_]+/, '')
    .replace(/_null$/i, '')
    .replace(/[_\s]+$/, '');
  // Codex 本地代理把 V4.1 Flash 记成 deepseek-v4-flash
  return key === 'deepseek-v4-flash' ? 'deepseek-v4.1-flash' : key;
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0.00';
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

function fmtCredits(value) {
  const n = Number(value) || 0;
  return n.toFixed(2);
}

function shortPath(target) {
  if (!target) return '';
  const home = state.data && state.data.meta ? state.data.meta.home : '';
  let text = String(target).replace(/\\/g, '/');
  if (home) {
    const normalizedHome = String(home).replace(/\\/g, '/');
    if (text.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
      text = `~${text.slice(normalizedHome.length)}`;
    }
  }
  return text;
}

function platformInfo(key) {
  const list = (state.data && state.data.platforms) || [];
  const found = list.find((item) => item.key === key);
  if (found) return found;
  return PLATFORM_FALLBACK[key] || { label: key || '未知', emoji: '⚪' };
}

function platformTag(key) {
  const info = platformInfo(key);
  const cls = PLATFORM_CLASS[key] || 'tag-default';
  return `<span class="tag ${cls}">${esc(info.emoji)} ${esc(info.label)}</span>`;
}

function countBy(list, key) {
  return list.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function scopePill(scope) {
  const isProject = scope === 'project';
  return `<span class="scope-pill${isProject ? ' project' : ''}">${isProject ? '项目' : '全局'}</span>`;
}

/* ------------------------------ 模型详情视图 ------------------------------ */

function findDetailModel(data) {
  if (!state.detailId) return null;
  return (data.models || []).find((item) => modelKey(item.id) === modelKey(state.detailId)) || null;
}

function modelUsage(usage, model) {
  const hit = (usage.byModel || []).find((item) => modelKey(item.id) === modelKey(model.id));
  const sources = usage.sources || [];
  if (!hit || (!hit.totalTokens && !hit.credits)) {
    return {
      ...EMPTY_DATA.usage,
      sources: [],
      detailEmpty: true,
      message: '本机没有记录该模型的 Token 用量。'
    };
  }
  const sourceNames = hit.sources || [];
  return {
    available: Boolean(hit.totalTokens),
    creditOnly: !hit.totalTokens && hit.credits > 0,
    totalTokens: hit.totalTokens,
    inputTokens: hit.inputTokens,
    outputTokens: hit.outputTokens,
    cacheTokens: hit.cacheTokens,
    cost: hit.cost,
    costEstimated: hit.costEstimated,
    credits: hit.credits || 0,
    requests: hit.requests || 0,
    daily: hit.daily || [],
    byModel: usage.byModel || [],
    sources: sourceNames.length ? sources.filter((item) => sourceNames.includes(item.name)) : sources,
    message: hit.totalTokens ? '' : 'Qoder 只记录了 credits，没有记录 Token 数。'
  };
}

function buildView(data) {
  const detail = findDetailModel(data);
  if (!detail) {
    if (state.filter === 'all') return data;
    // 平台筛选同时作用于模型卡片，点按钮能立刻看到模型列表变化
    return {
      ...data,
      models: (data.models || []).filter((item) => (item.platforms || []).includes(state.filter))
    };
  }
  const platforms = detail.platforms || [];
  return {
    ...data,
    detail,
    models: [detail],
    skills: (data.skills || []).filter((item) => platforms.includes(item.platform)),
    mcpServers: (data.mcpServers || []).filter((item) => platforms.includes(item.platform)),
    platforms: (data.platforms || []).filter((item) => platforms.includes(item.key)),
    usage: modelUsage(data.usage || EMPTY_DATA.usage, detail)
  };
}

function renderDetailHeader(data) {
  if (!state.data) return;
  const detail = findDetailModel(data);
  const back = $('backLink');
  if (!state.detailId) {
    back.classList.add('hidden');
    $('pageTitle').textContent = '奶龙 Agent 管理台';
    $('pageSub').textContent = '本机 AI Coding Agent 资产统一总览';
    $('modelsTitleText').textContent = '用过的大模型';
    $('modelsHint').textContent = '来自本机会话与配置记录';
    document.title = '奶龙 Agent 管理台';
    return;
  }

  back.classList.remove('hidden');
  $('modelsTitleText').textContent = '当前模型';
  $('modelsHint').textContent = '该模型在本机记录中的信息';

  if (!detail) {
    $('pageTitle').textContent = '模型详情';
    $('pageSub').textContent = `未找到模型：${state.detailId}`;
    document.title = '模型详情 · 奶龙 Agent 管理台';
    return;
  }

  const kind = detail.kind === 'embedding' ? 'Embedding' : detail.proxy ? '代理别名' : '对话';
  const platformLabels = (detail.platforms || [])
    .map((key) => platformInfo(key).label)
    .join(' / ');
  $('pageTitle').textContent = detail.name;
  $('pageSub').textContent = [detail.vendor, kind, platformLabels].filter(Boolean).join(' · ');
  document.title = `${detail.name} · 奶龙 Agent 管理台`;
}

/* ------------------------------ 顶部与筛选 ------------------------------ */

function renderSummary(data) {
  const el = $('summary');
  if (state.error) {
    el.innerHTML = '未连接本地服务 · 请运行 <b>node server.js</b>';
    return;
  }
  const models = data.models || [];
  const usage = data.usage || EMPTY_DATA.usage;
  const usagePart = usage.available ? ` · 开销 <b>${fmtTokens(usage.totalTokens)}</b> tokens` : '';
  if (data.detail) {
    el.innerHTML =
      `<b>${esc(data.detail.name)}</b>` +
      ` · Skill <b>${data.skills.length}</b>` +
      ` · MCP <b>${data.mcpServers.length}</b>` +
      usagePart;
    return;
  }
  el.innerHTML =
    `用过 <b>${models.length}</b> 个大模型` +
    ` · Skill <b>${data.skills.length}</b>` +
    ` · MCP <b>${data.mcpServers.length}</b>` +
    usagePart;
}

function renderFilters(data) {
  const counts = {};
  for (const item of [...data.skills, ...data.mcpServers]) {
    counts[item.platform] = (counts[item.platform] || 0) + 1;
  }
  for (const model of data.models || []) {
    for (const key of model.platforms || []) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  if (state.filter !== 'all' && !data.platforms.some((item) => item.key === state.filter)) {
    state.filter = 'all';
  }

  const total = data.skills.length + data.mcpServers.length + (data.models || []).length;
  const chips = [{ key: 'all', label: '全部', count: total }].concat(
    data.platforms.map((item) => ({
      key: item.key,
      label: `${item.emoji} ${item.label}`,
      count: counts[item.key] || 0
    }))
  );

  $('filters').innerHTML = chips
    .map(
      (chip) =>
        `<button type="button" class="chip${state.filter === chip.key ? ' active' : ''}" data-filter="${esc(
          chip.key
        )}">${esc(chip.label)}<span class="chip-count">${chip.count}</span></button>`
    )
    .join('');
}

/* ------------------------------ 统计卡片 ------------------------------ */

function renderStats(data) {
  const usage = data.usage || EMPTY_DATA.usage;

  const globalSkills = data.skills.filter((item) => item.scope === 'global').length;
  const projectSkills = data.skills.length - globalSkills;
  const skillPct = (count) =>
    data.skills.length ? `${Math.round((count / data.skills.length) * 100)}%` : '0%';
  const mcpOk = data.mcpServers.filter((item) => item.status === 'ok').length;
  const mcpBad = data.mcpServers.length - mcpOk;

  const usageValue = usage.available ? fmtTokens(usage.totalTokens) : '--';
  const creditChip =
    usage.credits > 0
      ? `<span class="stat-chip">Qoder credits <strong>${fmtCredits(usage.credits)}</strong></span>`
      : '';
  const usageFoot = usage.available
    ? `<span class="stat-chip">${usage.costEstimated ? '预估费用' : '费用'} <strong>${fmtCost(
        usage.cost
      )}</strong></span><span class="stat-chip">输入 ${fmtTokens(
        usage.inputTokens
      )}</span><span class="stat-chip">输出 ${fmtTokens(usage.outputTokens)}</span>${creditChip}`
    : usage.credits > 0
      ? `${creditChip}<span class="stat-chip">${usage.requests} 次请求</span><span class="stat-chip">该平台无 Token</span>`
      : '<span class="stat-chip">暂无本地用量记录</span>';

  const secondCard = data.detail
    ? {
        label: '关联平台',
        value: data.detail.platforms.length,
        foot: (data.detail.platforms || [])
          .map((key) => `<span class="stat-chip">${esc(platformInfo(key).label)}</span>`)
          .join('')
      }
    : {
        label: '用过的大模型',
        value: (data.models || []).length,
        foot: modelVendorChips(data.models || [])
      };

  const cards = [
    {
      label: '模型开销',
      value: usageValue,
      foot: usageFoot
    },
    secondCard,
    {
      label: 'Skill 总数',
      value: data.skills.length,
      foot: `<span class="stat-chip">全局 <strong>${globalSkills}</strong>（${skillPct(globalSkills)}）</span><span class="stat-chip">项目 <strong>${projectSkills}</strong>（${skillPct(projectSkills)}）</span>`
    },
    {
      label: 'MCP Server 总数',
      value: data.mcpServers.length,
      foot: `<span class="stat-chip">已配置 <strong>${mcpOk}</strong></span><span class="stat-chip">异常 <strong>${mcpBad}</strong></span>`
    }
  ];

  $('stats').innerHTML = cards
    .map(
      (card) => `
      <article class="stat-card">
        <div class="stat-label">${card.label}</div>
        <div class="stat-value">${card.value}</div>
        <div class="stat-foot">${card.foot}</div>
      </article>`
    )
    .join('');
}

/* ------------------------------ 大模型 ------------------------------ */

function modelVendorChips(models) {
  const counts = countBy(models, 'vendor');
  const chips = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([vendor, count]) => `<span class="stat-chip">${esc(vendor)} <strong>${count}</strong></span>`)
    .join('');
  return chips || '<span class="stat-chip">暂无模型记录</span>';
}

function modelCard(model) {
  const kindLabel = model.kind === 'embedding' ? 'Embedding' : model.proxy ? '代理别名' : '对话';
  const tags = (model.platforms || []).map((key) => platformTag(key)).join('');
  const sources = (model.sources || []).length
    ? `<span class="model-source">${esc(model.sources.join(' · '))}</span>`
    : '';
  return `
    <a class="model-card" href="./?model=${encodeURIComponent(model.id)}" title="查看 ${esc(model.name)} 的详情">
      <div class="model-top">
        <span class="model-vendor">${esc(model.vendor)}</span>
        <span class="model-kind">${kindLabel}</span>
      </div>
      <h3 class="model-name">${esc(model.name)}</h3>
      <code class="model-id">${esc(model.id)}</code>
      <div class="model-foot">${tags}${sources}</div>
    </a>`;
}

function renderModels(data) {
  // 按 Token 用量从高到低排，用量最高的模型排在最前；没有用量的保持后端顺序
  const tokensByModel = new Map(
    ((data.usage && data.usage.byModel) || []).map((item) => [modelKey(item.id), item.totalTokens || 0])
  );
  const models = [...(data.models || [])].sort((a, b) => {
    const kindDiff = (a.kind === 'chat' ? 0 : 1) - (b.kind === 'chat' ? 0 : 1);
    if (kindDiff) return kindDiff;
    return (tokensByModel.get(modelKey(b.id)) || 0) - (tokensByModel.get(modelKey(a.id)) || 0);
  });
  const activeFilter = state.filter === 'all' ? null : platformInfo(state.filter);
  if (activeFilter) $('modelsHint').textContent = `已筛选：${activeFilter.label}`;
  $('modelsCount').textContent = models.length;
  $('modelsList').innerHTML = models.length
    ? models.map(modelCard).join('')
    : emptyCard(
        state.filter === 'all' ? '未检测到模型记录' : '该平台暂无模型记录',
        state.filter === 'all' ? '本机暂未找到会话或配置中的 model 字段' : ''
      );
}

/* ------------------------------ 列表渲染 ------------------------------ */

function filtered(list) {
  if (state.filter === 'all') return list;
  return list.filter((item) => item.platform === state.filter);
}

function emptyCard(title, hint) {
  return `<div class="empty-line"><b>${esc(title)}</b>${esc(hint)}</div>`;
}

function skillCard(skill) {
  const description = skill.description
    ? `<p class="item-desc">${esc(skill.description)}</p>`
    : '<p class="item-desc muted">暂无 description</p>';
  const pluginChip = skill.plugin
    ? `<span class="scope-pill" title="来自插件">插件 ${esc(skill.plugin)}</span>`
    : '';
  return `
    <article class="item-card">
      <div class="item-head">
        <h3 class="item-name">${esc(skill.name)}</h3>
        ${platformTag(skill.platform)}
      </div>
      ${description}
      <div class="item-meta">
        ${scopePill(skill.scope)}
        ${pluginChip}
        <code class="path" title="${esc(skill.path)}">${esc(shortPath(skill.path))}</code>
      </div>
    </article>`;
}

function mcpCard(server) {
  const labels = { ok: '已配置', disabled: '已禁用', missing: '缺少启动命令' };
  const status = labels[server.status] || '未知';
  const command = server.commandText || '未配置启动命令';
  const source = server.sources && server.sources.length ? server.sources[0] : '';
  const envChip = server.envCount ? `<span class="stat-chip">env ${server.envCount}</span>` : '';
  return `
    <article class="item-card">
      <div class="item-head">
        <h3 class="item-name">${esc(server.name)}</h3>
        ${platformTag(server.platform)}
      </div>
      <code class="cmd" title="${esc(server.commandText || '')}">${esc(command)}</code>
      <div class="item-meta">
        <span class="status-pill status-${esc(server.status)}">${status}</span>
        ${scopePill(server.scope)}
        ${envChip}
        <code class="path" title="${esc(source)}">${esc(shortPath(source))}</code>
      </div>
    </article>`;
}

function renderLists(data) {
  const skills = filtered(data.skills);
  const servers = filtered(data.mcpServers);

  $('skillsCount').textContent = skills.length;
  $('mcpCount').textContent = servers.length;

  $('skillsList').innerHTML = skills.length
    ? skills.map(skillCard).join('')
    : emptyCard(
        state.filter === 'all' ? '未检测到 Skill' : '该平台暂无 Skill',
        state.filter === 'all' ? '按 <skill-name>/SKILL.md 结构放到 ~/.qoder/skills 等目录' : ''
      );

  $('mcpList').innerHTML = servers.length
    ? servers.map(mcpCard).join('')
    : emptyCard(
        state.filter === 'all' ? '未检测到 MCP 配置' : '该平台暂无 MCP 配置',
        state.filter === 'all' ? '可在 ~/.qoder/mcp.json 中配置 mcpServers' : ''
      );
}

/* ------------------------------ 模型开销 ------------------------------ */

function nailoongArt() {
  return `<img class="nailoong-illustration" src="./assets/nailoong-family.png" alt="奶龙家族" loading="lazy" />`;
}

function donutSvg(input, output, cache) {
  const total = input + output + cache;
  const segments = [
    { value: input, color: '#F5B800' },
    { value: output, color: '#6BCB77' },
    { value: cache, color: '#FFD93D' }
  ].filter((segment) => segment.value > 0);

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let arcs = '';
  let offset = 0;

  if (!segments.length) {
    arcs = `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="#F5EDD6" stroke-width="16" />`;
  } else {
    for (const segment of segments) {
      const share = segment.value / total;
      const length = Math.max(share * circumference - 3, 0.8);
      arcs += `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="16" stroke-dasharray="${length.toFixed(
        2
      )} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(
        2
      )}" stroke-linecap="butt" />`;
      offset += share * circumference;
    }
  }

  return `<svg viewBox="0 0 140 140" role="img" aria-label="Token 构成"><g transform="rotate(-90 70 70)">${arcs}</g></svg>`;
}

function dailyBars(daily) {
  const data = daily && daily.length ? daily : [];
  const max = Math.max(...data.map((day) => day.tokens || 0), 1);
  return data
    .map((day) => {
      const tokens = day.tokens || 0;
      const height = tokens > 0 ? Math.max((tokens / max) * 100, 6) : 0;
      const label = String(day.date || '').slice(5).replace('-', '/');
      return `<div class="bar-col" title="${esc(day.date)} · ${fmtTokens(tokens)} tokens · ${fmtCost(
        day.cost
      )}">
        <div class="bar-track"><div class="bar${tokens > 0 ? '' : ' zero'}" style="height:${height.toFixed(
        1
      )}%"></div></div>
        <span class="bar-label">${esc(label)}</span>
      </div>`;
    })
    .join('');
}

function sourceList(sources) {
  if (!sources || !sources.length) return '';
  return `
    <div class="source-list">
      ${sources
        .map(
          (source) => `
        <div class="source-row">
          <span class="source-dot ${esc(source.status)}"></span>
          <span class="source-name">${esc(source.name)}</span>
          <span class="source-detail" title="${esc(source.path)}">${esc(source.detail || '')}</span>
        </div>`
        )
        .join('')}
    </div>`;
}

function emptyUsageHtml(usage) {
  const hasError = Boolean(state.error);
  const creditOnly = !hasError && usage.credits > 0;
  const message = hasError
    ? '未能连接本地数据服务，请先启动 server.js。'
    : usage.message || '暂无本地用量记录。';
  const tips = hasError
    ? `<li>在该目录运行 <code>node server.js</code></li>
       <li>然后访问 <code>http://localhost:4173</code></li>
       <li>直接双击打开 HTML（file://）时，浏览器无法读取本地文件</li>`
    : usage.creditOnly
      ? `<li>Qoder 的 <code>message.usage</code> 里只有 credits，input / output token 都是 0</li>
         <li>该平台不上报 Token 数，因此无法换算成 Token 用量与费用</li>
         <li>Trae CN 本地也只记录「选过哪个模型」，不记录 Token</li>`
      : usage.detailEmpty
        ? `<li>本机只有 Codex 会话保存了逐模型的 Token 归属</li>
           <li>Trae CN / Qoder 等客户端只记录你选过哪个模型，不记录 Token 数</li>
           <li>想对比全局用量，可点左上角「← 返回总览」</li>`
        : `<li>安装 <b>himan-tracker</b> 或 <b>agentic-metric</b> 后此处将自动出现数据</li>
           <li>也可把用量记录放到 <code>~/.qoder/usage.json</code> 或 <code>~/.qoder/sessions/*.jsonl</code></li>
           <li>检测到工具后会展示 Token 拆分、费用估算与最近 7 天趋势</li>`;

  const credits = creditOnly
    ? `<div class="credit-box">
         <div class="credit-main">
           <span class="credit-value">${fmtCredits(usage.credits)}</span>
           <span class="credit-unit">credits</span>
         </div>
         <span class="credit-meta">Qoder · ${usage.requests} 次请求</span>
       </div>`
    : '';

  return `
    <div class="usage-empty">
      ${nailoongArt()}
      ${credits}
      <p class="empty-title">${creditOnly ? 'Qoder 只上报 credits' : '奶龙等待数据中…'}</p>
      <p class="empty-text">${esc(message)}</p>
      <ul class="tips">${tips}</ul>
      ${hasError ? '' : sourceList(usage.sources)}
    </div>`;
}

function renderUsage(data) {
  const usage = data.usage || EMPTY_DATA.usage;
  $('usageBadge').textContent = usage.available
    ? fmtTokens(usage.totalTokens)
    : usage.credits > 0
      ? `${fmtCredits(usage.credits)} cr`
      : '--';

  if (!usage.available) {
    $('usageBody').innerHTML = emptyUsageHtml(usage);
    return;
  }

  const dailyTotal = (usage.daily || []).reduce((sum, day) => sum + (day.tokens || 0), 0);
  const costLabel = usage.costEstimated ? '预估费用' : '费用';

  $('usageBody').innerHTML = `
    <div class="donut-block">
      <div class="donut-wrap">
        ${donutSvg(usage.inputTokens, usage.outputTokens, usage.cacheTokens)}
        <div class="donut-center">
          <span class="big">${fmtTokens(usage.totalTokens)}</span>
          <span class="small">总 Token</span>
        </div>
      </div>
      <div class="legend">
        <div class="legend-row"><span class="legend-dot" style="background:#F5B800"></span>输入<span class="val">${fmtTokens(
          usage.inputTokens
        )}</span></div>
        <div class="legend-row"><span class="legend-dot" style="background:#6BCB77"></span>输出<span class="val">${fmtTokens(
          usage.outputTokens
        )}</span></div>
        <div class="legend-row"><span class="legend-dot" style="background:#FFD93D"></span>缓存<span class="val">${fmtTokens(
          usage.cacheTokens
        )}</span></div>
      </div>
    </div>

    <div class="cost-box">
      <span class="label">${costLabel}</span>
      <span class="amount">${fmtCost(usage.cost)}</span>
    </div>

    ${
      usage.credits > 0
        ? `<div class="credit-note">Qoder 另记录 <strong>${fmtCredits(
            usage.credits
          )}</strong> credits（${usage.requests} 次请求）· 该平台只回传 credits，不提供 Token 数</div>`
        : ''
    }

    <div class="trend-block">
      <div class="trend-head">
        <h3>最近 7 天</h3>
        <span>${dailyTotal > 0 ? `${fmtTokens(dailyTotal)} tokens` : '暂无每日明细'}</span>
      </div>
      <div class="mini-bars">${dailyBars(usage.daily)}</div>
    </div>

    ${
      usage.costEstimated
        ? '<p class="tiny-note">费用按默认单价估算（输入 $3 / 输出 $15 / 缓存 $0.3 每百万 Token），仅供粗略参考。</p>'
        : '<p class="tiny-note">费用来自本地用量记录中的 cost 字段。</p>'
    }
    ${sourceList(usage.sources)}`;
}

/* ------------------------------ 错误与状态 ------------------------------ */

function renderBanner() {
  const banner = $('banner');
  const missingDetail = state.detailId && state.data && !findDetailModel(state.data);
  if (!state.error && !missingDetail) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  if (state.error) {
    banner.innerHTML = `<b>无法连接本地数据服务。</b>请在该目录运行 <code>node server.js</code>，然后访问
    <code>http://localhost:4173</code>。直接双击打开 HTML（file://）时，浏览器不允许读取本地文件，必须通过 Node 服务启动。`;
    return;
  }
  banner.innerHTML = `<b>未找到模型「${esc(state.detailId)}」。</b><a href="./">返回总览</a>`;
}

function renderMeta(data) {
  const time = data.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--';
  const projectDir = data.meta && data.meta.projectDir ? shortPath(data.meta.projectDir) : '--';
  $('metaLine').innerHTML = state.error
    ? ''
    : `最近读取 <strong>${esc(time)}</strong> · 项目级扫描 <code>${esc(projectDir)}</code>`;
  $('projectPath').textContent = projectDir;
}

function renderAll() {
  const base = state.data || EMPTY_DATA;
  const view = buildView(base);
  renderBanner();
  renderDetailHeader(base);
  renderSummary(view);
  renderFilters(view);
  renderStats(view);
  renderModels(view);
  renderLists(view);
  renderUsage(view);
  renderMeta(base);
}

function setLoading(loading) {
  state.loading = loading;
  const button = $('refreshBtn');
  button.disabled = loading;
  button.textContent = loading ? '读取中…' : '刷新数据';
}

async function loadData(force = false) {
  if (state.loading) return;
  setLoading(true);
  try {
    const response = await fetch(`./api/data?t=${Date.now()}${force ? '&refresh=1' : ''}`, {
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.data = data;
    state.error = '';
  } catch (err) {
    state.error = err && err.message ? err.message : '连接失败';
  } finally {
    setLoading(false);
    renderAll();
  }
}

/* ------------------------------ 初始化 ------------------------------ */

$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.filter = button.getAttribute('data-filter') || 'all';
  renderAll();
});

$('refreshBtn').addEventListener('click', () => {
  loadData(true);
});

renderAll();
loadData();
