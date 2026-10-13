/**
 * Markdown 渲染器单元测试：node tools/markdown-test.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const md = require('../public/markdown.js');

let pass = 0;
let failed = 0;

function t(label, input, expect, mode = 'contains') {
  const html = md(input);
  const ok = mode === 'contains' ? html.includes(expect) : html === expect;
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else {
    failed += 1;
    console.log(`  ✗ ${label}\n      输入: ${JSON.stringify(input)}\n      期望${mode === 'equals' ? '等于' : '包含'}: ${JSON.stringify(expect)}\n      实际: ${JSON.stringify(html)}`);
  }
}

function not(label, input, bad) {
  const html = md(input);
  if (!html.includes(bad)) { pass += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label} —— 不应出现 ${JSON.stringify(bad)}，实际 ${JSON.stringify(html)}`); }
}

console.log('\nMarkdown 渲染器测试\n');

console.log('【标题与段落】');
t('一级标题', '# 数学', '<h1>数学</h1>');
t('三级标题', '### 线性代数', '<h3>线性代数</h3>');
t('段落', '这是一段话。', '<p>这是一段话。</p>');
t('连续两行合成一段并用 <br> 连接', '第一行\n第二行', '<p>第一行<br>第二行</p>');

console.log('\n【行内样式】');
t('加粗', '这是**重点**内容', '<strong>重点</strong>');
t('斜体', '这是*强调*内容', '<em>强调</em>');
t('行内代码', '使用 `useState` 钩子', '<code>useState</code>');
t('删除线', '~~忘了~~算了', '<del>忘了</del>');
t('链接', '见 [文档](https://example.com)', '<a href="https://example.com"');
t('图片', '![图](a.png)', '<img alt="图" src="a.png"');

console.log('\n【列表】');
t('无序列表', '- 甲\n- 乙', '<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>', 'contains');
t('有序列表', '1. 第一\n2. 第二', '<ol>');
t('列表中间空行不断开', '- 甲\n\n- 乙', '<li>乙</li>');
t('* 号的列表项不会被当成斜体', '* 甲\n* 乙', '<ul>');
t('待办未完成', '- [ ] 复习第 3 章', '<li class="md-task"><input type="checkbox" disabled> 复习第 3 章</li>');
t('待办已完成', '- [x] 复习第 3 章', '<li class="md-task is-done"><input type="checkbox" disabled checked> 复习第 3 章</li>');
t('待办支持行内样式', '- [ ] **重点**内容', '<strong>重点</strong>');

console.log('\n【引用、分隔线、代码块】');
t('引用', '> 矩阵是线性变换的表示', '<blockquote>矩阵是线性变换的表示</blockquote>');
t('多行引用', '> 第一行\n> 第二行', '<blockquote>第一行<br>第二行</blockquote>');
t('分隔线', '---', '<hr>');
t('代码块', '```js\nconst a = 1;\n```', '<pre><code data-lang="js">const a = 1;</code></pre>');
t('代码块里的 Markdown 记号不被解析', '```\n# 这不是标题\n**不加粗**\n```', '# 这不是标题\n**不加粗**');
not('代码块内不产生 h1', '```\n# 标题\n```', '<h1>');
t('无语言代码块', '```\nplain\n```', '<pre><code data-lang="">plain</code></pre>');

console.log('\n【表格】');
t('表格表头', '| 概念 | 含义 |\n| --- | --- |\n| 先验 | 之前的判断 |', '<th>概念</th>');
t('表格数据行', '| 概念 | 含义 |\n| --- | --- |\n| 先验 | 之前的判断 |', '<td>先验</td>');
t('表格行数正确', '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |', '<tr><td>3</td><td>4</td></tr>');

console.log('\n【安全性：不能注入脚本】');
not('转义 <script>', '<script>alert(1)</script>', '<script>');
t('尖括号被转义', 'a < b', 'a &lt; b');
not('行内 HTML 不生效（原样当文本）', '<img src=x onerror=alert(1)>', '<img ');
not('链接里的引号不会逃逸属性', '[x](javascript:alert(1)" onmouseover="alert(2))', '" onmouseover="');

console.log('\n【边界情况】');
t('空输入返回空串', '', '', 'equals');
t('null 输入不报错', null, '', 'equals');
t('只有空白', '   \n  ', '', 'equals');
t('纯代码块', '```\nx\n```', '<pre>');

console.log(`\n结果：${pass} 项通过，${failed} 项失败\n`);
process.exit(failed ? 1 : 0);
