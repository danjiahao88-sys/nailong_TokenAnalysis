'use strict';

/**
 * 奶龙 Agent 管理台 · 本地数据服务
 *
 * 只读取本机文件，不发起任何外部网络请求，也不会上传任何内容。
 * 启动：node server.js [--project <目录>] [--port <端口>]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const HOME = os.homedir();
const DASH_DIR = __dirname;

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const PROJECT_DIR = path.resolve(argValue('--project') || process.env.PROJECT_DIR || process.cwd());
const START_PORT = Number(argValue('--port') || process.env.PORT || 4173) || 4173;

const PLATFORM_META = {
  qoder: { label: 'Qoder', emoji: '🟡' },
  trae: { label: 'Trae CN', emoji: '🟩' },
  cursor: { label: 'Cursor', emoji: '⚫' },
  claude: { label: 'Claude', emoji: '🟠' },
  codex: { label: 'Codex', emoji: '🔵' },
  qwen: { label: 'Qwen', emoji: '🟢' },
  copilot: { label: 'Copilot', emoji: '⚪' }
};

const PLATFORM_ORDER = ['qoder', 'trae', 'claude', 'cursor', 'codex', 'qwen', 'copilot'];
const platformRank = (key) => {
  const i = PLATFORM_ORDER.indexOf(key);
  return i === -1 ? PLATFORM_ORDER.length : i;
};

/* ------------------------------ 数据源定义 ------------------------------ */

const SKILL_SOURCES = [
  { platform: 'qoder', scope: 'global', dir: path.join(HOME, '.qoder', 'skills') },
  { platform: 'cursor', scope: 'global', dir: path.join(HOME, '.cursor', 'skills') },
  { platform: 'claude', scope: 'global', dir: path.join(HOME, '.claude', 'skills') },
  { platform: 'codex', scope: 'global', dir: path.join(HOME, '.codex', 'skills') },
  { platform: 'qwen', scope: 'global', dir: path.join(HOME, '.qwen', 'skills') },
  { platform: 'trae', scope: 'global', dir: path.join(HOME, '.trae-cn', 'builtin_skills') },
  { platform: 'qoder', scope: 'project', dir: path.join(PROJECT_DIR, '.qoder', 'skills') },
  { platform: 'cursor', scope: 'project', dir: path.join(PROJECT_DIR, '.cursor', 'skills') },
  { platform: 'claude', scope: 'project', dir: path.join(PROJECT_DIR, '.claude', 'skills') },
  { platform: 'codex', scope: 'project', dir: path.join(PROJECT_DIR, '.codex', 'skills') },
  { platform: 'qwen', scope: 'project', dir: path.join(PROJECT_DIR, '.qwen', 'skills') },
  { platform: 'copilot', scope: 'project', dir: path.join(PROJECT_DIR, '.github', 'skills') }
];

const PLUGIN_SOURCES = [
  { platform: 'qoder', scope: 'global', dir: path.join(HOME, '.qoder', 'plugins') },
  { platform: 'trae', scope: 'global', dir: path.join(HOME, '.trae-cn', 'plugins') },
  { platform: 'qoder', scope: 'project', dir: path.join(PROJECT_DIR, '.qoder-plugin') }
];

const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const MCP_SOURCES = [
  { platform: 'qoder', scope: 'global', file: path.join(HOME, '.qoder', 'mcp.json') },
  { platform: 'qoder', scope: 'project', file: path.join(PROJECT_DIR, '.qoder', 'mcp.json') },
  { platform: 'qoder', scope: 'global', file: path.join(HOME, '.qoder', 'settings.json'), field: 'mcpServers' },
  { platform: 'trae', scope: 'global', file: path.join(APPDATA, 'Trae CN', 'User', 'mcp.json') },
  { platform: 'trae', scope: 'global', file: path.join(HOME, '.trae-cn', 'mcp.json') },
  { platform: 'trae', scope: 'project', file: path.join(PROJECT_DIR, '.trae', 'mcp.json') },
  { platform: 'cursor', scope: 'global', file: path.join(HOME, '.cursor', 'mcp.json') },
  { platform: 'cursor', scope: 'project', file: path.join(PROJECT_DIR, '.cursor', 'mcp.json') },
  { platform: 'claude', scope: 'project', file: path.join(PROJECT_DIR, '.mcp.json') }
];

const PRICE_PER_MILLION = { input: 3, output: 15, cache: 0.3 };

/* ------------------------------ 通用工具 ------------------------------ */

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function readText(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function readJsonSafe(file, maxBytes = 2 * 1024 * 1024) {
  const text = readText(file, maxBytes);
  if (text == null) return { ok: false, error: '文件不存在或过大' };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDateString(value) {
  if (value == null || typeof value === 'object') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    let n = value;
    if (n > 1e12) {
      // 毫秒时间戳
    } else if (n > 1e9) {
      n *= 1000;
    } else {
      return null;
    }
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : localDate(d);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d{10}$/.test(s) || /^\d{13}$/.test(s)) return toDateString(Number(s));
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) return localDate(d);
  }
  return null;
}

function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    let lastKey = null;
    for (const line of match[1].split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/^\s+/.test(line) && lastKey) {
        meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim();
        continue;
      }
      const idx = line.indexOf(':');
      if (idx < 0) {
        lastKey = null;
        continue;
      }
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (/^[>|][+-]?$/.test(value)) value = '';
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
      lastKey = key;
    }
  }
  return { meta, body };
}

function firstParagraph(body) {
  const buffer = [];
  for (const rawLine of String(body || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (buffer.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (buffer.length) break;
      continue;
    }
    if (/^[=-]{3,}$/.test(line) || line.startsWith('```') || line.startsWith('<!--')) continue;
    buffer.push(line.replace(/^[-*+>]\s+/, ''));
  }
  return buffer.join(' ').slice(0, 320);
}

/* ------------------------------ Skill 扫描 ------------------------------ */

function findSkillFile(dir) {
  const files = safeReaddir(dir);
  const hit = files.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
  return hit ? path.join(dir, hit.name) : null;
}

function addSkillFromFile(file, fallbackName, platform, scope, plugin, out, notes, seenFiles) {
  const real = safeRealpath(file);
  if (seenFiles.has(real)) return;
  seenFiles.add(real);
  const text = readText(file);
  if (text == null) {
    notes.push(`无法读取 Skill 文件：${file}`);
    return;
  }
  const { meta, body } = parseFrontmatter(text);
  out.push({
    name: String(meta.name || fallbackName || path.basename(path.dirname(file))).trim(),
    description: String(meta.description || firstParagraph(body) || '').trim(),
    platform,
    scope,
    plugin: plugin || null,
    path: file
  });
}

function scanSkillsDir(dir, platform, scope, plugin, out, notes, seenDirs, seenFiles) {
  if (!isDir(dir)) return;
  const real = safeRealpath(dir);
  if (seenDirs.has(real)) return;
  seenDirs.add(real);

  for (const entry of safeReaddir(dir)) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (isDir(full)) {
      const skillFile = findSkillFile(full);
      if (skillFile) addSkillFromFile(skillFile, entry.name, platform, scope, plugin, out, notes, seenFiles);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      addSkillFromFile(full, entry.name.replace(/\.md$/i, ''), platform, scope, plugin, out, notes, seenFiles);
    }
  }
}

function findSkillDirs(root, maxDepth = 4) {
  const result = [];
  const visit = (dir, depth) => {
    if (depth >= maxDepth) return;
    for (const entry of safeReaddir(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'skills') {
        result.push(full);
        continue;
      }
      visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return result;
}

function pluginLabel(root, skillDir) {
  const parts = path
    .relative(root, path.dirname(skillDir))
    .split(path.sep)
    .filter(Boolean);
  while (parts.length && /^\d+(\.\d+)*([-+].*)?$/.test(parts[parts.length - 1])) parts.pop();
  return parts.length ? parts[parts.length - 1] : path.basename(root);
}

function collectSkills(notes) {
  const out = [];
  const seenDirs = new Set();
  const seenFiles = new Set();

  for (const src of SKILL_SOURCES) {
    scanSkillsDir(src.dir, src.platform, src.scope, null, out, notes, seenDirs, seenFiles);
  }

  // 插件目录：支持 <plugin>/skills/、<registry>/<plugin>/<version>/skills/ 等层级
  for (const src of PLUGIN_SOURCES) {
    if (!isDir(src.dir)) continue;
    for (const skillDir of findSkillDirs(src.dir, 4)) {
      scanSkillsDir(
        skillDir,
        src.platform,
        src.scope,
        pluginLabel(src.dir, skillDir),
        out,
        notes,
        seenDirs,
        seenFiles
      );
    }
  }

  return out.sort((a, b) => platformRank(a.platform) - platformRank(b.platform) || a.name.localeCompare(b.name));
}

/* ------------------------------ MCP 扫描 ------------------------------ */

function normalizeMcpServers(raw) {
  if (!raw) return [];
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw
      .filter((item) => item && typeof item === 'object' && item.name)
      .map((item) => [String(item.name), item]);
  } else if (typeof raw === 'object') {
    entries = Object.entries(raw);
  }

  const result = [];
  for (const [name, cfg] of entries) {
    if (!cfg || typeof cfg !== 'object') continue;
    const command = String(cfg.command || cfg.cmd || '').trim();
    const url = String(cfg.url || cfg.serverUrl || '').trim();
    const args = Array.isArray(cfg.args)
      ? cfg.args.map((arg) => String(arg))
      : cfg.args
        ? [String(cfg.args)]
        : [];
    const disabled = cfg.disabled === true || cfg.enabled === false;
    const commandText = url && !command ? url : [command, ...args].filter(Boolean).join(' ');
    let status = 'ok';
    if (disabled) status = 'disabled';
    else if (!command && !url) status = 'missing';

    result.push({
      name: String(name),
      command,
      args,
      url,
      type: String(cfg.type || (url ? 'remote' : 'stdio')),
      envCount: cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env).length : 0,
      commandText,
      status
    });
  }
  return result;
}

function collectMcp(notes) {
  const map = new Map();

  for (const src of MCP_SOURCES) {
    if (!isFile(src.file)) continue;
    const parsed = readJsonSafe(src.file);
    if (!parsed.ok) {
      notes.push(`MCP 配置解析失败：${src.file}（${parsed.error}）`);
      continue;
    }
    const root = parsed.data;
    let raw = null;
    if (src.field && root && typeof root === 'object') raw = root[src.field];
    else if (root && typeof root === 'object') raw = root.mcpServers || root.servers || null;

    if (!raw) continue;
    for (const server of normalizeMcpServers(raw)) {
      const key = `${src.platform}|${src.scope}|${server.name}`;
      if (!map.has(key)) {
        map.set(key, {
          ...server,
          platform: src.platform,
          scope: src.scope,
          sources: [src.file]
        });
      } else {
        const existing = map.get(key);
        if (!existing.sources.includes(src.file)) existing.sources.push(src.file);
      }
    }
  }

  return [...map.values()].sort(
    (a, b) => platformRank(a.platform) - platformRank(b.platform) || a.name.localeCompare(b.name)
  );
}

/* ------------------------------ 用量解析 ------------------------------ */

function classifyTokenKey(key) {
  if (!/token/i.test(key)) return null;
  const low = key.toLowerCase();
  if (/cache/.test(low)) return 'cache';
  if (/input|prompt/.test(low)) return 'input';
  if (/output|completion|reasoning/.test(low)) return 'output';
  return 'total';
}

function extractUsageRecord(obj) {
  let input = 0;
  let output = 0;
  let cache = 0;
  let explicitTotal = null;
  let found = false;

  for (const [key, value] of Object.entries(obj)) {
    const kind = classifyTokenKey(key);
    if (!kind) continue;
    const n = toNumber(value);
    if (n == null) continue;
    found = true;
    if (kind === 'input') input += n;
    else if (kind === 'output') output += n;
    else if (kind === 'cache') cache += n;
    else explicitTotal = (explicitTotal || 0) + n;
  }

  if (!found) return null;

  let cost = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (!/cost|price|spend|usd|charge/i.test(key)) continue;
    const n = toNumber(value);
    if (n != null) cost += n;
  }

  const total = explicitTotal != null ? explicitTotal : input + output + cache;
  if (total <= 0 && cost <= 0) return null;
  return { input, output, cache, total, cost };
}

function extractDate(obj) {
  for (const key of Object.keys(obj)) {
    if (!/(timestamp|date|time|created|updated|start|end|day|period|ts)/i.test(key)) continue;
    const value = obj[key];
    if (value == null || typeof value === 'object') continue;
    const date = toDateString(value);
    if (date) return date;
  }
  return null;
}

/** 从对象里找模型标识，用于把用量记录归属到具体模型 */
function modelFieldOf(obj) {
  for (const key of Object.keys(obj)) {
    if (!/^(model|modelName|model_name|modelId|model_id)$/i.test(key)) continue;
    const value = obj[key];
    if (typeof value === 'string' && value.trim() && value.trim().length <= 64) return value.trim();
  }
  return null;
}

function walkUsage(node, records, ctx, depth = 0) {
  if (ctx.budget.nodes <= 0 || depth > 14) return;
  ctx.budget.nodes -= 1;
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) walkUsage(item, records, ctx, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const record = extractUsageRecord(node);
  if (record) {
    record.date = extractDate(node) || ctx.dateHint || null;
    record.model = modelFieldOf(node) || ctx.modelHint || null;
    records.push(record);
    return;
  }

  const dateHint = extractDate(node) || ctx.dateHint || null;
  const modelHint = modelFieldOf(node) || ctx.modelHint || null;
  for (const value of Object.values(node)) {
    walkUsage(value, records, { ...ctx, dateHint, modelHint }, depth + 1);
  }
}

function parseUsageText(text, records, fallbackDate, budget) {
  try {
    const json = JSON.parse(text);
    walkUsage(json, records, { dateHint: fallbackDate, budget }, 0);
  } catch (err) {
    return err.message;
  }
  return null;
}

function parseUsageJsonl(text, records, fallbackDate, budget) {
  let errors = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      walkUsage(JSON.parse(trimmed), records, { dateHint: fallbackDate, budget }, 0);
    } catch {
      errors += 1;
    }
  }
  return errors;
}

function walkFiles(root, options = {}) {
  const exts = options.exts || [];
  const maxDepth = options.maxDepth == null ? 2 : options.maxDepth;
  const limit = options.limit || 200;
  const files = [];

  const visit = (dir, depth) => {
    if (files.length >= limit) return;
    for (const entry of safeReaddir(dir)) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (exts.length && !exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue;
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      files.push({ file: full, mtimeMs });
      if (files.length >= limit) return;
    }
  };

  if (isDir(root)) visit(root, 0);
  return files;
}

function collectJsonUsageFiles(files, name, options = {}) {
  const records = [];
  let parsedFiles = 0;
  let failedFiles = 0;
  const maxBytes = options.maxBytes || 4 * 1024 * 1024;

  for (const item of files) {
    const text = readText(item.file, maxBytes);
    if (text == null) continue;
    const fallbackDate = options.noFallbackDate
      ? null
      : localDate(new Date(item.mtimeMs));
    const budget = { nodes: 150000 };
    let error = null;
    if (item.file.toLowerCase().endsWith('.jsonl')) {
      const errors = parseUsageJsonl(text, records, fallbackDate, budget);
      if (errors > 0 && records.length === 0) failedFiles += 1;
    } else {
      error = parseUsageText(text, records, fallbackDate, budget);
      if (error) failedFiles += 1;
    }
    if (!error) parsedFiles += 1;
  }

  if (!files.length) return null;
  const detail = `${parsedFiles} 个文件 · ${records.length} 条用量记录${failedFiles ? ` · ${failedFiles} 个解析失败` : ''}`;
  return {
    name,
    path: options.pathLabel || '',
    status: records.length ? 'ok' : failedFiles ? 'error' : 'empty',
    detail,
    records,
    daily: []
  };
}

function qid(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function readSqliteUsage(file) {
  const out = { records: [], daily: [], detail: '', error: null };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    out.error = '当前 Node 不支持内置 SQLite（建议 Node 22.5+）';
    return out;
  }

  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      db = new DatabaseSync(file);
    } catch (err) {
      out.error = `无法打开数据库：${err.message}`;
      return out;
    }
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();

    for (const row of tables) {
      const table = String(row.name);
      let columnRows = [];
      try {
        columnRows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
      } catch {
        try {
          columnRows = db.prepare(`PRAGMA table_info(${qid(table)})`).all();
        } catch {
          continue;
        }
      }

      const columns = columnRows.map((col) => String(col.name));
      const tokenColumns = columns.filter((col) => classifyTokenKey(col));
      if (!tokenColumns.length) continue;

      const dateColumn =
        columns.find((col) =>
          /^(date|day|timestamp|time|ts|created_at|created|updated_at|period|start_time)$/i.test(col)
        ) || null;
      const costColumns = columns.filter(
        (col) => /cost|price|amount|spend/i.test(col) && !/token/i.test(col)
      );

      const tokenSelects = tokenColumns
        .map((col, index) => `SUM(CAST(${qid(col)} AS REAL)) AS t${index}`)
        .join(', ');
      const costSelects = costColumns
        .map((col, index) => `SUM(CAST(${qid(col)} AS REAL)) AS c${index}`)
        .join(', ');
      const selects = [tokenSelects, costSelects].filter(Boolean).join(', ');
      if (!selects) continue;

      let aggregate = null;
      try {
        aggregate = db.prepare(`SELECT ${selects} FROM ${qid(table)}`).get();
      } catch {
        continue;
      }
      if (!aggregate) continue;

      let input = 0;
      let output = 0;
      let cache = 0;
      let explicitTotal = null;
      let cost = 0;

      tokenColumns.forEach((col, index) => {
        const value = toNumber(aggregate[`t${index}`]) || 0;
        const kind = classifyTokenKey(col);
        if (kind === 'input') input += value;
        else if (kind === 'output') output += value;
        else if (kind === 'cache') cache += value;
        else explicitTotal = (explicitTotal || 0) + value;
      });
      costColumns.forEach((col, index) => {
        cost += toNumber(aggregate[`c${index}`]) || 0;
      });

      const total = explicitTotal != null ? explicitTotal : input + output + cache;
      if (total <= 0 && cost <= 0) continue;

      out.records.push({ input, output, cache, total, cost, date: null });
      out.detail = `数据表 ${table} · ${tokenColumns.length} 个 Token 字段`;
      out.table = table;

      if (dateColumn) {
        try {
          const dailySelects = tokenSelects + (costSelects ? `, ${costSelects}` : '');
          const rows = db
            .prepare(
              `SELECT ${qid(dateColumn)} AS d, ${dailySelects} FROM ${qid(table)} GROUP BY d ORDER BY d DESC LIMIT 2000`
            )
            .all();
          for (const dailyRow of rows) {
            const date = toDateString(dailyRow.d);
            if (!date) continue;
            let dayInput = 0;
            let dayOutput = 0;
            let dayCache = 0;
            let dayExplicitTotal = null;
            let dayCost = 0;
            tokenColumns.forEach((col, index) => {
              const value = toNumber(dailyRow[`t${index}`]) || 0;
              const kind = classifyTokenKey(col);
              if (kind === 'input') dayInput += value;
              else if (kind === 'output') dayOutput += value;
              else if (kind === 'cache') dayCache += value;
              else dayExplicitTotal = (dayExplicitTotal || 0) + value;
            });
            costColumns.forEach((col, index) => {
              dayCost += toNumber(dailyRow[`c${index}`]) || 0;
            });
            const dayTotal =
              dayExplicitTotal != null ? dayExplicitTotal : dayInput + dayOutput + dayCache;
            if (dayTotal > 0 || dayCost > 0) out.daily.push({ date, tokens: dayTotal, cost: dayCost });
          }
        } catch {
          // 无法按日期聚合时忽略即可，总账仍然可用
        }
      }
      break;
    }
  } catch (err) {
    out.error = `读取数据库失败：${err.message}`;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  return out;
}

/* ------------------------------ Codex 会话 ------------------------------ */

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(size - bytes, 0);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function bestTokenUsage(text) {
  let best = null;
  for (const match of text.matchAll(/"total_token_usage":\{([^}]*)\}/g)) {
    const usage = {};
    for (const kv of match[1].matchAll(/"(\w+)":(\d+)/g)) usage[kv[1]] = Number(kv[2]);
    if (!usage.total_tokens) continue;
    if (!best || usage.total_tokens >= best.total_tokens) best = usage;
  }
  return best;
}

let codexScanCache = { at: 0, signature: '', data: null };
const CODEX_SCAN_TTL = 5 * 60 * 1000;

/** 用文件数量和最新修改时间判断会话目录是否变化，避免重复扫描大文件 */
function codexSignature(dir) {
  let count = 0;
  let totalSize = 0;
  let latest = 0;
  const visit = (current, depth) => {
    if (depth > 5) return;
    for (const entry of safeReaddir(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!/\.jsonl(\.zst)?$/i.test(entry.name)) continue;
      try {
        const stat = fs.statSync(full);
        count += 1;
        totalSize += stat.size;
        latest = Math.max(latest, stat.mtimeMs);
      } catch {
        // 文件在扫描过程中被删除时忽略
      }
    }
  };
  visit(dir, 0);
  return `${count}:${totalSize}:${Math.round(latest)}`;
}

/** Codex 会话：读取 token_count 累计值与会话模型，供用量与模型列表共用 */
function scanCodexSessions(force = false) {
  const now = Date.now();
  const dir = path.join(HOME, '.codex', 'sessions');
  const signature = isDir(dir) ? codexSignature(dir) : '';

  if (
    !force &&
    codexScanCache.data &&
    codexScanCache.signature === signature &&
    now - codexScanCache.at < CODEX_SCAN_TTL
  ) {
    return codexScanCache.data;
  }

  const result = { dir, records: [], models: [], parsedFiles: 0 };
  if (!isDir(dir)) {
    codexScanCache = { at: now, signature, data: result };
    return result;
  }

  const visit = (current, depth) => {
    if (depth > 5) return;
    for (const entry of safeReaddir(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!/\.jsonl(\.zst)?$/i.test(entry.name)) continue;

      const compressed = entry.name.endsWith('.zst');
      let head = '';
      let tail = '';
      try {
        if (compressed) {
          const text = zlib.zstdDecompressSync(fs.readFileSync(full)).toString('utf8');
          head = text.slice(0, 256 * 1024);
          tail = text;
        } else {
          head = readHead(full, 256 * 1024);
          tail = readTail(full, 4 * 1024 * 1024);
        }
      } catch {
        continue;
      }

      let best = bestTokenUsage(tail);
      if (!best && !compressed) {
        try {
          best = bestTokenUsage(fs.readFileSync(full, 'utf8'));
        } catch {
          best = null;
        }
      }
      if (!best) continue;

      result.parsedFiles += 1;
      const rel = path.relative(dir, full).split(path.sep);
      const date =
        /^\d{4}$/.test(rel[0] || '') && /^\d{2}$/.test(rel[1] || '') && /^\d{2}$/.test(rel[2] || '')
          ? `${rel[0]}-${rel[1]}-${rel[2]}`
          : null;

      let model = null;
      const provenance = /"provenance"\s*:\s*\{[^}]*"model"\s*:\s*"([^"]{2,64})"/.exec(head);
      if (provenance) {
        model = provenance[1];
      } else {
        const firstModel = /"model"\s*:\s*"([^"]{2,64})"/.exec(head);
        if (firstModel) model = firstModel[1];
      }
      if (model) result.models.push(model);

      result.records.push({
        input: Math.max((best.input_tokens || 0) - (best.cached_input_tokens || 0), 0),
        output: best.output_tokens || 0,
        cache: best.cached_input_tokens || 0,
        total: best.total_tokens || 0,
        cost: 0,
        date,
        model
      });
    }
  };

  visit(dir, 0);
  codexScanCache = { at: now, signature, data: result };
  return result;
}

/* ------------------------------ Qoder 会话（credits） ------------------------------ */

let qoderScanCache = { at: 0, signature: '', data: null };
const QODER_SCAN_TTL = 5 * 60 * 1000;

/**
 * Qoder CLI 把每次请求的用量写在 ~/.qoder/projects/**\/*.jsonl 的 message.usage 里。
 * 本机上 input/output token 全为 0，但 credits 有值，因此单独统计 credits。
 */
function scanQoderSessions(force = false) {
  const dirs = [path.join(HOME, '.qoder', 'projects')].filter(isDir);
  const dir = dirs[0] || path.join(HOME, '.qoder', 'projects');
  const signature = dirs.map((item) => codexSignature(item)).join('|');
  const now = Date.now();

  if (
    !force &&
    qoderScanCache.data &&
    qoderScanCache.signature === signature &&
    now - qoderScanCache.at < QODER_SCAN_TTL
  ) {
    return qoderScanCache.data;
  }

  const result = { dir, records: [], credits: 0, requests: 0, models: [] };
  const models = new Set();

  for (const root of dirs) {
    for (const item of walkFiles(root, { exts: ['.jsonl'], maxDepth: 5, limit: 400 })) {
      const text = readText(item.file, 16 * 1024 * 1024);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line || line.indexOf('"usage"') < 0) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = row && row.message && row.message.usage;
        if (!usage || typeof usage !== 'object') continue;

        const input = toNumber(usage.input_tokens) || 0;
        const output = toNumber(usage.output_tokens) || 0;
        const cacheRead = toNumber(usage.cache_read_input_tokens) || 0;
        const cacheWrite = toNumber(usage.cache_creation_input_tokens) || 0;
        const credits = toNumber(usage.credits) || 0;
        if (!input && !output && !cacheRead && !cacheWrite && !credits) continue;

        const model = row.message.model ? String(row.message.model) : null;
        if (model) models.add(model);
        result.credits += credits;
        result.requests += 1;
        result.records.push({
          input,
          output,
          cache: cacheRead + cacheWrite,
          total: input + output + cacheRead + cacheWrite,
          credits,
          requests: 1,
          cost: 0,
          date: toDateString(row.timestamp),
          model
        });
      }
    }
  }

  result.models = [...models];
  qoderScanCache = { at: now, signature, data: result };
  return result;
}

function collectUsage(codexScan, force = false) {
  const sources = [];

  // 1) Qoder 用量记录
  const qoderUsageFile = path.join(HOME, '.qoder', 'usage.json');
  if (isFile(qoderUsageFile)) {
    const source = collectJsonUsageFiles([{ file: qoderUsageFile, mtimeMs: Date.now() }], 'Qoder usage.json', {
      pathLabel: qoderUsageFile,
      noFallbackDate: true
    });
    if (source) sources.push(source);
  }

  const qoderSessionsDir = path.join(HOME, '.qoder', 'sessions');
  if (isDir(qoderSessionsDir)) {
    const files = walkFiles(qoderSessionsDir, { exts: ['.jsonl', '.json'], maxDepth: 3, limit: 300 });
    const source = collectJsonUsageFiles(files, 'Qoder sessions', { pathLabel: qoderSessionsDir });
    if (source) sources.push(source);
  }

  // 2) himan-tracker（本地 SQLite）
  const himanDir = path.join(HOME, '.himan-tracker');
  if (isDir(himanDir)) {
    const dbFiles = walkFiles(himanDir, { exts: ['.sqlite', '.sqlite3', '.db'], maxDepth: 1, limit: 20 });
    const records = [];
    const daily = [];
    let error = null;
    let detail = '';
    for (const item of dbFiles) {
      const result = readSqliteUsage(item.file);
      if (result.error) {
        error = error || result.error;
        detail = detail || `${path.basename(item.file)}：${result.error}`;
        continue;
      }
      records.push(...result.records);
      daily.push(...result.daily);
      if (result.detail) detail = `${path.basename(item.file)} · ${result.detail}`;
    }
    sources.push({
      name: 'himan-tracker',
      path: himanDir,
      status: records.length || daily.length ? 'ok' : error ? 'error' : 'empty',
      detail: detail || '未找到可解析的 Token 字段',
      records,
      daily
    });
  }

  // 3) agentic-metric
  const agenticDir = path.join(HOME, '.agentic-metric');
  if (isDir(agenticDir)) {
    const files = walkFiles(agenticDir, {
      exts: ['.json', '.jsonl', '.sqlite', '.sqlite3', '.db'],
      maxDepth: 2,
      limit: 200
    });
    const records = [];
    const daily = [];
    let error = null;
    let detail = '';

    const jsonFiles = files.filter((item) => /\.jsonl?$/i.test(item.file));
    const dbFiles = files.filter((item) => !/\.jsonl?$/i.test(item.file));

    if (jsonFiles.length) {
      const result = collectJsonUsageFiles(jsonFiles, 'agentic-metric', { pathLabel: agenticDir });
      if (result) {
        records.push(...result.records);
        detail = result.detail;
      }
    }
    for (const item of dbFiles) {
      const result = readSqliteUsage(item.file);
      if (result.error) {
        error = error || result.error;
        continue;
      }
      records.push(...result.records);
      daily.push(...result.daily);
      if (result.detail) detail = `${path.basename(item.file)} · ${result.detail}`;
    }

    sources.push({
      name: 'agentic-metric',
      path: agenticDir,
      status: records.length || daily.length ? 'ok' : error ? 'error' : 'empty',
      detail: detail || (error ? `读取失败：${error}` : '未找到可解析的 Token 字段'),
      records,
      daily
    });
  }

  // 4) Codex 会话：token_count 事件里的 total_token_usage（含 .jsonl.zst）
  const codex = codexScan || scanCodexSessions();
  if (codex.parsedFiles) {
    sources.push({
      name: 'Codex 会话',
      path: codex.dir,
      status: 'ok',
      detail: `${codex.parsedFiles} 个会话文件`,
      records: codex.records,
      daily: []
    });
  }

  // 5) Qoder 会话：只回传 credits，input/output token 均为 0
  const qoder = scanQoderSessions(force);
  if (qoder.records.length) {
    sources.push({
      name: 'Qoder 会话',
      path: qoder.dir,
      status: 'ok',
      detail: `${qoder.requests} 次请求 · ${qoder.credits.toFixed(2)} credits（未记录 Token）`,
      records: qoder.records,
      daily: []
    });
  }

  return summarizeUsage(sources);
}

function usageModelKey(value) {
  const key = normalizeTraeModelId(String(value || '').trim()).toLowerCase();
  return MODEL_ID_ALIASES.get(key) || key;
}

function lastSevenDays(dailyMap) {
  const daily = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const key = localDate(date);
    const value = dailyMap.get(key);
    daily.push({ date: key, tokens: value ? value.tokens : 0, cost: value ? value.cost : 0 });
  }
  return daily;
}

function summarizeUsage(sources) {
  let input = 0;
  let output = 0;
  let cache = 0;
  let total = 0;
  let actualCost = 0;
  let credits = 0;
  let requests = 0;
  const dailyMap = new Map();
  const modelMap = new Map();

  const addDaily = (map, date, tokens, cost) => {
    if (!date) return;
    const current = map.get(date) || { tokens: 0, cost: 0 };
    current.tokens += tokens || 0;
    current.cost += cost || 0;
    map.set(date, current);
  };

  for (const source of sources) {
    for (const record of source.records || []) {
      input += record.input || 0;
      output += record.output || 0;
      cache += record.cache || 0;
      const recordTotal =
        Number(record.total) || (record.input || 0) + (record.output || 0) + (record.cache || 0);
      total += recordTotal;
      actualCost += record.cost || 0;
      credits += record.credits || 0;
      requests += record.requests || 0;
      if (record.date) addDaily(dailyMap, record.date, recordTotal, record.cost || 0);

      if (!record.model) continue;
      const key = usageModelKey(record.model);
      if (!key) continue;
      let bucket = modelMap.get(key);
      if (!bucket) {
        bucket = {
          id: MODEL_ID_ALIASES.get(String(record.model).toLowerCase()) || record.model,
          input: 0,
          output: 0,
          cache: 0,
          total: 0,
          cost: 0,
          credits: 0,
          requests: 0,
          dailyMap: new Map(),
          sources: new Set()
        };
        modelMap.set(key, bucket);
      }
      bucket.input += record.input || 0;
      bucket.output += record.output || 0;
      bucket.cache += record.cache || 0;
      bucket.total += recordTotal;
      bucket.cost += record.cost || 0;
      bucket.credits += record.credits || 0;
      bucket.requests += record.requests || 0;
      bucket.sources.add(source.name);
      if (record.date) addDaily(bucket.dailyMap, record.date, recordTotal, record.cost || 0);
    }
    for (const day of source.daily || []) addDaily(dailyMap, day.date, day.tokens, day.cost);
  }

  const daily = lastSevenDays(dailyMap);

  const estimated =
    (input / 1e6) * PRICE_PER_MILLION.input +
    (output / 1e6) * PRICE_PER_MILLION.output +
    (cache / 1e6) * PRICE_PER_MILLION.cache;
  const cost = actualCost > 0 ? actualCost : estimated;
  const available = total > 0 || actualCost > 0;

  const byModel = [...modelMap.values()]
    .map((bucket) => {
      const estimatedCost =
        (bucket.input / 1e6) * PRICE_PER_MILLION.input +
        (bucket.output / 1e6) * PRICE_PER_MILLION.output +
        (bucket.cache / 1e6) * PRICE_PER_MILLION.cache;
      const bucketCost = bucket.cost > 0 ? bucket.cost : estimatedCost;
      return {
        id: bucket.id,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheTokens: bucket.cache,
        totalTokens: bucket.total,
        cost: Number(bucketCost.toFixed(4)),
        costEstimated: bucket.cost <= 0 && bucketCost > 0,
        credits: Number(bucket.credits.toFixed(4)),
        requests: bucket.requests,
        daily: lastSevenDays(bucket.dailyMap),
        sources: [...bucket.sources]
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.credits - a.credits);

  let message = '';
  if (!available) {
    if (credits > 0) {
      message = 'Qoder 只记录了 credits，没有记录 Token 数。';
    } else {
      message = sources.length
        ? '检测到本地用量数据，但暂未解析到 Token 字段。'
        : '暂无本地用量记录。';
    }
  }

  return {
    available,
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    cacheTokens: cache,
    cost: Number(cost.toFixed(4)),
    costEstimated: actualCost <= 0 && cost > 0,
    credits: Number(credits.toFixed(4)),
    requests,
    daily,
    byModel,
    message,
    sources: sources.map((source) => ({
      name: source.name,
      path: source.path,
      status: source.status,
      detail: source.detail
    }))
  };
}

/* ------------------------------ 大模型使用记录 ------------------------------ */

const MODEL_VENDOR_RULES = [
  { test: /deepseek/i, vendor: 'DeepSeek' },
  { test: /doubao|豆包/i, vendor: '豆包' },
  { test: /qwen|通义/i, vendor: '通义千问' },
  { test: /\bgpt|openai/i, vendor: 'OpenAI' },
  { test: /claude/i, vendor: 'Anthropic' },
  { test: /gemini/i, vendor: 'Google' },
  { test: /glm/i, vendor: '智谱 GLM' },
  { test: /kimi/i, vendor: '月之暗面 Kimi' },
  { test: /minimax/i, vendor: 'MiniMax' },
  { test: /mimo/i, vendor: '小米 MiMo' },
  { test: /^step/i, vendor: '阶跃星辰' },
  { test: /embedding/i, vendor: 'Embedding' }
];

const MODEL_BRANDS = [
  [/^deepseek/i, 'DeepSeek'],
  [/^doubao/i, 'Doubao'],
  [/^qwen/i, 'Qwen'],
  [/^gpt/i, 'GPT'],
  [/^glm/i, 'GLM'],
  [/^kimi/i, 'Kimi'],
  [/^minimax/i, 'MiniMax'],
  [/^mimo/i, 'MiMo'],
  [/^claude/i, 'Claude'],
  [/^gemini/i, 'Gemini'],
  [/^step/i, 'Step']
];

/**
 * Codex 接的是本地代理，代理把 Trae 模型目录里的 deepseek-v4.1-flash 记成了
 * deepseek-v4-flash；本机实际用的是同一个 V4.1 Flash，按同一个模型统计。
 */
const MODEL_ID_ALIASES = new Map([['deepseek-v4-flash', 'deepseek-v4.1-flash']]);

function vendorOf(text) {
  for (const rule of MODEL_VENDOR_RULES) {
    if (rule.test.test(text)) return rule.vendor;
  }
  return '其他';
}

function prettyModelName(id, displayName) {
  const raw = String(displayName || id || '').trim();
  if (!raw) return '';

  // Doubao_1_6 -> Doubao 1.6
  const doubao = /^Doubao[_-](\d+)[_-](\d+)$/i.exec(raw);
  if (doubao) return `Doubao ${doubao[1]}.${doubao[2]}`;

  let name = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  name = name
    .split(' ')
    .map((token) => {
      if (/^[dq]fmodel$/i.test(token)) return token.toLowerCase();
      if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
      if (/^[a-z][a-z]+$/i.test(token)) return token.charAt(0).toUpperCase() + token.slice(1);
      return token;
    })
    .join(' ');
  for (const [test, brand] of MODEL_BRANDS) {
    if (test.test(name)) {
      name = name.replace(test, brand);
      break;
    }
  }
  return name;
}

/** 把 Trae 的会话内模型标识还原成真实模型名 */
function normalizeTraeModelId(value) {
  let id = String(value || '').trim();
  id = id.replace(/^(solo_agent|solo_coder|agent|dev_builder|chat|builder)_\d+_+_?/i, '');
  id = id.replace(/^\d+_-_/, '');
  id = id.replace(/^[-_]+/, '');
  id = id.replace(/_null$/i, '');
  id = id.replace(/[_\s]+$/, '');
  return id.trim();
}

const TRAE_MODEL_ID_RE = /^\d+_-_|^(solo_agent|solo_coder|agent|dev_builder)_\d+_/i;

function collectTraeModelIds(node, used, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  const keys = Array.isArray(node) ? [] : Object.keys(node);
  const values = Array.isArray(node) ? node : Object.values(node);

  for (const key of keys) {
    if (TRAE_MODEL_ID_RE.test(key)) {
      const id = normalizeTraeModelId(key);
      if (id) used.add(id);
    }
  }

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const key = keys[i];
    if (typeof value === 'string') {
      if (/^(model|modelId|modelName|modelKey|selectedModel)$/i.test(key) || TRAE_MODEL_ID_RE.test(value)) {
        const id = normalizeTraeModelId(value);
        if (id) used.add(id);
      }
    } else {
      collectTraeModelIds(value, used, depth + 1);
    }
  }
}

/** 读取 Trae CN 的 SQLite 状态库，拿到会话里实际选过的模型 */
function collectTraeModels() {
  const used = new Set();
  const catalog = new Map();
  const dbFile = path.join(process.env.APPDATA || '', 'Trae CN', 'User', 'globalStorage', 'state.vscdb');
  if (!isFile(dbFile)) return { used, catalog };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { used, catalog };
  }

  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return { used, catalog };
  }

  let rows = [];
  try {
    rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%model%'").all();
  } catch {
    rows = [];
  }

  for (const row of rows) {
    const key = String(row.key || '');
    const value = String(row.value == null ? '' : row.value);
    if (!value) continue;

    if (/model_list_map$/.test(key)) {
      try {
        const parsed = JSON.parse(value);
        for (const list of Object.values(parsed)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (item && item.name && item.display_name) {
              catalog.set(String(item.name).toLowerCase(), String(item.display_name));
            }
          }
        }
      } catch {
        // 目录格式变化时忽略
      }
      continue;
    }

    if (/chatQueryCompletion/i.test(key)) {
      try {
        const parsed = JSON.parse(value);
        const name = parsed && parsed.response && parsed.response.modelName;
        if (name) used.add(String(name));
      } catch {
        // 忽略无法解析的记录
      }
      continue;
    }

    if (!/session_selected_model|recent_user_selection|globalModelMap|modelReasoningEffortLevelMap/i.test(key)) continue;
    try {
      collectTraeModelIds(JSON.parse(value), used);
    } catch {
      // 非 JSON 值忽略
    }
  }

  return { used, catalog };
}

/** Codex：config.toml 与全局状态里的 model 字段 */
function collectCodexModels() {
  const items = [];
  const config = readText(path.join(HOME, '.codex', 'config.toml'), 256 * 1024);
  if (config) {
    const match = /^\s*model\s*=\s*"([^"]{2,64})"/m.exec(config);
    if (match) items.push({ id: match[1], source: 'config.toml' });
  }

  const state = readText(path.join(HOME, '.codex', '.codex-global-state.json'), 4 * 1024 * 1024);
  if (state) {
    for (const match of state.matchAll(/"model"\s*:\s*"([^"]{2,64})"/g)) items.push({ id: match[1], source: '全局状态' });
    for (const match of state.matchAll(/"model=([^"\\\s]{2,64})"/g)) items.push({ id: match[1], source: '全局状态' });
  }
  return items;
}

/** Qoder：CLI 启动参数与运行日志里的 model 字段 */
function collectQoderModels() {
  const items = [];
  const runsDir = path.join(HOME, '.qoder', 'logs', 'runs');
  if (isDir(runsDir)) {
    const dirs = safeReaddir(runsDir)
      .filter((entry) => entry.isDirectory())
      .slice(-80);
    for (const dir of dirs) {
      const manifest = readJsonSafe(path.join(runsDir, dir.name, 'manifest.json'), 256 * 1024);
      if (!manifest.ok) continue;
      const argv = Array.isArray(manifest.data && manifest.data.argv) ? manifest.data.argv : [];
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--model' && argv[i + 1]) items.push({ id: String(argv[i + 1]), source: 'CLI 启动参数' });
      }
    }
  }

  const logsDir = path.join(HOME, '.qoder', 'logs');
  if (isDir(logsDir)) {
    for (const entry of safeReaddir(logsDir)) {
      if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
      const text = readText(path.join(logsDir, entry.name), 2 * 1024 * 1024);
      if (!text) continue;
      for (const match of text.matchAll(/"model"\s*:\s*"([^"]{2,64})"/g)) items.push({ id: match[1], source: '运行日志' });
    }
  }
  return items;
}

/** Claude / 其他平台：会话 JSONL 里的 model 字段（限量扫描，避免拖慢） */
function collectSessionFileModels(root) {
  const items = [];
  if (!isDir(root)) return items;
  const files = [];
  const visit = (dir, depth) => {
    if (depth > 4 || files.length >= 80) return;
    for (const entry of safeReaddir(dir)) {
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), depth + 1);
      } else if (/\.jsonl$/i.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
      if (files.length >= 80) return;
    }
  };
  visit(root, 0);

  for (const file of files) {
    const text = readText(file, 2 * 1024 * 1024);
    if (!text) continue;
    for (const match of text.matchAll(/"model"\s*:\s*"([^"]{2,64})"/g)) items.push({ id: match[1], source: '会话记录' });
  }
  return items;
}

function collectModels(codexSessionModels = []) {
  const entries = [];

  const trae = collectTraeModels();
  for (const id of trae.used) entries.push({ platform: 'trae', id, source: '会话模型选择' });

  const codex = collectCodexModels();
  for (const item of codex) entries.push({ platform: 'codex', id: item.id, source: item.source });
  for (const id of codexSessionModels) entries.push({ platform: 'codex', id, source: '会话记录' });

  const qoder = collectQoderModels();
  for (const item of qoder) entries.push({ platform: 'qoder', id: item.id, source: item.source });

  const claude = collectSessionFileModels(path.join(HOME, '.claude'));
  for (const item of claude) entries.push({ platform: 'claude', id: item.id, source: item.source });

  const merged = new Map();
  for (const entry of entries) {
    const raw = String(entry.id || '').trim();
    const id = MODEL_ID_ALIASES.get(raw.toLowerCase()) || raw;
    if (!id || id.length > 64) continue;
    if (/^(auto|default|unknown|none|<synthetic>)$/i.test(id)) continue;
    const key = id.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, { id, platforms: new Set(), sources: new Set() });
    }
    const target = merged.get(key);
    target.platforms.add(entry.platform);
    if (entry.source) target.sources.add(entry.source);
  }

  return [...merged.values()]
    .map((item) => {
      const display = trae.catalog.get(item.id.toLowerCase());
      const name = prettyModelName(item.id, display);
      return {
        id: item.id,
        name,
        vendor: /^[dq]fmodel$/i.test(item.id) ? 'Qoder 代理' : vendorOf(`${item.id} ${name}`),
        proxy: /^[dq]fmodel$/i.test(item.id),
        kind: /embedding/i.test(item.id) ? 'embedding' : 'chat',
        platforms: [...item.platforms].sort((a, b) => platformRank(a) - platformRank(b)),
        sources: [...item.sources].slice(0, 3)
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'chat' ? -1 : 1;
      return platformRank(a.platforms[0]) - platformRank(b.platforms[0]) || a.name.localeCompare(b.name);
    });
}

/* ------------------------------ 数据汇总 ------------------------------ */

function buildData(force = false) {
  const notes = [];
  const skills = collectSkills(notes);
  const mcpServers = collectMcp(notes);
  const codexScan = scanCodexSessions(force);
  const models = collectModels(codexScan.models);
  const usage = collectUsage(codexScan, force);

  const platformKeys = new Set();
  for (const item of [...skills, ...mcpServers]) platformKeys.add(item.platform);
  // 只有模型记录、没有 Skill/MCP 的平台也要出现在筛选里（例如 Qoder）
  for (const model of models) for (const key of model.platforms || []) platformKeys.add(key);

  const platforms = [...platformKeys]
    .sort((a, b) => platformRank(a) - platformRank(b))
    .map((key) => ({
      key,
      label: (PLATFORM_META[key] || {}).label || key,
      emoji: (PLATFORM_META[key] || {}).emoji || '⚪'
    }));

  return {
    generatedAt: new Date().toISOString(),
    meta: {
      projectDir: PROJECT_DIR,
      home: HOME,
      node: process.version
    },
    platforms,
    models,
    skills,
    mcpServers,
    usage,
    notes
  };
}

/* ------------------------------ HTTP 服务 ------------------------------ */

const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js',
  '/assets/nailoong.png': 'assets/nailoong.png',
  '/assets/nailoong-family.png': 'assets/nailoong-family.png'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function handler(req, res) {
  let pathname = '/';
  let searchParams = new URLSearchParams();
  try {
    const parsed = new URL(req.url, 'http://localhost');
    pathname = parsed.pathname;
    searchParams = parsed.searchParams;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (pathname === '/api/data') {
    try {
      sendJson(res, 200, buildData(searchParams.get('refresh') === '1'));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const fileName = STATIC_FILES[pathname];
  if (!fileName) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  fs.readFile(path.join(DASH_DIR, fileName), (err, buffer) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读取页面文件失败');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fileName)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buffer);
  });
}

function start(port, attempt = 0) {
  const server = http.createServer(handler);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      server.close();
      start(port + 1, attempt + 1);
      return;
    }
    console.error('[奶龙管理台] 启动失败：', err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log('  🐲  奶龙 Agent 管理台已启动');
    console.log(`  访问地址：http://127.0.0.1:${port}`);
    console.log(`  数据接口：http://127.0.0.1:${port}/api/data`);
    console.log(`  项目级扫描目录：${PROJECT_DIR}`);
    console.log('  仅读取本机文件，不会上传任何内容。');
    console.log('');
  });
}

start(START_PORT);
