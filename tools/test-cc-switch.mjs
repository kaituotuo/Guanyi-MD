import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { installCcSwitchHandler, normalizeConnection, normalizeClaudeConnection, parseCodexConnection, readCcSwitchConnection, listCcSwitchConnections } = require('../desktop/cc-switch.cjs');
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'guanyi-cc-switch-'));
const directory = path.join(fixtureRoot, '.cc-switch');
const databasePath = path.join(directory, 'cc-switch.db');
const fakeKey = 'fixture-key-never-real';
const config = `model_provider = "fixture.service"
model = "fixture-model"
[model_providers."fixture.service"]
base_url = "https://fixture.example/v1/" # comment
wire_api = "responses"
experimental_bearer_token = "fixture-provider-token"
[mcp_servers.other.env]
OPENAI_API_KEY = "must-not-use-mcp-key"
base_url = "https://must-not-use-mcp.example"
`;
const settings = { auth: { OPENAI_API_KEY: fakeKey }, config };
const importOptions = { homeDirectory: fixtureRoot };

try {
  assert.throws(() => readCcSwitchConnection(importOptions), /未找到 CC Switch/);
  await mkdir(directory);
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER)');
  const insert = database.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?)');
  insert.run('active', 'codex', 'Fixture provider', JSON.stringify(settings), 1);
  insert.run('claude', 'claude', 'Claude must stay separate', JSON.stringify({ env: {
    ANTHROPIC_AUTH_TOKEN: 'must-not-import-claude', ANTHROPIC_BASE_URL: 'https://claude.example'
  } }), 1);
  database.close();
  const originalBytes = await readFile(databasePath);
  const current = readCcSwitchConnection(importOptions);
  assert.deepEqual(current, {
    baseUrl: 'https://fixture.example/v1', apiKey: 'fixture-provider-token',
    sourceLabel: 'Fixture provider', sourceApp: 'codex', wireApi: 'responses', model: 'fixture-model'
  });
  assert.deepEqual(await readFile(databasePath), originalBytes, 'import must leave the CC Switch database unchanged');

  const mutable = new DatabaseSync(databasePath);
  insertInto(mutable, 'per-device', 'codex', 'Device selected', {
    auth: { OPENAI_API_KEY: fakeKey },
    config: "model_provider = 'other'\nmodel = 'second-model'\n[model_providers.other]\nbase_url = 'http://127.0.0.1:9000/v1'\nwire_api = 'chat'"
  }, 0);
  mutable.close();
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'per-device' }));
  assert.equal(readCcSwitchConnection(importOptions).sourceLabel, 'Device selected', 'machine-specific current provider must take precedence');
  assert.equal(readCcSwitchConnection(importOptions).apiKey, fakeKey, 'auth API key is used when no provider token exists');
  assert.equal(readCcSwitchConnection(importOptions).wireApi, 'chat');

  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'active' }));
  assert.equal(readCcSwitchConnection(importOptions).model, 'fixture-model', 'each read must follow the current provider, without caching the previous selection');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'per-device' }));
  assert.equal(readCcSwitchConnection(importOptions).model, 'second-model', 'switching back must immediately use the newly active provider model');

  for (const currentProviderCodex of ['deleted-provider', '', null]) {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex }));
    assert.throws(() => readCcSwitchConnection(importOptions), /启用/,
      'an explicit deleted or empty provider selection must never fall back to a different database credential');
  }
  await writeFile(path.join(directory, 'settings.json'), '{invalid-json');
  assert.throws(() => readCcSwitchConnection(importOptions), /无法确定/,
    'damaged settings must not import an arbitrary active database provider');
  assert.throws(() => listCcSwitchConnections(importOptions), /无法确定/,
    'listing must not fall back when the current selection file is damaged');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ language: 'zh' }));
  assert.equal(readCcSwitchConnection(importOptions).sourceLabel, 'Fixture provider', 'only legacy settings without an explicit selection may use the unique active database provider');

  for (const invalidUrl of [
    'file:///tmp/key', 'https://user:password@fixture.example/v1',
    'https://fixture.example/v1?key=must-not-appear', 'https://fixture.example/v1#key'
  ]) {
    assert.throws(() => normalizeConnection(JSON.stringify({ auth: { OPENAI_API_KEY: fakeKey },
      config: `model_provider = "x"\n[model_providers.x]\nbase_url = ${JSON.stringify(invalidUrl)}`
    }), 'fixture'), (error) => {
      assert.doesNotMatch(error.message, /must-not-appear|password|fixture-key/);
      return /服务地址/.test(error.message);
    });
  }
  const ambiguous = new DatabaseSync(databasePath);
  ambiguous.prepare("UPDATE providers SET is_current = 1 WHERE id = 'per-device'").run();
  ambiguous.close();
  assert.throws(() => readCcSwitchConnection(importOptions), /启用一个供应商/,
    'multiple active database providers must not silently choose a credential');

  const multipleApps = new DatabaseSync(databasePath);
  insertInto(multipleApps, 'claude-ready', 'claude', 'Active Claude fixture', { env: {
    ANTHROPIC_AUTH_TOKEN: 'fixture-claude-bearer', ANTHROPIC_BASE_URL: 'https://claude-fixture.example',
    ANTHROPIC_MODEL: 'claude-explicit-model'
  } }, 0);
  multipleApps.close();
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'active', currentProviderClaude: 'claude-ready' }));
  assert.equal(readCcSwitchConnection(importOptions).sourceApp, 'codex', 'when both apps have valid current providers, use one deterministic current provider');
  const both = listCcSwitchConnections(importOptions);
  assert.deepEqual(both.connections, [
    { sourceApp: 'codex', sourceLabel: 'Fixture provider', baseUrl: 'https://fixture.example/v1', wireApi: 'responses', authType: 'bearer', model: 'fixture-model' },
    { sourceApp: 'claude', sourceLabel: 'Active Claude fixture', baseUrl: 'https://claude-fixture.example', wireApi: 'anthropic', authType: 'bearer', model: 'claude-explicit-model' }
  ], 'listing keeps the two active sources separate without reading inactive providers');
  assert.deepEqual(both.unavailable, []);
  assert.doesNotMatch(JSON.stringify(both), /apiKey|managedToken|fixture-provider-token|fixture-claude-bearer|fixture-key-never-real|second-model/);
  assert.equal(readCcSwitchConnection({ ...importOptions, sourceApp: 'claude' }).apiKey, 'fixture-claude-bearer');
  assert.equal(readCcSwitchConnection({ ...importOptions, sourceApp: 'codex' }).apiKey, 'fixture-provider-token');
  for (const sourceApp of ['gemini', '', null, {}, ['codex']]) {
    assert.throws(() => readCcSwitchConnection({ ...importOptions, sourceApp }), /来源无效/, 'invalid explicit source never falls back');
  }
  const noCodexModel = new DatabaseSync(databasePath);
  noCodexModel.prepare('UPDATE providers SET settings_config = ? WHERE id = ?').run(JSON.stringify({
    ...settings, config: config.replace('model = "fixture-model"', 'model = ""')
  }), 'active');
  noCodexModel.close();
  assert.equal(readCcSwitchConnection(importOptions).sourceApp, 'claude', 'a selected Codex without a model may use the selected Claude with an explicit model');
  assert.throws(() => readCcSwitchConnection({ ...importOptions, sourceApp: 'codex' }), /未指定有效模型/,
    'an explicit unavailable source must not fall back to the other application');
  const partial = listCcSwitchConnections(importOptions);
  assert.deepEqual(partial.connections.map(item => item.sourceApp), ['claude']);
  assert.equal(partial.unavailable[0].sourceApp, 'codex');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderClaude: 'claude-ready' }));
  assert.equal(readCcSwitchConnection(importOptions).sourceApp, 'claude', 'ambiguous legacy Codex activity may use an unambiguous selected Claude');
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'deleted-provider', currentProviderClaude: 'claude-ready' }));
  const claude = readCcSwitchConnection(importOptions);
  assert.deepEqual(claude, {
    baseUrl: 'https://claude-fixture.example', apiKey: 'fixture-claude-bearer',
    sourceLabel: 'Active Claude fixture', sourceApp: 'claude', wireApi: 'anthropic',
    authType: 'bearer', model: 'claude-explicit-model'
  }, 'an unavailable selected Codex may use the selected valid Claude, but must never substitute an inactive Codex');

  const switched = new DatabaseSync(databasePath);
  switched.prepare('UPDATE providers SET settings_config = ? WHERE id = ?').run(JSON.stringify({ env: {
    ANTHROPIC_API_KEY: 'fixture-claude-updated-key', ANTHROPIC_BASE_URL: 'https://updated-claude.example/v1',
    ANTHROPIC_MODEL: 'claude-updated-model'
  } }), 'claude-ready');
  switched.close();
  const changed = readCcSwitchConnection(importOptions);
  assert.equal(changed.model, 'claude-updated-model');
  assert.equal(changed.baseUrl, 'https://updated-claude.example/v1');
  assert.equal(changed.apiKey, 'fixture-claude-updated-key');
  assert.equal(changed.authType, 'api-key', 'a fresh read must include the newly active URL, key, model and auth type');
  const changedMetadata = listCcSwitchConnections(importOptions).connections[0];
  assert.equal(changedMetadata.baseUrl, changed.baseUrl);
  assert.equal(changedMetadata.model, changed.model);
  assert.equal(changedMetadata.authType, 'api-key');
  assert.equal(Object.hasOwn(changedMetadata, 'apiKey'), false);

  // Claude's active provider can omit model while its matching live CLI
  // settings retain an explicit choice. All files here are isolated fixtures.
  const liveDirectory = path.join(fixtureRoot, '.claude');
  await mkdir(liveDirectory);
  const livePath = path.join(liveDirectory, 'settings.json');
  const cliPath = path.join(fixtureRoot, 'claude-fixture');
  const catalog = 'aliases:{opus:{default:"claude-opus-5-5",per_provider:{gateway:"claude-opus-4-7"}},sonnet:{default:"claude-sonnet-5-5"},haiku:{default:"claude-haiku-5-5"}},defaults:{},best:"opus"';
  await writeFile(cliPath, 'x'.repeat(256 * 1024 - 8) + catalog);
  const modelOptions = { ...importOptions, sourceApp: 'claude', claudeExecutablePath: cliPath };
  const relayEnv = { ANTHROPIC_API_KEY: 'fixture-live-model-key', ANTHROPIC_BASE_URL: 'https://live-model-relay.example/v1' };
  const setClaude = config => {
    const db = new DatabaseSync(databasePath);
    db.prepare('UPDATE providers SET settings_config = ? WHERE id = ?').run(JSON.stringify(config), 'claude-ready');
    db.close();
  };
  setClaude({ env: relayEnv });
  await writeFile(livePath, JSON.stringify({ env: relayEnv, model: 'opus' }));
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-opus-5-5', 'matching live alias resolves from installed CLI catalog across read boundaries');
  assert.equal(readCcSwitchConnection(modelOptions).apiKey, relayEnv.ANTHROPIC_API_KEY, 'only the selected provider supplies credentials');
  assert.equal(listCcSwitchConnections(modelOptions).connections[0].model, 'claude-opus-5-5');
  const beforeLive = await readFile(livePath);
  readCcSwitchConnection(modelOptions);
  assert.deepEqual(await readFile(livePath), beforeLive, 'reading a model fallback never rewrites Claude settings');
  for (const wrongEnv of [
    { ...relayEnv, ANTHROPIC_API_KEY: 'another-provider-key' },
    { ...relayEnv, ANTHROPIC_BASE_URL: 'https://another-provider.example' },
    { ANTHROPIC_AUTH_TOKEN: relayEnv.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: relayEnv.ANTHROPIC_BASE_URL }
  ]) {
    await writeFile(livePath, JSON.stringify({ env: wrongEnv, model: 'opus' }));
    assert.throws(() => readCcSwitchConnection(modelOptions), /未指定有效模型/, 'live URL, credential and auth type must all match');
  }
  await writeFile(livePath, JSON.stringify({ env: { ...relayEnv, ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-explicit' }, model: 'opus' }));
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-opus-explicit', 'matching live explicit alias pin precedes CLI catalog');
  setClaude({ env: { ...relayEnv, ANTHROPIC_MODEL: 'claude-provider-explicit' } });
  await writeFile(livePath, '{invalid-json');
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-provider-explicit', 'an explicit provider model does not depend on live configuration');
  setClaude({ model: 'opus', env: { ...relayEnv, ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-provider-pinned' } });
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-provider-pinned', 'provider alias pins also work without a readable live file');
  setClaude({ env: relayEnv });
  for (const invalid of ['{invalid-json', 'x'.repeat(1024 * 1024 + 1)]) {
    await writeFile(livePath, invalid);
    assert.throws(() => readCcSwitchConnection(modelOptions), error => {
      assert.doesNotMatch(error.message, /fixture-live-model-key|guanyi-cc-switch/);
      return /当前模型设置无法读取/.test(error.message);
    });
  }
  await writeFile(livePath, JSON.stringify({ env: relayEnv, model: 'opus' }));
  assert.throws(() => readCcSwitchConnection({ ...modelOptions, claudeExecutablePath: path.join(fixtureRoot, 'missing-cli') }), /无法解析 Claude 模型别名/,
    'an unavailable catalog requires a full model ID rather than a guessed latest model');
  await writeFile(cliPath, catalog.replace('claude-opus-5-5', 'claude-opus-5-6') + ' ');
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-opus-5-6', 'CLI changes invalidate the bounded alias cache');

  const common = new DatabaseSync(databasePath);
  common.exec("ALTER TABLE providers ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  common.prepare('UPDATE providers SET meta = ? WHERE id = ?').run(JSON.stringify({ commonConfigEnabled: true }), 'claude-ready');
  common.prepare('INSERT INTO settings VALUES (?, ?)').run('common_config_claude', JSON.stringify({ model: 'claude-common-explicit' }));
  common.close();
  await writeFile(livePath, '{invalid-json');
  assert.equal(readCcSwitchConnection(modelOptions).model, 'claude-common-explicit', 'enabled common configuration supplies an explicit model before live fallback');
  const disabledCommon = new DatabaseSync(databasePath);
  disabledCommon.prepare('UPDATE providers SET meta = ? WHERE id = ?').run(JSON.stringify({ commonConfigEnabled: false }), 'claude-ready');
  disabledCommon.close();
  assert.throws(() => readCcSwitchConnection(modelOptions), /当前模型设置无法读取/, 'disabled common settings do not silently supply a model');
  await rm(livePath);

  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'deleted-provider', currentProviderClaude: 'deleted-claude' }));
  assert.throws(() => readCcSwitchConnection(importOptions), /未找到可直接使用/,
    'explicit missing selections in both apps must not import any other configured provider');
  const noActive = new DatabaseSync(databasePath);
  noActive.prepare('UPDATE providers SET is_current = 0').run();
  noActive.close();
  await writeFile(path.join(directory, 'settings.json'), '{}');
  assert.throws(() => readCcSwitchConnection(importOptions), /启用一个供应商/,
    'merely having multiple configured providers never makes one active');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

assert.equal(normalizeConnection(JSON.stringify({ config }), 'fixture').apiKey, 'fixture-provider-token');
assert.throws(() => normalizeConnection(JSON.stringify({
  config: 'model_provider = "x"\n[model_providers.x]\nbase_url = "https://fixture.example/v1"'
}), 'fixture'), /API Key/);
assert.throws(() => normalizeConnection(JSON.stringify({ auth: { OPENAI_API_KEY: 'bad\nkey' },
  config: 'model_provider = "x"\n[model_providers.x]\nbase_url = "https://fixture.example/v1"'
}), 'fixture'), /API Key/);
assert.throws(() => normalizeConnection(JSON.stringify({ auth: { OPENAI_API_KEY: fakeKey },
  config: 'model_provider = "x"\n[model_providers.x]\nbase_url = "https://fixture.example/v1"'
}), 'fixture'), /未指定有效模型/);
assert.throws(() => parseCodexConnection('model_provider = "openai"\nmodel = "fixture"'), /官方登录/);
assert.throws(() => parseCodexConnection('model_provider = "x"\n[model_providers.x]\nbase_url = "https://fixture.example"\nwire_api = "anthropic"'), /接口类型/);
assert.throws(() => parseCodexConnection(`model_provider = "x"\n[model_providers.x]\nbase_url = "bad-secret\\q"`), (error) => {
  assert.doesNotMatch(error.message, /bad-secret/);
  return /格式/.test(error.message);
});
assert.equal(normalizeClaudeConnection(JSON.stringify({ model: 'settings-model', env: {
  ANTHROPIC_API_KEY: 'fixture-api-key', ANTHROPIC_BASE_URL: 'https://claude-fixture.example',
  ANTHROPIC_MODEL: 'env-selected-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'default-sonnet-model'
} }), 'fixture').model, 'env-selected-model');
assert.equal(normalizeClaudeConnection(JSON.stringify({ model: 'settings-model', env: {
  ANTHROPIC_API_KEY: 'fixture-api-key', ANTHROPIC_BASE_URL: 'https://claude-fixture.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'default-sonnet-model'
} }), 'fixture').model, 'settings-model');
assert.equal(normalizeClaudeConnection(JSON.stringify({ env: {
  ANTHROPIC_API_KEY: 'fixture-api-key', ANTHROPIC_BASE_URL: 'https://claude-fixture.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'default-sonnet-model'
} }), 'fixture').model, 'default-sonnet-model');
assert.throws(() => normalizeClaudeConnection(JSON.stringify({ env: {
  ANTHROPIC_API_KEY: 'fixture-api-key', ANTHROPIC_BASE_URL: 'https://claude-fixture.example'
} }), 'fixture'), /未指定有效模型/, 'Claude must have an explicit model rather than a guessed CLI default');

let handler;
let trusted = false;
installCcSwitchHandler({ handle: (channel, callback) => {
  assert.equal(channel, 'guanyi-ai:import-cc-switch');
  handler = callback;
} }, () => { trusted = true; throw new Error('untrusted renderer'); });
assert.throws(() => handler({}), /untrusted renderer/);
assert.equal(trusted, true, 'the caller must be validated before any credential-store read');

const [main, preload] = await Promise.all([
  readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8')
]);
assert.ok(main.includes('installCcSwitchHandler(ipcMain, trustedRenderer)'));
assert.ok(preload.includes("importCcSwitch: (options = {}) => ipcRenderer.invoke('guanyi-ai:import-cc-switch', options)"));
console.log('CC Switch import: current Codex/Claude selection, immediate switching, explicit model, protocols, read-only storage and trusted IPC passed');

function insertInto(database, id, appType, name, value, isCurrent) {
  database.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?)').run(id, appType, name, JSON.stringify(value), isCurrent);
}
