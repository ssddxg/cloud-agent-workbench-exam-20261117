# expense-summary — 零依赖费用汇总工具

一个纯 Node.js 内置模块实现的命令行工具：读取 CSV 费用流水，按 `category` 分组汇总 `amount`，
并计算总金额。**不依赖任何第三方包**（仅使用 `node:fs/promises`、`node:path`、`node:url`），
无需 `npm install`。

## 文件

| 路径 | 说明 |
| --- | --- |
| `outputs/expense-summary.mjs` | 工具本体（ESM 模块，零依赖） |
| `outputs/result.json` | 全量汇总结果（`uploads/expenses.csv` 全部记录） |
| `outputs/transport-result.json` | 仅「交通」类别的汇总结果 |
| `uploads/expenses.csv` | 输入数据（`date,category,amount`） |

## 环境要求

- Node.js ≥ 18（开发与验证使用 v22.19.0）
- 无需安装依赖，无需 `package.json`

## 用法

```bash
# 默认读取 ../uploads/expenses.csv，输出可读表格（全部类别）
node outputs/expense-summary.mjs

# 只汇总指定类别
node outputs/expense-summary.mjs --category 交通

# 汇总多个类别（逗号分隔）
node outputs/expense-summary.mjs --category 交通,餐饮

# 筛选类别并断言总额为 50（不匹配则退出码 1）
node outputs/expense-summary.mjs --category 交通 --expect-total 50

# 筛选类别并把结果写入文件
node outputs/expense-summary.mjs --category 交通 --out outputs/transport-result.json

# 指定 CSV 路径
node outputs/expense-summary.mjs uploads/expenses.csv

# 输出 JSON
node outputs/expense-summary.mjs --json

# 查看帮助
node outputs/expense-summary.mjs --help
```

### 选项

| 选项 | 说明 |
| --- | --- |
| `--category <name>` | 只汇总指定类别；可用逗号分隔多个。**不传此参数时汇总全部类别** |
| `--expect-total <n>` | 断言汇总总额等于 `n`；不匹配时打印错误并以退出码 1 失败 |
| `--json` | 以 JSON 格式输出汇总结果（替代表格） |
| `--out <file>` | 将 JSON 结果写入文件；同时仍向 stdout 打印 JSON |
| `--min <n>` | 过滤掉 `amount` 小于 `n` 的记录后再汇总 |
| `-h`, `--help` | 显示帮助信息 |
| `[csvPath]` | 可选的输入 CSV 路径，默认为 `uploads/expenses.csv` |

`--category` 与 `--min` 可以叠加使用，两个筛选条件按「与」关系生效。

## 输入格式

CSV 需包含表头行，必须含有 `category` 与 `amount` 两列；`date` 列可选。

```csv
date,category,amount
2026-11-01,交通,32.50
2026-11-02,餐饮,68.00
```

解析规则：

- 表头名大小写不敏感，前后空白会被去除
- 支持 UTF-8 BOM、LF / CRLF / CR 三种换行符
- 支持 RFC 4180 风格的引号包裹字段（含 `""` 转义）
- 空行会被跳过
- `amount` 必须是合法数字，否则报错并给出所在行号

## 输出格式

### 表格输出（默认）

全部类别（不带 `--category`）：

```
分类  笔数  金额    占比
----  ----  ------  -------
办公  1     120.00  42.86%
餐饮  2     110.00  39.29%
交通  2     50.00   17.86%
合计  5     280.00  100.00%

总计: 280.00 (5 笔, 3 个分类)
```

仅「交通」类别（`--category 交通`）：

```
筛选类别: 交通

分类  笔数  金额   占比
----  ----  -----  -------
交通  2     50.00  100.00%
合计  2     50.00  100.00%

总计: 50.00 (2 笔, 1 个分类)
```

分类按金额从高到低排序；金额相同时按分类名排序。占比为该分类金额占**当前汇总范围内**总金额的百分比，
四舍五入到两位小数（合计可能因舍入存在 ±0.01% 的尾差）。表格按终端显示宽度对齐，
中日韩全角字符按 2 列计算。

### JSON 输出

```json
{
  "source": "uploads\\expenses.csv",
  "total": 280,
  "recordCount": 5,
  "categoryCount": 3,
  "categories": [
    { "category": "办公", "count": 1, "total": 120, "share": 42.86 },
    { "category": "餐饮", "count": 2, "total": 110, "share": 39.29 },
    { "category": "交通", "count": 2, "total": 50,  "share": 17.86 }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `source` | 输入 CSV 路径（工作区内显示为相对路径） |
| `total` | 汇总范围内的金额总计 |
| `recordCount` | 参与汇总的记录条数 |
| `categoryCount` | 汇总出的分类数量 |
| `categories[]` | 各分类汇总，按金额降序 |
| `categories[].count` | 该分类的记录条数 |
| `categories[].total` | 该分类金额小计 |
| `categories[].share` | 该分类金额占总额百分比（%） |
| `categoryFilter` | **仅在传入 `--category` 时出现**，记录本次使用的类别筛选值 |

## 错误处理

| 场景 | 退出码 | 说明 |
| --- | --- | --- |
| 文件不存在 / 无法读取 | 1 | `错误: 无法读取 CSV 文件 ...` |
| CSV 为空、缺列、金额非法 | 1 | `错误: CSV 解析失败 - ...`（含行号） |
| `--category` 指定的类别在 CSV 中不存在 | 1 | `错误: CSV 中不存在类别: xxx（可用类别: ...）` |
| `--expect-total` 与实际总额不符 | 1 | `错误: 总额断言失败 - 期望 60.00, 实际 50.00` |
| `--category` / `--min` / `--expect-total` 缺少参数或参数非法 | 2 | `错误: 选项 --category 需要一个非空的类别名称` |
| 未知命令行选项 | 2 | `错误: 未知选项: --xxx` |

所有金额在求和后统一按 0.01 元精度四舍五入，避免浮点误差带来的尾数（如 `0.1 + 0.2`）。

## 验证结果

### 全量汇总（`uploads/expenses.csv`，见 `outputs/result.json`）

| 分类 | 笔数 | 金额 | 占比 |
| --- | --- | --- | --- |
| 办公 | 1 | 120.00 | 42.86% |
| 餐饮 | 2 | 110.00 | 39.29% |
| 交通 | 2 | 50.00 | 17.86% |
| **合计** | **5** | **280.00** | **100.00%** |

### 仅「交通」类别（`--category 交通`，见 `outputs/transport-result.json`）

| 分类 | 笔数 | 金额 | 占比 |
| --- | --- | --- | --- |
| 交通 | 2 | 50.00 | 100.00% |
| **合计** | **2** | **50.00** | **100.00%** |

实际运行命令与断言结果：

```bash
node outputs/expense-summary.mjs --category 交通 --expect-total 50 --out outputs/transport-result.json
# 退出码 0 —— 断言通过
```

| 断言 | 结果 |
| --- | --- |
| `transport-result.json` 的 `total === 50` | PASS |
| 仅含 1 个分类且为「交通」 | PASS |
| `categories[].total` 之和 === 50 | PASS |
| 不带 `--category` 时仍输出全量 280.00 / 5 笔 | PASS |
| 全量 `result.json` 未被修改（SHA-256 校验一致） | PASS |

已用独立的 PowerShell `Import-Csv` + `Measure-Object` 交叉校验，全量总额 280.00、
各分类小计（办公 120 / 餐饮 110 / 交通 50）与工具输出完全一致。

## 限制

- 仅支持单表头行的扁平 CSV；不支持多行字段、注释行或分号等自定义分隔符
- 不做币种换算，也不区分支出/收入方向（负数金额会作为负值参与汇总）
- `--min` 与 `--category` 的过滤作用于单条记录，不支持按日期区间筛选
- `--category` 为精确匹配（区分大小写与前后空白），不提供模糊/正则匹配