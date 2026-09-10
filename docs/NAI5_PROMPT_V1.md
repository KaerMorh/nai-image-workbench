# NAI5 正面提示词交换格式 V1

`NAI5_PROMPT_V1` 是 NovelaiTool 用于导入和导出 NAI5 正面提示词、Character 正面提示词及单一位置坐标的纯文本格式。它只描述表单内容，不包含负面提示词、生成参数或图片生成指令。

## 完整示例

```text
[NAI5_PROMPT_V1]

[MAIN]
2girls, 1boy, monochrome, manga, very aesthetic, masterpiece

[CHARACTER]
[POSITION]
0.555, 0.733
[PROMPT]
girl-B, magical girl, looking down, frilled dress

[CHARACTER]
[POSITION]
0.506, 0.102
[PROMPT]
girl-A, black hair, low ponytail, glasses, blazer

[END]
```

没有 Character 时使用：

```text
[NAI5_PROMPT_V1]

[MAIN]
solo, outdoors, sunset

[END]
```

## 语法

1. 文件或粘贴文本的首个非空行必须是 `[NAI5_PROMPT_V1]`。
2. `[MAIN]` 必须出现一次，其后是主正面提示词。
3. `[CHARACTER]` 可以出现 0 至 20 次。每出现一次就创建一个独立的 Character，输入顺序必须保留。
4. 每个 `[CHARACTER]` 必须依次包含一个 `[POSITION]` 和一个 `[PROMPT]`。
5. `[POSITION]` 的下一非空行必须是 `x, y`。`x` 和 `y` 都是包含端点的 `0` 至 `1` 十进制数，最多保留三位小数；左上角是 `(0, 0)`，右下角是 `(1, 1)`。
6. 每个 Character 只允许一个位置坐标，不支持多中心点。
7. `[PROMPT]` 后是该 Character 的正面提示词，直到下一个 `[CHARACTER]` 或 `[END]`。
8. `[END]` 必须出现一次，并且是最后一个非空标记。其后不允许有其他内容。
9. 不提供 Character 名称字段。即使多个 Character 的提示词描述同一人物，也必须保留为独立条目，不能按内容合并。
10. 主提示词和 Character 提示词均可跨多行。工具不得翻译、纠错、拆词、合并逗号或改变大小写。

## 保留标记

规范导出会让以下内容各自独占一行：

```text
[NAI5_PROMPT_V1]
[MAIN]
[CHARACTER]
[POSITION]
[PROMPT]
[END]
```

这六个字符串是格式保留标记，不能出现在 Base Prompt 或 Character Prompt 正文中。格式不使用反斜杠转义；提示词原有的反斜杠按普通正文保留。

规范输出要求每个标记单独占一行，标记后不能附带正文。导入器仍会识别同一行中的标记，方便接收 `[PROMPT] Character 正面提示词` 或整行压缩的粘贴内容。

导入器可以接受整段文本被一个 Markdown 代码块包裹的情况。代码块之外只能有空白字符。它还会自动处理标记周围的普通空白、复制产生的 `&#x20;`、`&#32;`、`&#xa0;`、`&#160;` 和 `&nbsp;` 空格实体，以及标题中的 Markdown 下划线转义 `[NAI5\_PROMPT\_V1]`。

## 导入行为

- 导入仅在当前模型为 NAI5 时可用。
- 点击“应用”前必须完整解析并校验全部内容。任一字段有误时不修改现有表单，并显示具体的 Character 序号和错误原因。
- 应用后，`[MAIN]` 内容替换当前主正面提示词。
- 应用后，所有现有 Character 被导入内容整体替换，并按导入顺序创建；重复应用同一文本不会累积 Character。
- 每个 `[PROMPT]` 写入对应 Character 的正面提示词，每个 `[POSITION]` 写入对应的单一位置。
- 格式不包含负面提示词。导入创建的 Character 使用空负面提示词；主负面提示词及其他生成参数保持不变。
- 应用操作应支持一次撤销，以恢复应用前的主提示词、Character 及其位置。

## 导出行为

- NAI5 的导出结果必须使用本格式，不再输出旧格式。
- 导出主正面提示词、当前 Character 顺序、各 Character 正面提示词及单一位置。
- 坐标导出时四舍五入到最多三位小数，不进行九宫格吸附，也不添加无意义的末尾零。
- Base Prompt 或 Character Prompt 包含保留标记时禁止导出，并明确指出冲突的标记。
- Character 超过 20 个时禁止导出并提示数量上限；不得静默截断。

## 错误示例

导入器至少需要区分以下错误：缺少或重复的必要标记、标记顺序错误、Character 超过 20 个、Character 缺少位置或提示词、坐标不是两个有效数字、坐标越界、一个 Character 包含多个坐标，以及 `[END]` 后存在内容。
