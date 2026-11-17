/**
 * expense-summary — zero-dependency CSV expense aggregator.
 *
 * Reads a CSV with `date,category,amount` columns, sums `amount` grouped by
 * `category`, and prints a human-readable table plus a total.
 *
 * Usage:
 *   node outputs/expense-summary.mjs [csvPath] [--json] [--out <file>]
 *
 * Options:
 *   --json             Print the summary as JSON instead of a table.
 *   --out <file>       Write the JSON summary to <file> (also prints JSON to stdout).
 *   --min <n>          Only include rows whose amount is >= n.
 *   --category <name>  Only include the given category (comma-separated for several).
 *   --expect-total <n> Assert the grand total equals <n>; exits 1 on mismatch.
 *   --help             Show this help.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const DEFAULT_CSV = resolve(WORKSPACE, 'uploads', 'expenses.csv');

/** Parse CLI arguments into a normalized options object. */
function parseArgs(argv) {
  const options = {
    csvPath: DEFAULT_CSV,
    json: false,
    out: null,
    min: null,
    categories: null,
    expectTotal: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--out':
        options.out = argv[++i] ?? null;
        break;
      case '--min':
        options.min = parseNumber('--min', argv[++i]);
        break;
      case '--category':
        options.categories = parseCategoryList(argv[++i]);
        break;
      case '--expect-total':
        options.expectTotal = parseNumber('--expect-total', argv[++i]);
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`未知选项: ${arg}`);
        }
        options.csvPath = resolve(process.cwd(), arg);
    }
  }

  if (options.out !== null) {
    options.out = resolve(process.cwd(), options.out);
  }

  return options;
}

/** Parse a numeric option value, rejecting anything non-numeric. */
function parseNumber(option, value) {
  const parsed = Number(value);
  if (value === undefined || value === null || value.trim() === '' || !Number.isFinite(parsed)) {
    throw new Error(`选项 ${option} 需要一个数字`);
  }
  return parsed;
}

/** Parse a `--category` value into a list of category names. */
function parseCategoryList(value) {
  if (value === undefined || value === null) {
    throw new Error('选项 --category 需要一个非空的类别名称');
  }
  const list = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (list.length === 0) {
    throw new Error('选项 --category 需要一个非空的类别名称');
  }
  return list;
}

const HELP = `expense-summary — 零依赖 CSV 费用汇总工具

用法:
  node outputs/expense-summary.mjs [csvPath] [选项]

选项:
  --json            以 JSON 输出汇总结果
  --out <file>      将 JSON 结果写入文件
  --min <n>         仅统计 amount 大于等于 n 的记录
  --category <name> 仅统计指定类别（可用逗号分隔多个）；不指定则统计全部
  --expect-total <n> 断言总额等于 n，不匹配时以退出码 1 失败
  -h, --help        显示帮助信息

示例:
  node outputs/expense-summary.mjs
  node outputs/expense-summary.mjs uploads/expenses.csv --json
  node outputs/expense-summary.mjs --out outputs/result.json
  node outputs/expense-summary.mjs --category 交通
  node outputs/expense-summary.mjs --category 交通 --expect-total 50
`;

/**
 * Minimal RFC 4180 style CSV splitter: handles quoted fields and escaped quotes.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Turn CSV text into row objects keyed by normalized header names.
 */
function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== '');

  if (lines.length === 0) {
    throw new Error('CSV 文件为空');
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  for (const required of ['category', 'amount']) {
    if (!headers.includes(required)) {
      throw new Error(`CSV 缺少必需列: ${required}（实际表头: ${headers.join(', ')}）`);
    }
  }

  const dateIndex = headers.indexOf('date');
  const categoryIndex = headers.indexOf('category');
  const amountIndex = headers.indexOf('amount');

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]);
    const category = (fields[categoryIndex] ?? '').trim();
    const rawAmount = (fields[amountIndex] ?? '').trim();
    const amount = Number(rawAmount);

    if (category === '') {
      throw new Error(`第 ${i + 1} 行缺少 category 值`);
    }
    if (rawAmount === '' || !Number.isFinite(amount)) {
      throw new Error(`第 ${i + 1} 行 amount 不是合法数字: "${rawAmount}"`);
    }

    rows.push({
      date: dateIndex >= 0 ? (fields[dateIndex] ?? '').trim() : '',
      category,
      amount,
    });
  }

  return rows;
}

/** Collect the distinct categories present in the parsed rows. */
function collectCategories(rows) {
  return [...new Set(rows.map((row) => row.category))];
}

/**
 * Aggregate rows by category, computing subtotal, count and percentage.
 *
 * Filters are optional: without them every row is aggregated.
 */
function summarize(rows, { min = null, categories = null } = {}) {
  let filtered = rows;

  if (min !== null) {
    filtered = filtered.filter((row) => row.amount >= min);
  }
  if (categories !== null) {
    const wanted = new Set(categories);
    filtered = filtered.filter((row) => wanted.has(row.category));
  }

  const byCategory = new Map();
  for (const row of filtered) {
    const entry = byCategory.get(row.category) ?? { total: 0, count: 0 };
    entry.total += row.amount;
    entry.count += 1;
    byCategory.set(row.category, entry);
  }

  const categories2 = [...byCategory.entries()]
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category, 'zh-Hans-CN'));

  const total = categories2.reduce((sum, item) => sum + item.total, 0);
  const totalCount = categories2.reduce((sum, item) => sum + item.count, 0);

  const categoriesWithShare = categories2.map((item) => ({
    ...item,
    total: round2(item.total),
    share: total === 0 ? 0 : round2((item.total / total) * 100),
  }));

  return {
    total: round2(total),
    totalCount,
    categoryCount: categoriesWithShare.length,
    categories: categoriesWithShare,
  };
}

/** Round to 2 decimal places, avoiding float dust like 0.30000000000000004. */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Format a number as a fixed 2-decimal string. */
function formatAmount(value) {
  return value.toFixed(2);
}

/** Terminal display width of a string (CJK / full-width chars count as 2). */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += isWide ? 2 : 1;
  }
  return width;
}

/** Pad a string to a target display width. */
function padDisplay(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Render the summary as a plain-text table. */
function renderTable(summary) {
  const headers = ['分类', '笔数', '金额', '占比'];
  const rows = summary.categories.map((item) => [
    item.category,
    String(item.count),
    formatAmount(item.total),
    `${item.share.toFixed(2)}%`,
  ]);
  rows.push(['合计', String(summary.totalCount), formatAmount(summary.total), '100.00%']);

  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]))),
  );

  const line = (cells) =>
    cells.map((cell, column) => padDisplay(cell, widths[column])).join('  ');

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');

  return [line(headers), separator, ...rows.map(line)].join('\n');
}

/** Render a path relative to the workspace when possible, for portable output. */
function toPortablePath(csvPath) {
  const relative = relativePath(WORKSPACE, csvPath);
  if (relative === '' || relative.startsWith('..')) {
    return csvPath;
  }
  return relative;
}

/** Build the JSON-serializable report written to result files. */
function buildReport(csvPath, summary, categories = null) {
  const report = {
    source: toPortablePath(csvPath),
    total: summary.total,
    recordCount: summary.totalCount,
    categoryCount: summary.categoryCount,
    categories: summary.categories.map((item) => ({
      category: item.category,
      count: item.count,
      total: item.total,
      share: item.share,
    })),
  };

  if (categories !== null) {
    report.categoryFilter = categories;
  }

  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  let text;
  try {
    text = await readFile(options.csvPath, 'utf8');
  } catch (error) {
    console.error(`错误: 无法读取 CSV 文件 ${options.csvPath} (${error.message})`);
    process.exitCode = 1;
    return;
  }

  let rows;
  try {
    rows = parseCsv(text);
  } catch (error) {
    console.error(`错误: CSV 解析失败 - ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.categories !== null) {
    const available = collectCategories(rows);
    const missing = options.categories.filter((name) => !available.includes(name));
    if (missing.length > 0) {
      console.error(
        `错误: CSV 中不存在类别: ${missing.join(', ')}（可用类别: ${available.join(', ')}）`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const summary = summarize(rows, { min: options.min, categories: options.categories });

  if (options.expectTotal !== null && summary.total !== options.expectTotal) {
    console.error(
      `错误: 总额断言失败 - 期望 ${formatAmount(options.expectTotal)}, 实际 ${formatAmount(summary.total)}`,
    );
    process.exitCode = 1;
    return;
  }

  const report = buildReport(options.csvPath, summary, options.categories);

  if (options.out) {
    try {
      await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.error(`错误: 无法写入输出文件 ${options.out} (${error.message})`);
      process.exitCode = 1;
      return;
    }
    console.error(`已写入: ${options.out}`);
  }

  if (options.json || options.out) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (options.categories !== null) {
      console.log(`筛选类别: ${options.categories.join(', ')}`);
      console.log('');
    }
    console.log(renderTable(summary));
    console.log('');
    console.log(`总计: ${formatAmount(summary.total)} (${summary.totalCount} 笔, ${summary.categoryCount} 个分类)`);
  }
}

await main();