# Development Guide

## 文件结构

- `nai-image-workbench.user.js`：正式发布的单文件用户脚本
- `nai-image-workbench.dev.user.js`：本地开发加载器
- `tests/static.test.mjs`：静态约束测试
- `docs/USAGE.md`：完整用户说明
- `AGENTS.md`：自动化 Agent 的项目规则和调试安全约束

## 本地加载

1. 运行 `npm run dev`，启动只监听 `127.0.0.1:8765` 的本地开发服务。
2. 打开 `http://127.0.0.1:8765/nai-image-workbench.dev.user.js`，在 Tampermonkey 中安装一次开发加载器。
3. 在 Tampermonkey 的扩展设置中允许访问本地文件，并停用正式安装的脚本副本，避免重复加载。
4. 修改 `nai-image-workbench.user.js`。
5. 手动刷新测试页面以载入最新源码。

开发加载器通过本地 `@require` 读取源码，不需要每次重新安装。

开始浏览器调试前，必须先阅读并遵守项目根目录的 [`AGENTS.md`](../AGENTS.md)。该文件是调试安全规则的唯一来源，其他文档不重复维护同一规则。

## 测试

```powershell
npm test
```

当前测试包含 JavaScript 语法检查，以及对以下不变量的静态验证：

- 不刷新或导航 NovelAI 页面
- 不加载外部代码或使用特权 Userscript API
- 不并行派发生成请求
- 保留原始响应处理和 History 更新流程
- 队列重试、Seed 原样保留和记录上限
- Prompt 占位符、冻结请求和批次恢复规则
- History 状态标识不拦截指针事件

## 架构概览

### 状态存储

任务、设置和批次状态保存在 IndexedDB。较大的二进制字段单独存储并按 SHA-256 去重。

### 多标签页协调

BroadcastChannel 负责状态通知，Web Locks 负责执行排他。多个页面可以显示同一队列，但同一时刻只有一个页面发送请求。

### 请求捕获

点击入队时，脚本立即调用 NovelAI 原始生成函数，并在 `fetch` 层截住通过校验的请求；没有请求就不创建任务。Seed 不由工具生成或改写，运行任务时仍然让 NovelAI 原始代码处理响应、主画面和 History。

### 批量替换

批量模式冻结一份完整请求模板，只替换 Base Prompt 中指定的占位符；包括 Seed 在内的其他参数保持不变。

### History 状态

History 标识读取 NovelAI 自身的下载状态。视觉标识由不接收指针事件的伪元素绘制，不在缩略图上增加交互层。

## 发布检查

1. 更新用户脚本的 `@version` 和 `SCRIPT_VERSION`。
2. 同步更新 `package.json` 与 `CHANGELOG.md`。
3. 运行 `npm test`。
4. 检查公开文件中是否包含令牌、Cookie、私人 Prompt 或生成结果。
5. 检查 README 中的安装链接和文档链接。
6. 提交并推送后创建对应的 GitHub Release。
