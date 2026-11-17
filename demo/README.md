# 演示：两类工作与持续交流

材料完全虚构。应用应已通过 Docker 或本地方式启动，服务端已配置有效模型凭据。浏览器打开 http://localhost:3210。以下过程约需 5–10 分钟，具体取决于模型服务。

## 代码开发

新建会话“费用汇总工具”，上传本目录 `expenses.csv`，发送：

> 开发一个零依赖 Node.js 费用汇总命令行工具。读取 uploads/expenses.csv，按 category 汇总 amount 并计算总额。创建 outputs/expense-summary.mjs 和 outputs/README.md，运行工具验证结果，把实际输出保存到 outputs/result.json。不要安装依赖，只在本会话目录内工作。

观察执行状态及真实命令日志，完成后在文件区预览代码和结果，再下载成果。预期交通 50、餐饮 110、办公 120，总额 280；具体 JSON 字段由助手实现。

继续发送：

> 继续修改刚才的费用工具：增加 --category 参数，只汇总指定类别。无参数保留全部汇总。实际运行 --category 交通，断言总额为 50，并保存输出到 outputs/transport-result.json。同步更新 README，保留原有结果文件。

检查同一会话拥有两轮请求和成果，CLI 沿用 thread ID；下载代码可用 `node expense-summary.mjs <CSV路径>` 及其 README 说明复现。

## 日常材料整理

另建会话“项目周报”，上传 `meeting-notes.md`，发送：

> 阅读 uploads/meeting-notes.md，整理中文项目周报 outputs/weekly-report.md，并生成可导入表格的 outputs/action-items.csv，字段包含事项、负责人、截止日期、状态。区分已完成、待办、风险与决定。必须从文件读取，不要编造信息，也不要安装依赖。

继续发送：

> 在现有周报后追加“下周优先级”部分，按 P0/P1 排序并说明理由；保留原始事实，不补造任务。另外创建 outputs/executive-summary.md，给管理者一份不超过 200 字的摘要，列出最需要关注的风险和决定。

检查周报、待办 CSV 和摘要。纪要有三位负责人、三个截止日期以及报表口径风险；生成物应保留这些事实。

## 多会话和异常

在两个会话之间切换，确认消息和文件分别保存。关闭页面后重新打开，确认旧工作仍在；可在一个会话执行时切到另一个，或刷新观察服务端继续执行。需要时点击停止，已有成果仍可下载，并可发送消息继续。

验证重启恢复可执行 `docker compose restart`，重新打开页面。正在运行的任务会标记为中断，用户可继续交流，不会自动重做可能有副作用的命令。保留证据时请隐藏凭据与无关个人信息。

## 自动重现与证据

```bash
# 终端一：启动应用
npm start
# 终端二：执行真实 Agent 演示
npm run demo
```

也可先 `docker compose up -d`，然后在宿主机运行 `npm run demo`；脚本默认访问 `http://127.0.0.1:3210`，可通过 `DEMO_URL` 指定地址。它会同时创建两项独立工作，再各自继续一次，检查真实成功命令和保留的 CLI thread ID，并将会话、工具事件、可下载成果及总结保存到 `evidence/`。这会实际消耗模型额度。

`evidence/verification.json` 是机器可读总结，`evidence/code-task/session.json` 与 `evidence/daily-task/session.json` 包含完整演示事件，两侧 `outputs/` 是实际生成的成果。CI 的 `docker-verification` artifact 另存容器内真实 CLI smoke 结果；是否运行和成功以实际工作流记录为准。
