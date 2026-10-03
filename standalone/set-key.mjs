/**
 * standalone/set-key.mjs —— 填入 DeepSeek API Key 并当场验证
 * 用法：双击 D:\dsh-pet\设置密钥.cmd，或 node standalone/set-key.mjs
 * 写入位置：standalone/credential.json 的 api_key（明文，本机自用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRED = join(HERE, 'credential.json');

function readCred() {
  try {
    return JSON.parse(readFileSync(CRED, 'utf8'));
  } catch {
    return {};
  }
}
function writeCred(key) {
  writeFileSync(CRED, JSON.stringify({ api_key: key, usage_token: '' }, null, 2) + '\n', 'utf8');
}
const mask = (k) => (k ? k.slice(0, 3) + '…' + k.slice(-4) + '（长度 ' + k.length + '）' : '(空)');

const current = readCred();
console.log('');
console.log('  dsh-pet 脱离版 —— 设置 DeepSeek API Key');
console.log('  ------------------------------------------------------------');
console.log('  当前 Key：' + mask(String(current.api_key || '')));
console.log('  写入位置：' + CRED);
console.log('  ------------------------------------------------------------');
console.log('  获取地址：https://platform.deepseek.com/api_keys');
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('  请粘贴 API Key 后回车（直接回车 = 保持不变）：')).trim();
rl.close();

let key = String(current.api_key || '');
if (answer) {
  key = answer;
  writeCred(key);
  console.log('\n  已写入。');
} else {
  console.log('\n  保持不变。');
}

if (!key) {
  console.log('  没有可用的 Key，未做验证。填好后再运行一次即可。');
  process.exit(1);
}

console.log('  正在向 DeepSeek 验证…');
try {
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    console.log('  ✗ 验证失败：HTTP ' + res.status + ' ' + text.slice(0, 200));
    console.log('    （401 = Key 无效；403 = 被拒；其它见上方响应）');
    process.exit(1);
  }
  const j = JSON.parse(text);
  const info = (Array.isArray(j?.balance_infos) ? j.balance_infos : []).find(
    (x) => String(x?.currency || '').toUpperCase() === 'CNY',
  ) || (j?.balance_infos || [])[0];
  if (!info) {
    console.log('  ✗ 验证失败：响应里没有余额信息');
    process.exit(1);
  }
  console.log('  ✓ 验证通过');
  console.log('    币种：' + info.currency);
  console.log('    总余额：' + info.total_balance);
  console.log('    赠金：' + info.granted_balance + '    充值余额：' + info.topped_up_balance);
  console.log('');
  console.log('  现在启动桌宠，左键点它一下就能看到余额气泡了。');
} catch (e) {
  console.log('  ✗ 验证请求异常：' + String((e && e.message) || e));
  process.exit(1);
}
