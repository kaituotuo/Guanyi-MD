const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_SIZE = 1024 * 1024;
const MAX_KEY_SIZE = 16 * 1024;
const CLAUDE_MODEL_FIELDS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
const claudeCatalogCache = new Map();

function readBoundedJson(file, message) {
  try {
    if (fs.statSync(file).size > MAX_CONFIG_SIZE) throw new Error('too large');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw configError(message);
  }
}

// Native Claude Code bundles a model catalog. Read its literal alias defaults,
// never evaluate code and never substitute a guessed newest model version.
function installedClaudeAliases(options) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const candidates = options.claudeExecutablePath ? [options.claudeExecutablePath] : [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')),
    path.join(homeDirectory, '.local', 'bin', 'claude'),
    path.join(homeDirectory, '.npm-global', 'bin', 'claude'),
    path.join(homeDirectory, '.claude', 'local', 'claude')
  ];
  for (const candidate of [...new Set(candidates)]) {
    let fd;
    try {
      const file = fs.realpathSync(candidate), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024) continue;
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const cached = claudeCatalogCache.get(file);
      if (cached?.stamp === stamp) return cached.aliases;
      fd = fs.openSync(file, 'r');
      const chunk = Buffer.alloc(256 * 1024), aliases = new Map();
      let tail = '', bytes;
      while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        const text = tail + chunk.subarray(0, bytes).toString('latin1');
        // The marker + bounded body distinguishes the catalog from CLI help or
        // unrelated settings. Carry a small overlap for a marker at a boundary.
        const catalogs = text.matchAll(/aliases:\{([\s\S]{1,16384}?)\},defaults:\{/g);
        for (const match of catalogs) {
          for (const entry of match[1].matchAll(/\b(opus|sonnet|haiku):\{default:"(claude-[a-z0-9._-]+)"(?:,per_provider:\{[^{}]*\})?\}/g)) {
            if (entry[2].startsWith(`claude-${entry[1]}-`)) aliases.set(entry[1], entry[2]);
          }
        }
        if (aliases.size === 3) break;
        tail = text.slice(-32768);
      }
      if (aliases.size) {
        if (claudeCatalogCache.size > 8) claudeCatalogCache.clear();
        claudeCatalogCache.set(file, { stamp, aliases });
        return aliases;
      }
    } catch (_) { /* Unsupported/missing CLI installations require an explicit model. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return new Map();
}

function claudeModelSettings(settingsConfig, options, row, database) {
  let settings;
  try { settings = JSON.parse(settingsConfig); }
  catch (_) { throw configError('CC Switch 当前 Claude 的配置无法读取'); }
  const env = { ...(settings?.env || {}) };
  let model = env.ANTHROPIC_MODEL || settings?.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const alias = value => /^(opus|sonnet|haiku)$/i.test(String(value || '').trim());
  const needsSupplement = () => !model || (alias(model) && !env[`ANTHROPIC_DEFAULT_${model.trim().toUpperCase()}_MODEL`]);
  const mergeModelFields = fallback => {
    for (const key of CLAUDE_MODEL_FIELDS) if (!env[key] && fallback?.env?.[key]) env[key] = fallback.env[key];
    if (!model) model = fallback?.env?.ANTHROPIC_MODEL || fallback?.model || fallback?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL;
    for (const [key, value] of Object.entries(fallback?.env || {})) if (/^CLAUDE_CODE_USE_/.test(key) && !env[key]) env[key] = value;
  };
  let commonEnabled = false;
  // Older CC databases/fixtures lack meta or the settings table entirely.
  const columns = database.prepare('PRAGMA table_info(providers)').all();
  if (needsSupplement() && columns.some(column => column.name === 'meta')) {
    const metaRow = database.prepare('SELECT meta FROM providers WHERE app_type = ? AND id = ?').get('claude', row.id);
    try { commonEnabled = JSON.parse(metaRow?.meta || '{}')?.commonConfigEnabled === true; }
    catch (_) { throw configError('CC Switch 当前 Claude 的公共配置设置无法读取'); }
  }
  if (commonEnabled && database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) {
    const commonRow = database.prepare('SELECT value FROM settings WHERE key = ?').get('common_config_claude');
    if (commonRow?.value) {
      try {
        if (Buffer.byteLength(commonRow.value) > MAX_CONFIG_SIZE) throw new Error('too large');
        mergeModelFields(JSON.parse(commonRow.value));
      } catch (_) { throw configError('CC Switch 的 Claude 公共模型配置无法读取'); }
    }
  }
  if (needsSupplement()) {
    const live = readBoundedJson(path.join(options.homeDirectory || os.homedir(), '.claude', 'settings.json'), 'Claude 当前模型设置无法读取，请在 CC Switch 中指定完整模型标识');
    if (live) {
      // Compare independently normalized connections including auth type. Never
      // take a model/default from another provider, even if its URL is the same.
      let matches = false;
      try {
        const selected = normalizeClaudeConnection(JSON.stringify({ ...settings, model: 'connection-check', env: { ...env, ANTHROPIC_MODEL: 'connection-check' } }), 'Claude');
        const active = normalizeClaudeConnection(JSON.stringify({ ...live, model: 'connection-check', env: { ...live.env, ANTHROPIC_MODEL: 'connection-check' } }), 'Claude');
        matches = selected.baseUrl === active.baseUrl && selected.apiKey === active.apiKey && selected.authType === active.authType;
      } catch (_) { /* A partial or unrelated live connection supplies no fallback. */ }
      if (matches) mergeModelFields(live);
    }
  }
  if (alias(model)) {
    const family = model.trim().toLowerCase(), pinned = env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`];
    if (pinned && !alias(pinned)) model = pinned;
    else {
      if (Object.entries(env).some(([key, value]) => /^CLAUDE_CODE_USE_/.test(key) && value && value !== '0' && value !== 'false')) {
        throw configError('Claude 云服务别名需配置完整模型标识，请在 CC Switch 中设置模型');
      }
      model = installedClaudeAliases(options).get(family);
      if (!model) throw configError('无法解析 Claude 模型别名，请在 CC Switch 中设置完整模型标识或 ANTHROPIC_DEFAULT_' + family.toUpperCase() + '_MODEL');
    }
  }
  return JSON.stringify({ ...settings, model, env: { ...env, ...(model ? { ANTHROPIC_MODEL: model } : {}) } });
}

function configError(message) {
  const error = new Error(message);
  error.code = 'CC_SWITCH_CONFIG_ERROR';
  return error;
}

// Read only the scalar fields needed for the selected Codex provider. Unrelated
// TOML sections (MCP commands, paths and environment variables) never leave here.
function tomlString(value) {
  const source = String(value || '').trim();
  const literal = source.match(/^'([^'\r\n]*)'\s*(?:#.*)?$/);
  if (literal) return literal[1];
  const quoted = source.match(/^("(?:[^"\\\r\n]|\\.)*")\s*(?:#.*)?$/);
  if (!quoted) throw configError('CC Switch 的 Codex 连接配置格式暂不支持');
  try {
    return JSON.parse(quoted[1].replace(/\\U([0-9a-fA-F]{8})/g, (_match, digits) => {
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) throw new Error('invalid code point');
      return String.fromCodePoint(point);
    }));
  } catch (_error) { throw configError('CC Switch 的 Codex 连接配置格式暂不支持'); }
}

function tomlSection(value) {
  const parts = [];
  let remaining = value.trim();
  while (remaining) {
    const token = remaining.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/);
    if (!token) return null;
    parts.push(/^["']/.test(token[1]) ? tomlString(token[1]) : token[1]);
    remaining = remaining.slice(token[0].length).trim();
    if (token[2] === '.' && !remaining) return null;
  }
  return parts;
}

function parseCodexConnection(config) {
  if (typeof config !== 'string' || Buffer.byteLength(config, 'utf8') > MAX_CONFIG_SIZE) {
    throw configError('CC Switch 的 Codex 配置无效或过大');
  }
  const root = Object.create(null);
  const providers = new Map();
  let section = [];
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = line.match(/^\[([^\r\n]+)\]\s*(?:#.*)?$/);
      section = header ? tomlSection(header[1]) : null;
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment || !section) continue;
    const [, key, value] = assignment;
    if (!section.length && ['model_provider', 'model'].includes(key)) {
      root[key] = tomlString(value);
    } else if (section.length === 2 && section[0] === 'model_providers'
      && ['base_url', 'wire_api', 'experimental_bearer_token', 'env_key'].includes(key)) {
      if (!providers.has(section[1])) providers.set(section[1], Object.create(null));
      providers.get(section[1])[key] = tomlString(value);
    }
  }
  const provider = providers.get(root.model_provider);
  if (!provider?.base_url) {
    throw configError('CC Switch 当前 Codex 使用官方登录或未设置服务地址，请先启用使用 API Key 的供应商');
  }
  const wireApi = provider.wire_api || 'responses';
  if (!['responses', 'chat'].includes(wireApi)) {
    throw configError('CC Switch 当前 Codex 的接口类型暂不支持');
  }
  return { ...provider, wireApi, model: root.model || '' };
}

function normalizeConnection(settingsConfig, sourceLabel) {
  let settings;
  try { settings = JSON.parse(settingsConfig); }
  catch (_error) { throw configError('CC Switch 当前 Codex 的配置无法读取'); }
  const provider = parseCodexConnection(settings?.config);
  // Codex uses a provider-specific bearer token before an auth.json API key.
  const apiKey = provider.experimental_bearer_token || settings?.auth?.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > MAX_KEY_SIZE || /[\r\n]/.test(apiKey)) {
    throw configError('CC Switch 当前 Codex 未配置可用的 API Key');
  }
  let baseUrl;
  try { baseUrl = new URL(provider.base_url); }
  catch (_error) { throw configError('CC Switch 当前 Codex 的服务地址格式不正确'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password
    || baseUrl.search || baseUrl.hash || baseUrl.href.length > 2048) {
    throw configError('CC Switch 当前 Codex 的服务地址需要是不含账号或查询参数的 HTTP 或 HTTPS 地址');
  }
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) {
    throw configError('CC Switch 当前启用的 Codex 配置未指定有效模型，请先在 CC Switch 中设置模型');
  }
  return {
    baseUrl: baseUrl.href.replace(/\/+$/, ''),
    apiKey: apiKey.trim(),
    sourceLabel: typeof sourceLabel === 'string' ? sourceLabel.slice(0, 160) : 'Codex',
    sourceApp: 'codex',
    wireApi: provider.wireApi,
    model
  };
}

function normalizeClaudeConnection(settingsConfig, sourceLabel) {
  let settings;
  try { settings = JSON.parse(settingsConfig); }
  catch (_error) { throw configError('CC Switch 当前 Claude 的配置无法读取'); }
  const env = settings?.env || {};
  const bearerToken = env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = bearerToken || env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > MAX_KEY_SIZE || /[\r\n]/.test(apiKey)) {
    throw configError('CC Switch 当前 Claude 未配置可用的 API Key');
  }
  let baseUrl;
  try { baseUrl = new URL(env.ANTHROPIC_BASE_URL); }
  catch (_error) { throw configError('CC Switch 当前 Claude 未设置有效服务地址'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password
    || baseUrl.search || baseUrl.hash || baseUrl.href.length > 2048) {
    throw configError('CC Switch 当前 Claude 的服务地址需要是不含账号或查询参数的 HTTP 或 HTTPS 地址');
  }
  const configuredModel = env.ANTHROPIC_MODEL || settings?.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const model = typeof configuredModel === 'string' ? configuredModel.trim() : '';
  if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) {
    throw configError('CC Switch 当前启用的 Claude 配置未指定有效模型，请先在 CC Switch 中设置模型');
  }
  return {
    baseUrl: baseUrl.href.replace(/\/+$/, ''),
    apiKey: apiKey.trim(),
    sourceLabel: typeof sourceLabel === 'string' ? sourceLabel.slice(0, 160) : 'Claude',
    sourceApp: 'claude',
    wireApi: 'anthropic',
    authType: bearerToken ? 'bearer' : 'api-key',
    model
  };
}

function currentProviderRows(database, settings, appType) {
  const field = appType === 'codex' ? 'currentProviderCodex' : 'currentProviderClaude';
  const label = appType === 'codex' ? 'Codex' : 'Claude';
  if (settings && Object.hasOwn(settings, field)) {
    const id = settings[field];
    if (typeof id !== 'string' || !id.trim()) {
      throw configError(`CC Switch 当前未启用 ${label} 供应商，请先启用后再同步连接`);
    }
    const rows = database.prepare('SELECT id, name, settings_config FROM providers WHERE app_type = ? AND id = ? LIMIT 2').all(appType, id);
    if (rows.length !== 1) throw configError(`CC Switch 当前 ${label} 配置不存在或有歧义，请重新启用供应商`);
    return rows;
  }
  const rows = database.prepare('SELECT id, name, settings_config FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 2').all(appType);
  if (rows.length !== 1) throw configError(`请先在 CC Switch 的 ${label} 页启用一个供应商，再同步连接`);
  return rows;
}

function readCcSwitchConnections(options = {}, listOnly = false) {
  if (options.sourceApp !== undefined && !['codex', 'claude'].includes(options.sourceApp)) {
    throw configError('CC Switch 来源无效，请选择 Codex 或 Claude');
  }
  const homeDirectory = options.homeDirectory || os.homedir();
  const directory = path.join(homeDirectory, '.cc-switch');
  const databasePath = path.join(directory, 'cc-switch.db');
  if (!fs.existsSync(databasePath)) throw configError('未找到 CC Switch 配置，请先安装并在 Codex 或 Claude 中启用供应商');
  let settings = null;
  try {
    const settingsPath = path.join(directory, 'settings.json');
    if (fs.statSync(settingsPath).size > MAX_CONFIG_SIZE) {
      throw configError('CC Switch 的当前供应商设置过大，请在 CC Switch 中重新启用供应商');
    }
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw configError('无法确定 CC Switch 当前启用的配置，请在 CC Switch 中重新启用供应商');
    }
  } catch (error) {
    if (error?.code === 'CC_SWITCH_CONFIG_ERROR') throw error;
    // Only a missing legacy settings file permits SQLite fallback. A damaged or
    // unreadable settings file must not silently select a different credential.
    if (error?.code !== 'ENOENT') {
      throw configError('无法确定 CC Switch 当前启用的配置，请在 CC Switch 中重新启用供应商后重试');
    }
  }

  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const failures = [], connections = [], unavailable = [];
    const appTypes = options.sourceApp ? [options.sourceApp] : ['codex', 'claude'];
    for (const appType of appTypes) {
      try {
        const [row] = currentProviderRows(database, settings, appType);
        if (typeof row.settings_config !== 'string' || Buffer.byteLength(row.settings_config, 'utf8') > MAX_CONFIG_SIZE) {
          throw configError('CC Switch 当前配置无效或过大');
        }
        const connection = appType === 'codex'
          ? normalizeConnection(row.settings_config, row.name)
          : normalizeClaudeConnection(claudeModelSettings(row.settings_config, options, row, database), row.name);
        if (!listOnly) return connection;
        // Explicit allowlist: listing must never expose API keys, auth blobs,
        // local paths, or a token that can make a model request.
        connections.push({
          sourceApp: connection.sourceApp, sourceLabel: connection.sourceLabel,
          baseUrl: connection.baseUrl, wireApi: connection.wireApi,
          authType: connection.authType || 'bearer', model: connection.model
        });
      } catch (error) {
        const message = error?.code === 'CC_SWITCH_CONFIG_ERROR'
          ? error.message : '暂时无法读取当前配置，请重新启用供应商后重试';
        failures.push(message); unavailable.push({ sourceApp: appType, message });
      }
    }
    if (listOnly) return { connections, unavailable };
    throw configError(`未找到可直接使用的 CC Switch 当前配置。${failures.join('；')}`);
  } catch (error) {
    if (error?.code === 'CC_SWITCH_CONFIG_ERROR') throw error;
    // Database/JSON errors can contain paths or source text. Return a fixed
    // diagnostic instead of forwarding anything from a credential store.
    throw configError('暂时无法读取 CC Switch 配置，请确认已在 Codex 或 Claude 中启用供应商后重试');
  } finally { database?.close(); }
}

function readCcSwitchConnection(options = {}) {
  return readCcSwitchConnections(options);
}

function listCcSwitchConnections(options = {}) {
  return readCcSwitchConnections(options, true);
}

function installCcSwitchHandler(ipcMain, trustedRenderer) {
  ipcMain.handle('guanyi-ai:import-cc-switch', (event, request = {}) => {
    trustedRenderer(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || (request.action !== undefined && request.action !== 'list')) {
      throw configError('CC Switch 连接请求无效');
    }
    // Renderer callers cannot override the credential-store directory.
    const options = { sourceApp: request.sourceApp };
    return request.action === 'list' ? listCcSwitchConnections(options) : readCcSwitchConnection(options);
  });
}

module.exports = { installCcSwitchHandler, normalizeConnection, normalizeClaudeConnection, parseCodexConnection, readCcSwitchConnection, listCcSwitchConnections };
