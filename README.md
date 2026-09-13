# Fileclass Meta Bind v0.1.5

本版只重做 Multi 候选框的 UI，交互规则保持 v0.1.4：

- 点击未选项 → 选中
- 点击已选项 → 取消
- 连续点击不会关闭
- Esc 退出
- 点击外部退出

## UI 改造

不再自己设计一套列表样式。

现在直接复用 Obsidian 自己的 Prompt / Suggestion DOM class：

```text
prompt-input-container
prompt-input
prompt-results
suggestion
suggestion-item
suggestion-content
suggestion-title
suggestion-aux
suggestion-flair
suggestion-highlight
is-selected
```

因此：

- 搜索框高度、字体、间距跟 Obsidian
- hover / 键盘当前项跟 Obsidian
- 暗色/亮色主题自动跟随
- 第三方 Theme 对原生 Suggest UI 的定制也更容易自然继承

选中项只在右侧显示 Obsidian 原生 `check` 图标，不再显示“已选 / 未选”文字。

## 键盘操作

```text
↑ / ↓   移动当前高亮项
Enter   切换选中/取消，不关闭弹窗
Esc     关闭
```

鼠标点击也只是切换，不关闭。

## 搜索

搜索结果中的命中文字使用 Obsidian 的：

```text
suggestion-highlight
```

样式显示。

## 安装

覆盖：

```text
<Vault>/.obsidian/plugins/fileclass-meta-bind/
├── manifest.json
├── main.js
└── styles.css
```

Reload plugins 后确认版本：

```text
0.1.5
```

## Privacy and license

Fileclass Meta Bind makes no network requests, uses no telemetry, and accesses vault files through Obsidian's API. It does not bundle Fileclass, Meta Bind, or CodeMirror; those integrations use the APIs exposed by the installed host plugins and Obsidian. It is released under the [MIT License](LICENSE).
