#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = __dirname;
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const js = read('home.js');
const css = read('home.css');
const bridge = read('pdf-bridge.js');
const requiredFiles = ['index.html', 'home.css', 'home.js', 'pdf-embed.css', 'pdf-bridge.js'];
for (const name of requiredFiles) if (!fs.existsSync(path.join(root, name))) throw new Error(`missing ${name}`);

const checks = [
  ['home tab and persistent workbench', /id="tabs"[\s\S]*aria-label="工作区页签"/],
  ['package baseline is 1.0.40', /产品基线 1\.0\.40/],
  ['search bar accepts document queries', /id="global-search-input"[^>]*type="search"/],
  ['home toolbar has no surrounding frame', /data-workspace="home"\] \.workspace-toolbar \{ border-bottom:0; background:transparent; \}/],
  ['AI quick entry', /id="home-prompt"[\s\S]*id="home-send"/],
  ['direct entry opens the smart-reading guide', /data-action="open-smart-study"[\s\S]*体验智能研读[\s\S]*open-smart-study[\s\S]*openDoc\(file\.id, true, 'guide'\)/],
  ['recent list and descending sort', /id="recent-list"[\s\S]*按最近打开时间/],
  ['source selection dialog', /id="source-dialog"[\s\S]*id="confirm-context"/],
  ['markdown editor modes', /id="editor-columns"[\s\S]*data-mode="split"/],
  ['embedded PDF study workspace', /id="pdf-frame"[\s\S]*pdf-study\/workspace\.html/],
  ['local persistence and safe rendering', /localStorage\.setItem[\s\S]*escapeHtml/],
  ['recent ordering implementation', /sort\(\(a,b\) => b\.opened - a\.opened\)/],
  ['responsive design system breakpoint', /@media\(max-width:760px\)/],
  ['PDF bridge message contract', /guanyi-pdf-open[\s\S]*postMessage/]
];
for (const [label, pattern] of checks) if (!pattern.test(`${html}\n${js}\n${css}\n${bridge}`)) throw new Error(`failed: ${label}`);

for (const name of ['home.js', 'pdf-bridge.js']) cp.execFileSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'inherit' });
console.log(`home-study acceptance passed (${checks.length} contract checks)`);
