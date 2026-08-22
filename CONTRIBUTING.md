# Contributing

欢迎提交 Issue 和 Pull Request。

## 报告问题

请提供浏览器版本、Tampermonkey 版本、复现步骤、预期结果、实际结果，以及必要的控制台错误或截图。

提交前请移除 Cookie、令牌、私人 Prompt 和其他不希望公开的内容。

## 提交代码

1. Fork 仓库并从 `main` 创建功能分支。
2. 保持改动范围清晰，并为新的不变量补充测试。
3. 运行 `npm test`。
4. 更新受影响的用户文档和 `CHANGELOG.md`。
5. 提交 Pull Request，说明设计选择与验证方式。

浏览器调试和自动化测试必须遵守 [`AGENTS.md`](AGENTS.md)。安全规则只在该文件维护，避免多份文档逐渐失去同步。

## 设计原则

- NovelAI 空闲且无等待任务时，不改变原始 Generate 流程。
- 不并行发送生成请求。
- 不自动刷新或导航页面。
- 不主动下载、修改或删除 NovelAI History。
- 不向额外的第三方服务器发送 Prompt、图片或队列数据。
- 新增设置应提供保守、安全且可恢复的默认值。
