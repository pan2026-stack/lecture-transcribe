# 打包成安装包

三条路，按“能不能接受装 Python”选。**推荐第 1 条**。

## 1. 打成单文件 exe + 安装包（推荐）

需要：Python 3.10+（python.org 版本）、能上网装 PyInstaller、Inno Setup 6（可选，做 Setup.exe 用）。

```powershell
cd lecture-transcribe
.\build.ps1                 # 产出 dist\课堂转写.exe
iscc installer.iss          # 产出 dist\installer\课堂转写-Setup.exe
```

- `dist\课堂转写.exe` 自带 Python 运行时，**目标机器不用装 Python**
- 安装包带桌面快捷方式、开始菜单、卸载程序
- 第一次运行会在 exe 旁边生成 `config.json` 和 `sessions\`
- `build.ps1` 用 `.build-venv` 做独立环境，不污染系统 Python

> 已做的适配：`server.py` 里静态资源走 `sys._MEIPASS`，配置和会话写到 exe 所在目录——所以打包后设置和笔记不会丢到临时目录。

## 2. 便携包（不用装任何东西，也能离线做）

把下面这些放进一个文件夹，压成 zip：

```
课堂转写/
├─ python\            ← python-3.12.x-embed-amd64.zip 解压后的全部内容
├─ app\               ← 本目录的 server.py / index.html / style.css / app.js / emotion-ball\
├─ 启动.bat           ← python\python.exe app\server.py 然后打开 http://127.0.0.1:8787
└─ config.json
```

优点：不需要 PyInstaller、不装 Python、双击即用（解压后）。
缺点：文件夹大（约 12 MB），首次要手动配 `启动.bat`。

embedable 包下载：<https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip>

## 3. 保持现在的样子（最省事）

把 `lecture-transcribe` 整个文件夹拷给别人，对方装好 Python 后双击 `启动.bat`。
适合只有你自己用的场景。

---

## 打包后要注意

| 事项 | 说明 |
|---|---|
| `config.json` | 和 exe 同目录；换电脑要重新填两个 KEY |
| `sessions\` | 转写稿和历史都在这，卸载时默认不删 |
| 端口 8787 | 固定，被占用会起不来 |
| 杀毒误报 | PyInstaller 单文件 exe 常被误报，加白即可 |
| 首次启动慢 | 单文件模式要解包，约 1–2 秒 |

## 本次没有实际构建

这个环境连不上 PyPI / python.org（TLS 被拦），所以 exe 是在你的机器上构建的，`build.ps1` 和 `installer.iss` 已按标准流程写好，代码侧的路径适配也已完成并回归验证过。
