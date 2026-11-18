#!/usr/bin/env node
// KC 技能包安裝工具：登入（授權碼）、列出、安裝、更新。
// 這個工具本身不含任何付費內容；內容由伺服器確認權限後才會傳送。
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';

const API = (process.env.KC_SKILLS_API || 'https://ugyjmhgsdkhsnrruykff.supabase.co/functions/v1/skills-api').replace(/\/$/, '');
const HOME = join(homedir(), '.kc-skills');
const CONFIG = join(HOME, 'config.json');
const INSTALLED = join(HOME, 'installed.json');
// 安裝位置：預設是 Claude 的技能資料夾；加 --codex 安裝到 OpenAI Codex、加 --gemini 安裝到 Gemini（Gemini CLI／Antigravity）的技能資料夾
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (FLAGS.includes('--codex') && FLAGS.includes('--gemini')) { console.error('\n❌ 一次只能選一個：--codex 或 --gemini。\n'); process.exit(1); }
const TARGET = FLAGS.includes('--gemini') ? 'gemini' : FLAGS.includes('--codex') ? 'codex' : 'claude';
const TARGET_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }[TARGET];
const TARGET_DIR = { claude: '.claude', codex: '.codex', gemini: '.gemini' }[TARGET];
const SKILLS_DIR = process.env.KC_SKILLS_DIR || join(homedir(), TARGET_DIR, 'skills');
const PENDING = join(HOME, 'pending-login.json');

const say = (m = '') => console.log(m);
// 用丟出錯誤的方式結束，不直接呼叫 process.exit（Windows 上連線還沒關完時強制結束會印出雜訊）
class UserError extends Error {}
const die = (m) => { throw new UserError(m); };
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
const writeJson = async (p, v, mode) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 2), { mode }); };

async function call(path, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die('連不上伺服器，請確認網路後再試一次。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `發生問題（${res.status}）`);
    err.code = data.error; err.status = res.status;
    throw err;
  }
  return data;
}

async function requireLogin() {
  const cfg = await readJson(CONFIG, null);
  if (!cfg?.token) die('還沒登入。請先執行：kc-skills login');
  return cfg.token;
}

async function authed(path, opts = {}) {
  const token = await requireLogin();
  try { return await call(path, { ...opts, token }); }
  catch (e) {
    if (e.status === 401) die('登入已失效或被撤銷。請重新執行：kc-skills login');
    throw e;
  }
}

function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* 開不起來就請會員自己貼網址 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取得確認碼並顯示。回傳 { deviceCode, start }。 */
async function beginLogin() {
  const deviceCode = randomBytes(24).toString('hex');
  const start = await call('start', { method: 'POST', body: { device_code: deviceCode, device_name: hostname() } });
  say('\n請在瀏覽器完成授權。');
  say(`\n   你的確認碼：  ${start.user_code}\n`);
  say('網頁上顯示的確認碼要和這裡一致，才按「授權這台電腦」。');
  say(`如果瀏覽器沒有自動打開，請手動開啟：\n${start.verification_url}\n`);
  openBrowser(start.verification_url);
  return { deviceCode, start };
}

/** 問一次授權結果；已授權就存下憑證並回傳 'approved'，還沒好回傳 'pending'，其他情況直接結束並說明。 */
async function pollOnce(deviceCode) {
  const r = await call('poll', { method: 'POST', body: { device_code: deviceCode } });
  if (r.status === 'approved') {
    await writeJson(CONFIG, { token: r.token, expires_at: r.expires_at }, 0o600);
    await rm(PENDING, { force: true });
    const me = await call('whoami', { token: r.token });
    say(`\n\n✅ 已登入：${me.email}`);
    say('接著可以輸入：kc-skills list');
    return 'approved';
  }
  if (r.status === 'denied') { await rm(PENDING, { force: true }); die('你在網頁上按了「拒絕」。'); }
  if (r.status === 'expired' || r.status === 'used') { await rm(PENDING, { force: true }); die('這次授權已過期，請重新執行 login。'); }
  return 'pending';
}

async function login() {
  // 兩步驟模式（給 Gemini、Codex 這類要等指令結束才顯示畫面的環境）：
  //   login --start   只顯示確認碼與網址，立刻結束
  //   login --finish  確認有沒有授權完成（最多等約 20 秒；還沒好就再執行一次）
  if (FLAGS.includes('--start')) {
    const { deviceCode, start } = await beginLogin();
    await writeJson(PENDING, { device_code: deviceCode, user_code: start.user_code, expires_at: Date.now() + start.expires_in * 1000 }, 0o600);
    say('完成網頁授權後，請執行：kc-skills login --finish\n');
    return;
  }
  if (FLAGS.includes('--finish')) {
    const pend = await readJson(PENDING, null);
    if (!pend?.device_code) die('找不到進行中的登入。請先執行：kc-skills login --start');
    if (Date.now() > pend.expires_at) { await rm(PENDING, { force: true }); die('這次授權已過期，請重新執行：kc-skills login --start'); }
    for (let i = 0; i < 7; i++) {
      if (await pollOnce(pend.device_code) === 'approved') return;
      await sleep(3000);
    }
    say(`\n還在等你在網頁上授權（確認碼 ${pend.user_code}）。授權後請再執行一次：kc-skills login --finish\n`);
    return;
  }
  const { deviceCode, start } = await beginLogin();
  const deadline = Date.now() + start.expires_in * 1000;
  process.stdout.write('等待授權中');
  while (Date.now() < deadline) {
    await sleep(3000);
    process.stdout.write('.');
    if (await pollOnce(deviceCode) === 'approved') return;
  }
  die('等太久了，授權已過期。請重新執行 login。');
}

async function list() {
  const data = await authed('catalog');
  const installed = await readJson(INSTALLED, {});
  say(`\n帳號：${data.email}\n`);
  const tier = { free: '免費體驗', member: '年費會員', advanced: '進階包' };
  for (const p of data.packs) {
    const state = installed[p.id] ? (p.allowed ? `已安裝 v${installed[p.id].version}` : `已安裝 v${installed[p.id].version}（無法更新）`) : p.allowed ? '可安裝' : p.reason === 'MEMBERSHIP_REQUIRED' ? '需要年費會員' : p.reason === 'PURCHASE_REQUIRED' ? '需要購買' : '無法使用';
    say(`  ${p.id.padEnd(14)} ${tier[p.tier].padEnd(6)} ${state.padEnd(14)} ${p.name}`);
  }
  say('\n安裝：kc-skills install 技能包代號\n');
}

/** 路徑安全檢查：只允許寫在技能資料夾底下 */
function safeTarget(rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return null;
  const target = resolve(SKILLS_DIR, rel);
  const root = resolve(SKILLS_DIR) + sep;
  return target.startsWith(root) ? target : null;
}

async function install(pack) {
  if (!pack) die('請指定技能包代號，例如：kc-skills install ig-21');
  say(`\n正在確認權限並取得 ${pack} …`);
  let data;
  try { data = await authed('install', { method: 'POST', body: { pack } }); }
  catch (e) { die(e.message); }

  const topDirs = new Set(data.files.map((f) => f.path.split('/')[0]));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backedUp = 0;
  for (const d of topDirs) {
    const dest = safeTarget(d);
    if (!dest) die(`技能包內容不正確（${d}），已停止安裝。`);
    if (await exists(dest)) {
      const bak = join(HOME, 'backup', stamp, d);
      await mkdir(dirname(bak), { recursive: true });
      await rename(dest, bak);
      backedUp++;
    }
  }
  for (const f of data.files) {
    const target = safeTarget(f.path);
    if (!target) die(`技能包內容不正確（${f.path}），已停止安裝。`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(f.content_base64, 'base64'));
  }
  const installed = await readJson(INSTALLED, {});
  installed[pack] = { version: data.version, installed_at: new Date().toISOString(), skills: [...topDirs], target: TARGET };
  await writeJson(INSTALLED, installed);
  await writeJson(join(HOME, 'licenses', `${pack}.json`), data.license);

  say(`\n✅ 已安裝 ${pack} v${data.version}`);
  say(`   技能：${[...topDirs].join('、')}`);
  say(`   位置：${SKILLS_DIR}`);
  if (backedUp) say(`   （原本同名的 ${backedUp} 個技能已備份到 ${join(HOME, 'backup', stamp)}）`);
  say(`\n請重新開啟 ${TARGET_NAME}，就能使用這些技能。\n`);
}

async function update(pack) {
  const installed = await readJson(INSTALLED, {});
  const targets = pack ? [pack] : Object.keys(installed);
  if (targets.length === 0) { say('\n目前沒有已安裝的技能包。\n'); return; }
  let updated = 0, upToDate = 0, blocked = 0;
  for (const id of targets) {
    let v;
    try { v = await authed('version', { method: 'POST', body: { pack: id } }); }
    catch (e) { say(`  ${id}：${e.message}`); blocked++; continue; }
    if (installed[id]?.version === v.version) { say(`  ${id}：已是最新版 v${v.version}`); upToDate++; continue; }
    say(`  ${id}：v${installed[id]?.version ?? '?'} → v${v.version}`);
    await install(id); updated++;
  }
  if (blocked) say('\n有技能包無法更新（原因見上）。已經安裝在你電腦上的內容仍然可以繼續使用。\n');
  else if (!updated && upToDate) say('\n都已經是最新版。\n');
}

async function logout() {
  await rm(CONFIG, { force: true });
  say('\n已登出（這台電腦上的登入憑證已刪除）。若要讓憑證在伺服器端也失效，請到網站「技能包」頁撤銷這台電腦。\n');
}

async function whoami() {
  const me = await authed('whoami');
  say(`\n${me.email}（${me.role === 'PAID' ? '年費會員' : me.role === 'ADMIN' ? '管理員' : '免費會員'}）\n`);
}

function help() {
  say(`
KC 技能包安裝工具

  kc-skills login            登入（會開啟瀏覽器，核對確認碼後授權）
  kc-skills login --start    登入第一步：只顯示確認碼與網址就結束（給 Gemini、Codex 等用）
  kc-skills login --finish   登入第二步：網頁授權後執行，確認登入完成
  kc-skills list             看有哪些技能包、哪些可以安裝
  kc-skills install <代號>   安裝技能包，例如：kc-skills install ig-21
  kc-skills update [代號]    更新已安裝的技能包（不指定就全部檢查）
  kc-skills whoami           目前登入的帳號
  kc-skills logout           登出這台電腦

預設安裝到 Claude 的技能資料夾（~/.claude/skills）。
如果你用的是 OpenAI Codex，在 install 或 update 後面加上 --codex，會安裝到 ~/.codex/skills。
如果你用的是 Gemini（Gemini CLI、Antigravity），加上 --gemini，會安裝到 ~/.gemini/skills。
例如：kc-skills install ig-21 --gemini
`);
}

const [cmd, arg] = ARGS;
try {
  switch (cmd) {
    case 'login': await login(); break;
    case 'list': await list(); break;
    case 'install': await install(arg); break;
    case 'update': await update(arg); break;
    case 'whoami': await whoami(); break;
    case 'logout': await logout(); break;
    default: help();
  }
} catch (e) {
  console.error(`\n❌ ${e instanceof UserError ? e.message : (e?.message || '發生未預期的問題。')}\n`);
  process.exitCode = 1;
}
