// 静态自检：确认 HTML 内联脚本里被调用的函数都已定义，且没有残留旧引用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// 抽出 <script> 内容
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('未找到内联脚本');
const script = scriptMatch[1];

// 已定义的函数 / 箭头函数常量
const defined = new Set();
for (const m of script.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of script.matchAll(/(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) defined.add(m[1]);

// HTML 属性里 onclick= / onchange= / oninput= 调用的函数
const handlers = new Set();
for (const m of html.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)) {
  for (const call of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(call[1]);
}
// 脚本模板字符串里生成的 onclick="fn(...)" 同样检查
for (const m of script.matchAll(/on(?:click|change|input|keydown)=\\?"([^"\\]*)/g)) {
  for (const call of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(call[1]);
}

const builtins = new Set([
  'if', 'for', 'while', 'switch', 'return', 'this', 'event', 'JSON', 'Number', 'String',
  'Math', 'Object', 'Array', 'parseInt', 'setTimeout', 'clearTimeout', 'encodeURIComponent',
  'blur', 'focus', 'click', // DOM 方法：this.blur() 等
]);
const missing = [...handlers].filter((fn) => !defined.has(fn) && !builtins.has(fn)).sort();

console.log('已定义函数数量:', defined.size);
console.log('HTML 中引用的处理函数:', handlers.size);
console.log('缺失定义:', JSON.stringify(missing, null, 2));

// 旧列数残留检查
const legacy = [];
if (/tr\.cells\[5\]/.test(script)) legacy.push('仍引用 tr.cells[5]（列顺序已变）');
if (/isDeepseek1017/.test(script)) legacy.push('仍引用已删除的 isDeepseek1017');
if (/deepseekDefaultRules\(id\)/.test(script)) legacy.push('deepseekDefaultRules 不该接收参数');
console.log('残留问题:', JSON.stringify(legacy, null, 2));

if (missing.length || legacy.length) process.exitCode = 1;
