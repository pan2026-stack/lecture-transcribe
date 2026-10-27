# 课堂转写 · 实时字幕 + 自动笔记

本地跑的课堂记录工具：**浏览器麦克风 → 实时转写 → 一键整理成「完整讲稿 + 结构化笔记」→ 落进 Obsidian 收件箱**。

- 不用装 Python 依赖（纯标准库），绿色版自带 Python 运行时
- 音频只发给语音识别接口，稿子和笔记全存在你本机
- 识别默认硅基流动 `XingChenASR-V3.2-Ultra`，整理默认 DeepSeek `deepseek-flash`，都可在设置里换

## 界面长什么样

左边是竖排的 `记录 / 处理 / 历史 / 设置`，中间是转写区，右边上半是音量环和会动的机器人，下半是时长、段落、字数、译文、待识别五个数字，以及「开始听课 / 结束并保存 / 生成笔记」。

顶部工具条显示状态灯和两条连接指示灯：

| 灯 | 含义 |
|---|---|
| 未开始 | 还没点开始 |
| 启动中… | 正在申请麦克风 |
| 收音中 | 正常录音，没有积压 |
| 解析中… / 排队解析 N 段 | 正在识别 / 有 N 段排队 |
| 已暂停 | 暂停状态 |
| 收尾中… | 正在切段存稿 |
| 先存盘 · 待识别 N | 识别跟不上，降级为只录音 |
| 麦克风被拒绝 / KEY 被拒绝 | 对应故障 |

## 三步跑起来

### 方式一：绿色版（推荐给不写代码的人）

1. 下载绿色版 zip，解压到英文路径（例如 `D:\课堂转写`）
2. 双击 `启动.bat`
3. 浏览器打开 `http://127.0.0.1:8787`，首次会提示填两个 KEY

### 方式二：直接跑源码

```bash
python server.py            # 默认 http://127.0.0.1:8787
python server.py --port 9000
```

只用标准库，Python 3.10+ 即可。想要关键词云更准，可额外装：

```bash
pip install jieba           # 可选，不装会退回内置的 n-gram 分词
```

## 需要准备的东西

| 项目 | 用途 | 去哪拿 |
|---|---|---|
| 语音识别 KEY | 把音频转成文字 | 硅基流动（OpenAI 兼容 `/audio/transcriptions`） |
| DeepSeek KEY | 把转写稿整理成讲稿和笔记 | DeepSeek 开放平台 |
| Obsidian 收件箱路径 | 笔记落到哪 | 例如 `D:\Obsidian\00-收件箱` |

两个 KEY 都保存在本机 `config.json`，不上传任何地方。仓库里只有 `config.example.json`。

## 命令行也能用（配合 skill）

录完的稿子在 `sessions/` 里，可以直接整理：

```bash
python cli.py sessions/20261024-1430-课堂.md
python cli.py 某份转写稿.md --title "法理学 第五讲" --duration 01:42:00
```

输出两份文件的路径，同时落进 Obsidian 收件箱。

## 目录

```
server.py            本地服务：识别 / 整理 / 存稿 / 落盘，纯标准库
app.js index.html    前端（无框架，原生 JS）
style.css            样式（浅灰 + 天蓝）
emotion-ball/        机器人表情球
cli.py               命令行整理入口
config.example.json  配置样例（不含 KEY）
SKILL.md             作为 DSH skill 安装时的说明
make-portable.py     生成绿色版目录
PACKAGING.md         打包成 exe / 安装包的思路（未验证）
```

## 配置项说明

`config.json` 里常用的几项：

| 键 | 说明 |
|---|---|
| `base_url` / `model` / `api_key` | 语音识别接口、模型、KEY |
| `notes_base_url` / `notes_model` / `notes_api_key` | 整理用的接口、模型、KEY |
| `obsidian_inbox` | 笔记落盘目录 |
| `segment_seconds` | 一句话最长多少秒强制切断（默认 15） |
| `reading_list_max` | 笔记里最多几个延伸阅读链接（默认 4） |

## 已知限制

- 识别和整理都要联网；断网时会降级为「只录音存盘」，联网后可在「处理」页补识别
- 实时字幕有延迟：一句话说完才出字（按停顿断句），最长等 `segment_seconds`
- `PACKAGING.md` 里的 exe / 安装包流程没有在真实环境验证过

## License

MIT
