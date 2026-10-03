#!/usr/bin/env node
/**
 * standalone/smoke.mjs —— 无人值守冒烟验证
 * ============================================================================
 * 复用**官方 Helper 自带的** DSH_PET_SMOKE 自检模式（上游 main.js 里那段）：
 *   起本地服务 → 以冒烟模式拉起 Electron → 等它自己 dump 运行态并截图 → 退出 →
 *   把截图落盘到 standalone/smoke.png，并把 dump 里的关键字段摘出来打印。
 *
 * 它能验证：配置是否加载成功、sprite 是否创建、两路 video 的 src 是否真取到了 webm、
 * 命中区/穿透 round-trip、右键菜单树、运行期补丁是否生效（看 renderer 日志那行）。
 *
 * 用法：node standalone/smoke.mjs [等待毫秒，默认 9000]
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, startServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HELPER_ENTRY = join(HERE, 'electron-main.cjs');
const SMOKE_OUT = join(HERE, 'smoke.png');
const AFTER_MS = String(Number(process.argv[2] || 9000));

const ELECTRON_REL =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

const electron = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(ROOT, 'electron', ELECTRON_REL),
  join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'electron', ELECTRON_REL),
].find((p) => p && existsSync(p));

if (!electron) {
  console.error('[smoke] 找不到 Electron，请先跑 node scripts/ensure-electron.mjs（DSH_HOME 指向 ' + ROOT + '）');
  process.exit(1);
}

const cfg = loadConfig();
const isDesktopVisible = (d) => d === 'desktop' || d === 'both';
const pets = (Array.isArray(cfg?.pets) ? cfg.pets : [])
  .filter((p) => isDesktopVisible(p?.display === undefined ? 'both' : p.display))
  .map((p, i) => ({ id: String(p?.id ?? `pet-${i}`), size: Number(p?.size) > 0 ? Number(p.size) : 462 }));

const server = await startServer({ quiet: false });
const env = {
  ...process.env,
  DSH_PET_CONFIG_URL: server.url + '/config',
  DSH_PET_SCALE: process.env.DSH_PET_SCALE || '1',
  DSH_PET_PETS: JSON.stringify(pets),
  DSH_PET_SMOKE: '1',
  DSH_PET_SMOKE_AFTER_MS: AFTER_MS,
  DSH_PET_SMOKE_OUT: SMOKE_OUT,
};
delete env.DSH_PET_HOST_PID;
delete env.DSH_PET_BRIDGE;
delete env.ELECTRON_RUN_AS_NODE;

console.log('[smoke] electron   = ' + electron);
console.log('[smoke] configUrl  = ' + env.DSH_PET_CONFIG_URL);
console.log('[smoke] 等待 ' + AFTER_MS + ' ms 让页面加载与动画起播…\n');

const child = spawn(electron, [HELPER_ENTRY], { env, windowsHide: true });
let out = '';
child.stdout.on('data', (b) => {
  const s = b.toString();
  out += s;
  process.stdout.write(s);
});
child.stderr.on('data', (b) => {
  const s = b.toString();
  out += s;
  process.stderr.write(s);
});

const code = await new Promise((done) => child.on('exit', (c) => done(c)));
await server.close();

console.log('\n[smoke] electron 退出码 = ' + code);

// ---- 摘取关键结论 ----
const dumpMatch = out.match(/smoke dump:[\s\S]*?=> (\{[\s\S]*?\})\s*\n/);
const roundTrip = out.match(/smoke interactive round-trip: (\{.*\})/);
const patchLine = out.split('\n').find((l) => l.includes('[standalone] 已启用'));
const errLine = out.split('\n').filter((l) => /\[renderer:(error|warning)\]/.test(l)).slice(0, 10);

console.log('\n================ 冒烟结论 ================');
if (patchLine) {
  console.log('运行期补丁  : 已生效');
} else {
  console.log('运行期补丁  : ✗ 未见「已启用」日志（左键点击不会弹余额）');
}
if (dumpMatch) {
  try {
    const d = JSON.parse(dumpMatch[1]);
    const pick = {
      configOk: d.configOk,
      spriteCount: d.sprites,
      viewport: d.viewport,
      dpr: d.dpr,
      errorVisible: d.errorVisible,
      errorText: d.errorText,
      videoSrcA: d.videoSrcA,
      videoSrcB: d.videoSrcB,
      menuMounted: d.menuSmoke && d.menuSmoke.menuMounted,
      menuBranchPanels: d.menuSmoke && d.menuSmoke.panelCount,
      interactiveFlip: d.interactiveFlip,
    };
    for (const [k, v] of Object.entries(pick)) console.log('  ' + k.padEnd(16) + ': ' + JSON.stringify(v));
  } catch (e) {
    console.log('  （dump 解析失败：' + e.message + '）');
  }
} else {
  console.log('  ✗ 没抓到 smoke dump，原始输出见上');
}
if (roundTrip) console.log('  穿透 round-trip : ' + roundTrip[1]);
if (errLine.length) {
  console.log('\n渲染端报错：');
  for (const l of errLine) console.log('  ' + l);
}
console.log('\n截图：' + SMOKE_OUT + (existsSync(SMOKE_OUT) ? '（' + statSync(SMOKE_OUT).size + ' 字节）' : '（未生成）'));
