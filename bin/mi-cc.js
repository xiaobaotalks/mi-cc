#!/usr/bin/env node
/**
 * mi-cc 全局命令入口
 * 
 * 使用方法：
 *   mi-cc                    # 直接启动
 *   mi-cc /help              # 查看帮助
 *   mi-cc -s <session_id>    # 指定会话 ID
 *   mi-cc --mcp              # MCP Server 模式
 *   mi-cc update             # 检查并更新到最新版本
 *   mi-cc update --force     # 强制 HTTP 模式更新（跳过 git，适合网络不佳时）
 *   mi-cc version            # 查看当前版本
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { execSync, spawn } = require('child_process');

// 当前版本（与 package.json 保持同步）
const CURRENT_VERSION = '2.3.0';

// 项目根目录
const PROJECT_ROOT = path.join(__dirname, '..');

// 默认配置
const DEFAULT_CONFIG = {
  BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
  MODEL: 'mimo-v2.5-pro',
  MAX_TOKEN: '8000'
};

// 查找 .env 文件（向上查找）
function findEnvPath(startDir) {
  let envPath = startDir;
  const maxDepth = 5;
  for (let i = 0; i < maxDepth; i++) {
    const testPath = path.join(envPath, '.env');
    if (fs.existsSync(testPath)) {
      return testPath;
    }
    const parent = path.dirname(envPath);
    if (parent === envPath) break;
    envPath = parent;
  }
  return null;
}

// 创建交互式输入接口
function createPrompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// 首次运行配置向导
async function setupWizard() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           mi-cc 首次运行配置向导                               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log('即将进行首次配置，请按 Enter 使用默认设置，或输入自定义值。\n');
  console.log(`默认配置:`);
  console.log(`  API Base URL: ${DEFAULT_CONFIG.BASE_URL}`);
  console.log(`  模型名称: ${DEFAULT_CONFIG.MODEL}`);
  console.log(`  上下文窗口: 启动时自动推断（MiMo = 1M tokens）\n`);

  // 获取 API Key
  const apiKey = await createPrompt('请输入您的 API Key: ');

  if (!apiKey.trim()) {
    console.log('\n[错误] API Key 不能为空，请重新运行 mi-cc 配置。\n');
    process.exit(1);
  }

  // 可选配置
  const baseUrl = await createPrompt(`API Base URL (默认: ${DEFAULT_CONFIG.BASE_URL}): `) || DEFAULT_CONFIG.BASE_URL;
  const model = await createPrompt(`模型名称 (默认: ${DEFAULT_CONFIG.MODEL}): `) || DEFAULT_CONFIG.MODEL;

  // 生成 .env 文件（不写 MAX_TOKEN，启动时自动推断上下文窗口）
  const envContent = `API_KEY=${apiKey.trim()}
BASE_URL=${baseUrl.trim()}
MODEL=${model.trim()}
`;

  const envPath = path.join(process.cwd(), '.env');
  fs.writeFileSync(envPath, envContent, 'utf-8');

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                   配置保存成功！                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`\n配置文件已保存到: ${envPath}`);
  console.log('现在可以重新运行 mi-cc 开始使用。\n');

  process.exit(0);
}

// ==================== update 命令 ====================

// HTTP 下载工具（当 git fetch 失败时使用）
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: options.timeout || 20000, headers: options.headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        httpGet(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 从 GitHub API 获取文件列表
async function getRemoteFileList() {
  const url = 'https://api.github.com/repos/xiaobaotalks/mi-cc/git/trees/main?recursive=1';
  const buf = await httpGet(url, { headers: { 'User-Agent': 'mi-cc-updater' } });
  const tree = JSON.parse(buf.toString('utf-8'));
  return tree.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    .filter(p => !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.endsWith('.lock'));
}

// HTTP 模式更新：直接从 raw.githubusercontent.com 下载所有文件
async function httpUpdate() {
  console.log('\n[HTTP 模式] 从 GitHub 直接下载最新文件...');

  let files;
  try {
    files = await getRemoteFileList();
    console.log(`[HTTP 模式] 共 ${files.length} 个文件需要更新\n`);
  } catch (e) {
    console.log(`[错误] 无法获取文件列表: ${e.message}`);
    console.log('请手动重新克隆: git clone https://github.com/xiaobaotalks/mi-cc.git\n');
    process.exit(1);
  }

  let success = 0;
  let failed = 0;
  for (const file of files) {
    const url = `https://raw.githubusercontent.com/xiaobaotalks/mi-cc/main/${file}`;
    try {
      const content = await httpGet(url, { timeout: 15000 });
      const fullPath = path.join(PROJECT_ROOT, file);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      console.log(`  ✓ ${file}`);
      success++;
    } catch (e) {
      console.log(`  ✗ ${file}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n[HTTP 模式] 完成: ${success} 成功, ${failed} 失败`);
  return failed === 0;
}

function getRemoteVersion() {
  try {
    const output = execSync('git ls-remote --tags origin', {
      cwd: PROJECT_ROOT,
      timeout: 15000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const tags = output.trim().split('\n').filter(l => l.length > 0);
    if (tags.length === 0) return null;
    const versions = tags
      .map(l => l.match(/refs\/tags\/v?([\d.]+)/))
      .filter(m => m)
      .map(m => m[1])
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      });
    return versions[0] || null;
  } catch {
    return null;
  }
}

function getLocalChanges() {
  try {
    const status = execSync('git status --porcelain', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 5000
    });
    return status.trim();
  } catch {
    return '';
  }
}

async function handleUpdate(forceHttp) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║          mi-cc 版本更新                              ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 显示当前版本
  console.log(`当前版本: v${CURRENT_VERSION}`);

  const gitDir = path.join(PROJECT_ROOT, '.git');
  const hasGit = fs.existsSync(gitDir);

  // --force 或无 git 仓库时，直接走 HTTP 模式
  if (forceHttp || !hasGit) {
    if (!hasGit) {
      console.log('[提示] 当前不在 git 仓库中，使用 HTTP 模式更新。');
    } else {
      console.log('[提示] --force 模式，跳过 git 直接 HTTP 下载。');
    }

    const ok = await httpUpdate();
    if (!ok) {
      console.log('\n[警告] 部分文件下载失败，请检查网络后重试。');
    }

    // 更新依赖
    console.log('\n[依赖] 运行 npm install...');
    try {
      execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 120000 });
      console.log('[OK] 依赖更新完成。');
    } catch {
      console.log('[警告] 依赖更新失败，请手动运行 npm install');
    }

    // 读取新版本号
    try {
      const newPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
      console.log(`\n╔══════════════════════════════════════════════════════╗`);
      console.log(`║  ✅ 更新完成！                                        ║`);
      console.log(`║  v${CURRENT_VERSION} → v${newPkg.version}${' '.repeat(Math.max(0, 38 - newPkg.version.length))}║`);
      console.log(`╚══════════════════════════════════════════════════════╝\n`);
    } catch {
      console.log('\n✅ 更新完成！请重新运行 mi-cc\n');
    }
    process.exit(0);
  }

  // ===== git 模式 =====

  // 检查本地修改
  const localChanges = getLocalChanges();
  if (localChanges) {
    console.log('\n[警告] 检测到本地有未提交的修改，更新前将自动暂存。');
    try {
      execSync('git stash', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10000 });
    } catch {
      console.log('[提示] 暂存失败，继续更新可能覆盖本地修改。');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(r => rl.question('是否继续？(y/N) ', a => { rl.close(); r(a); }));
      if (answer.toLowerCase() !== 'y') {
        console.log('已取消更新。');
        process.exit(0);
      }
    }
  }

  // 尝试 git fetch
  console.log('\n[1/3] 拉取最新代码 (git 模式)...');
  let gitSuccess = false;
  try {
    execSync('git fetch origin main', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30000 });
    const localHash = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    const remoteHash = execSync('git rev-parse origin/main', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

    if (localHash === remoteHash) {
      console.log('\n[完成] 已是最新版本，无需更新。');
      if (localChanges) {
        try { execSync('git stash pop', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10000 }); } catch {}
      }
      process.exit(0);
    }

    execSync('git merge origin/main', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 15000 });
    console.log('[OK] 代码更新完成 (git 模式)。');
    gitSuccess = true;
  } catch (e) {
    console.log(`[警告] git 拉取失败: ${e.message.split('\n')[0]}`);
    console.log('[提示] 切换到 HTTP 模式直接下载最新文件...');
  }

  // git 失败时回退到 HTTP 模式
  if (!gitSuccess) {
    const ok = await httpUpdate();
    if (!ok) {
      console.log('\n[错误] HTTP 模式也有部分文件下载失败。');
      if (localChanges) {
        try { execSync('git stash pop', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10000 }); } catch {}
      }
      process.exit(1);
    }
  }

  // 更新依赖
  console.log('\n[2/3] 更新依赖...');
  try {
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 120000 });
    console.log('[OK] 依赖更新完成。');
  } catch {
    console.log('[警告] 依赖更新失败，请手动运行 npm install');
  }

  // 恢复暂存的修改
  if (localChanges) {
    console.log('\n[3/3] 恢复本地修改...');
    try {
      execSync('git stash pop', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10000 });
      console.log('[OK] 本地修改已恢复。');
    } catch {
      console.log('[警告] 恢复本地修改失败，请手动运行 git stash pop');
    }
  }

  // 读取新版本号
  try {
    const newPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  ✅ 更新完成！                                        ║`);
    console.log(`║  v${CURRENT_VERSION} → v${newPkg.version}${' '.repeat(Math.max(0, 38 - newPkg.version.length))}║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
  } catch {
    console.log('\n✅ 更新完成！请重新运行 mi-cc\n');
  }

  process.exit(0);
}

function handleVersion() {
  console.log(`mi-cc v${CURRENT_VERSION}`);
  process.exit(0);
}

// 主程序入口
async function main() {
  const args = process.argv.slice(2);
  
  // 拦截 update 子命令
  if (args[0] === 'update' || args[0] === 'upgrade') {
    const forceHttp = args.includes('--force') || args.includes('-f');
    await handleUpdate(forceHttp);
    return;
  }
  
  // 拦截 version 子命令
  if (args[0] === 'version' || args[0] === '-v' || args[0] === '--version') {
    handleVersion();
    return;
  }
  
  const envPath = findEnvPath(process.cwd());
  
  // 如果没有任何参数且没有找到配置文件，引导配置
  if (!envPath && args.length === 0) {
    await setupWizard();
    return;
  }
  
  // 加载环境变量
  if (envPath) {
    require('dotenv').config({ path: envPath });
    console.log(`[加载配置] ${envPath}`);
  }
  
  // 使用 tsx 运行主程序
  const { spawn } = require('child_process');
  function resolveTsxCliPath() {
    try {
      const pkgPath = require.resolve('tsx/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.bin) {
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
        if (binRel) {
          const abs = path.join(path.dirname(pkgPath), binRel);
          if (fs.existsSync(abs)) return abs;
        }
      }
    } catch {}
    let cur = path.join(__dirname, '..');
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(cur, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  const tsxPath = resolveTsxCliPath();
  if (!tsxPath) {
    console.error('[mi-cc] 找不到 tsx CLI 入口，请先在项目目录执行 npm install');
    process.exit(1);
  }

  const child = spawn(process.execPath, [tsxPath, 'mi-cc.ts', ...args], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env
  });
  
  child.on('exit', (code) => {
    process.exit(code);
  });
}

main();
