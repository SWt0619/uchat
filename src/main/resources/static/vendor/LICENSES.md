# Uchat 前端第三方库（本地化 vendor 目录）

> 目的：让 `index.html` 在**完全断网 / 内网**环境下也能正常渲染 Markdown、代码高亮与数学公式。
> 原先这 3 个库都从 `cdn.jsdelivr.net` 加载（`index.html` 第 9–14 行共 6 个引用），内网不可达时
> Markdown 不解析、代码不高亮、公式不渲染。现已全部下到本目录，`index.html` 改为相对路径引用。

## 清单

| 库 | 版本 | 本目录文件 | 许可证 | 来源 |
|---|---|---|---|---|
| marked | **15.0.12** | `marked/marked.min.js`（39 903 B） | **MIT** | `https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js` ← 上游 `https://github.com/markedjs/marked`（npm `marked`） |
| highlight.js | **11.9.0** | `highlight/highlight.min.js`（121 727 B）<br>`highlight/styles/github-dark.min.css`（1 315 B） | **BSD-3-Clause** | `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js`<br>`https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css` ← 上游 `https://github.com/highlightjs/cdn-release` / `https://github.com/highlightjs/highlight.js` |
| KaTeX | **0.16.11** | `katex/katex.min.js`（275 414 B）<br>`katex/katex.min.css`（23 335 B）<br>`katex/contrib/auto-render.min.js`（3 481 B）<br>`katex/fonts/*.woff2`（20 个，共 259 792 B） | **MIT** | `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/...` ← 上游 `https://github.com/KaTeX/KaTeX`（npm `katex`） |

许可证类型取自各包在上游 registry 的声明字段（npm registry `license`）：
`marked@15.0.12 → MIT`、`katex@0.16.11 → MIT`、`highlight.js@11.9.0 → BSD-3-Clause`。

## 关于 marked 的版本固定（重要）

原引用 `https://cdn.jsdelivr.net/npm/marked/marked.min.js` **未写版本号**，jsdelivr 会解析到
「**最新一个仍然提供根目录 `marked.min.js`（UMD 打包产物）的版本**」。

实测（2026-09，本机直连）：
- `GET https://cdn.jsdelivr.net/npm/marked/marked.min.js` → **200，39 903 B**，文件头注释为
  `marked v15.0.12 - a markdown parser`；
- `GET https://cdn.jsdelivr.net/npm/marked@18.0.14/marked.min.js`（当时 npm `latest`）→ **404**
  （marked 从某个版本起不再随包发布根目录 `marked.min.js`）⇒ 所以线上实际长期跑的就是 **15.0.12**。

因此本地化时**锁定 15.0.12**，并已用 sha256 证明「未锁版本 URL」与「`@15.0.12` URL」是**同一份字节**：

```
UNPINNED https://cdn.jsdelivr.net/npm/marked/marked.min.js : 39903 B
         sha256=3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c
PINNED   https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js : 39903 B
         sha256=3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c
BYTE-IDENTICAL = True
```

⇒ **行为零变化**（同一份 JS 字节），区别只是不再需要外网。

## 关于 KaTeX 字体

`katex.min.css` 里用**相对路径** `url(fonts/...)` 引用字体（共 60 条 url：20 个 `.woff2` + 20 个 `.woff` + 20 个 `.ttf`）。
本目录**保持相对目录结构** `vendor/katex/fonts/`，**没有改 CSS 里任何一行路径**，
所以 `katex/katex.min.css → fonts/KaTeX_*.woff2` 的相对解析天然成立。

只下了 **`.woff2`**（20 个）：
- Chrome / Edge / Firefox / Safari 现代版本都支持 woff2，CSS 里 `src` 的第一项就是 woff2，
  浏览器只会请求它、不会去取 `.woff` / `.ttf`（已用 http 服务访问日志确认，见
  `prompts/_evidence/T1.md`：只出现 `.woff2` 请求且全部 200，无 404）；
- 20 个 woff2 合计 259 792 B；若把 60 个字体全下会增加约 1.1 MB 的无用体积。

## 未包含的内容

- 各库的 `LICENSE` 正文文件未复制到本目录（仅在本文件登记名称/版本/来源/许可证类型）。
  如需随包分发许可证正文，可从上面"来源"一列的仓库根目录取 `LICENSE`。

## 重新下载 / 复核（可复制执行）

```python
# Python 3.14（仅标准库）；本机直连 jsdelivr 可用
import urllib.request, hashlib
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 直连，不走代理
def dl(u):
    r = urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"})
    with op.open(r, timeout=90) as f: return f.read()
for u in ["https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js",
          "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js",
          "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css",
          "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
          "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
          "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"]:
    d = dl(u); print(len(d), hashlib.sha256(d).hexdigest(), u)
# KaTeX 字体：从 katex.min.css 里正则抽 url(fonts/xxx.woff2) 再逐个下载（见 prompts/_evidence/T1.md 的脚本）
```
