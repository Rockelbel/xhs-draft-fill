# 小红书草稿填写 · Chrome 插件

> 把本地目录里的文章 + 图片，一键填入小红书创作者中心发布页。**只负责填，不点保存** — 你检查无误后再手动点「保存草稿」或「发布」。

## 为什么做这个

写小红书图文笔记的痛点：标题/正文/多图一个个手动复制粘贴上传，6 张图 + 1 篇文案要 5 分钟，还容易漏。

市面上的方案要么是 Playwright 起独立 Chrome（不是你日常浏览器，要单独扫码登录、cookies 维护脆弱、反爬风险高），要么是 CLI 命令行（不直观）。

这个插件直接在**你日常 Chrome** 里运行：
- ✅ 用你已经登录的小红书会话，无需重新登录
- ✅ 一键填入，标题/正文/图片全自动
- ✅ 不点保存，最后一道把关在你手里
- ✅ 平台限制自动处理（标题截断、连续空行转换）
- ✅ 反爬风险接近 0（就是真实用户行为）

## 安装

仅支持 Chrome / Edge（Manifest V3）。

1. 下载或克隆本仓库
2. 打开 `chrome://extensions/`
3. 右上角开启「**开发者模式**」
4. 点「**加载已解压的扩展程序**」→ 选本仓库根目录
5. 插件出现在工具栏，红色方块图标

## 使用

### 准备本地目录

约定一个文件夹存放所有要发的图文笔记，例如 `~/Desktop/redbook/`。每篇笔记一个子目录：

```
redbook/
├── 260614_judgment_luxury/
│   ├── post.txt            # 文案
│   ├── pic1.png            # 任意命名、任意常见格式
│   ├── pic2.jpg            # png / jpg / jpeg / webp / gif 都行
│   ...
│   └── pic7.webp
├── 260615_other_topic/
│   ├── post.txt
│   ├── 1-cover.png
│   ├── 2-detail.jpg
│   └── ...
└── ...
```

**图片说明**：
- 自动识别文件夹下所有图片（扩展名为 png/jpg/jpeg/webp/gif），无需固定命名
- 按**自然顺序**排序：先按文件名中的数字，再按字母序（例如 `1.png` → `2.png` → `10.png` → `cover.png`）

### `post.txt` 格式

纯文本，简单 3 段：

```
你提交方案前那 3 秒的犹豫，正在变成你最值钱的瞬间

前两天看一个朋友改方案...

那一刻我突然意识到...


（中间正文若干段）


你下一次提交方案前那 3 秒的犹豫，别忽视。
那是你最贵的资产，刚开始计费。

#AI #人工智能 #判断力 #认知 #职场
```

| 部分 | 规则 |
|---|---|
| **标题** | 首行非空 → 自动当标题 |
| **Tags** | 末行若以 `#` 开头 → 解析成标签 |
| **正文** | 中间所有行 |

### 操作流程

1. 在 Chrome 里登录小红书创作者中心 https://creator.xiaohongshu.com/
2. 打开发布页 https://creator.xiaohongshu.com/publish/publish
3. 点插件图标 → 第一次：「选目录」→ 选 `redbook/` 根目录
4. Chrome 重启后第一次使用：点橙色「**授权访问目录**」按钮（一次即可，目录配置永久保存）
5. 列表显示所有笔记文件夹（按名字倒序，最新在上）
6. **点一项 → 自动填入**：切到「上传图文」tab → 上传所有图片 → 等预览 → 填标题 → 填正文
7. 你检查内容 → 手动点小红书页面的「保存草稿」/「发布」

## 平台限制自动处理

| 限制 | 处理策略 |
|---|---|
| 标题 ≤ 20 字 | 超出按中文标点（`，。,.！？!?；;`）智能截断 |
| 正文 ≤ 1000 字 | 超出报错提醒 |
| 正文禁连续空行 | `\n\n+` 自动转成「换行 + 空格 + 换行」（视觉有空行，但绕过 XHS 校验） |

## 架构

```
red_book_draft/
├── manifest.json          # MV3
├── popup/
│   ├── popup.html         # 主界面
│   ├── popup.css
│   └── popup.js           # 选目录、列文件夹、触发注入
├── injected/
│   └── fill.js            # 注入到 XHS 发布页的填写函数（MAIN world）
├── lib/
│   ├── db.js              # IndexedDB 持久化 FileSystemDirectoryHandle
│   └── parser.js          # post.txt 解析、标题截断、空行转换
└── icons/icon.png
```

### 关键技术点

- **File System Access API**：用户选一次目录后，`FileSystemDirectoryHandle` 存进 IndexedDB，永久保留。Chrome 安全模型要求每次重启后用户点击授权一次，无法绕过。
- **chrome.scripting + `world: 'MAIN'`**：注入到页面主世界，直接操作 React state、Quill 编辑器实例。
- **正文填写三级 fallback**：① Quill API `setText` → ② `paste` 事件 → ③ `execCommand('insertText') + 模拟 Enter keydown`，按可靠度尝试。
- **标题输入 React setter**：用 `Object.getOwnPropertyDescriptor` 拿到原生 setter 调用，确保 React 监听到 input 事件。
- **图片上传 DataTransfer**：构造 `DataTransfer` 注入到 `<input type="file">`，触发 change 事件。

## 调试

在 XHS 发布页打开 DevTools Console，所有注入流程会打 `[rbd-fill]` 日志。手动调用：

```js
__rbdFill({
  title: '测试标题',
  body: '段落 1\n \n段落 2',
  finalBody: '段落 1\n \n段落 2',
  images: []  // 没图也能填标题/正文，但图文笔记需要至少 1 张图
})
```

## 已知限制

- **仅支持 macOS / Chrome 137+**（需要 File System Access API）
- **XHS UI 改版可能导致选择器失效**：故障时看 console 的 `[rbd-fill]` 日志，调整 `injected/fill.js` 里的选择器
- **不支持视频、长文**：只针对图文笔记

## 路线图

- [x] 支持任意图片文件名 / 多种格式
- [ ] 支持视频笔记
- [ ] 支持话题（#tag）自动选择
- [ ] 支持地点 / 商品标记
- [ ] 选项页：可配置选择器、平台限制阈值

## License

MIT
