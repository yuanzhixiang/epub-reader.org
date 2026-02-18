下面这份方案按“内容完整展示、不遗漏”为第一优先级来设计：既覆盖 EPUB 2.0.1，也覆盖 EPUB 3.3（W3C Recommendation）并前向兼容 EPUB 3.4（Working Draft，新增 roll 布局与 AVIF 核心图片类型等）。关键思路是：**规范优先 + 宽容解析 + 资源可达性审计 + 渲染能力分级 + 明确降级策略**，让你在“看起来都能打开”的同时，能定位任何遗漏来自哪里（格式问题、资源缺失、能力不支持、被策略拦截等）。

主要依据的规范与官方测试/校验工具见文末引用。([W3C][1])

````markdown
# EPUB 渲染器：解析 + 渲染“内容不遗漏”的完整技术设计方案（含单元测试规划）
（覆盖 EPUB 2.0.1 + EPUB 3.3；前向兼容 EPUB 3.4、Multiple-Rendition）

---

## 0. 目标、边界与成功标准

### 0.1 目标（必须达到）
1) **可打开**：尽可能多的真实世界 EPUB（含不完全合规的）都能成功加载到“可阅读状态”。
2) **不遗漏**：不因为解析或资源解析策略导致内容缺失；若因能力不足（如 DRM 加密、解码器不支持）无法呈现，必须：
   - 在 UI/日志中明确标记“缺失原因”
   - 尝试规范定义的 fallback（manifest fallback / intrinsic fallback）
   - 输出可定位的诊断（资源路径、来源文档、引用链、加密算法等）
3) **一致性**：同一本书在不同设备/窗口尺寸/字体设置下，阅读顺序与导航一致（除固定版式按规范行为变化外）。
4) **安全**：默认不允许 EPUB 利用脚本、file://、路径穿越等访问宿主文件系统/敏感接口；但仍尽最大努力渲染其“应当出现”的内容。

### 0.2 非目标（可选）
- DRM 解密（通常需要授权/密钥，不属于通用渲染器范畴）。但要能检测并优雅报错。
- 完整实现所有 Web 平台 API（由底层 Web 引擎决定）。
- 100% 像所有商业阅读器那样处理所有私有扩展（但要提供扩展点）。

### 0.3 产物（对工程的落地形式）
- `EpubParser`：把容器解析为结构化模型（Package/Manifest/Spine/Nav 等）。
- `EpubResourceResolver`：统一 URL → bytes/content-type 的解析、解混淆、缓存、远程拉取策略。
- `EpubRenderer`：基于底层排版引擎（推荐 WebView/Chromium/WebKit）加载 spine + 导航 + 设置。
- `EpubAudit`：资源可达性/遗漏审计（强烈推荐，能显著减少“以为渲染了其实漏了”的风险）。
- `TestKit`：自动生成/组合测试 EPUB fixture + 断言解析与渲染行为。

---

## 1. EPUB 文件“完整格式结构”（从外到内）

> 你可以把 EPUB 当成一个“离线网站 + 一本书的元数据/阅读顺序/导航”的标准化打包格式。

### 1.1 物理容器：OCF ZIP（.epub）
EPUB 是一个 ZIP 容器（media-type: `application/epub+zip`），其内部是 OCF（Open Container Format）抽象文件系统的物理实现。

#### 1.1.1 Root Directory（根目录）
- ZIP 内“逻辑根目录”是所有相对路径的根（不是宿主文件系统路径）。
- 必有（规范要求）：
  - `/mimetype`：文本内容为 `application/epub+zip`，通常要求是 ZIP 中第一个条目且不压缩（真实世界可能不满足，需宽容）。
  - `/META-INF/container.xml`：指向一个或多个 OPF package document。

#### 1.1.2 META-INF 目录（配置与容器级文件）
`/META-INF/` 下通常包含：
- `container.xml`（required）：列出一个或多个 `<rootfile full-path="...">`。
- `encryption.xml`（optional）：资源加密/字体混淆信息；使用字体混淆时必需。
- `signatures.xml`（optional）：数字签名。
- `rights.xml`（optional）：DRM/权限信息（不等于可解密）。
- `metadata.xml`（optional）：容器/多版本渲染（multiple-rendition）相关元信息。
- `manifest.xml`（optional）：来自 ODF 的容器清单（很少见，但要能解析/忽略）。

#### 1.1.3 URL / Path 规则（决定你如何“正确找文件”）
- EPUB 内几乎一切引用最终都要归结为“URL 解析 + base URL”。
- 需要重点处理：
  - 相对路径（相对于某个文档所在目录/其 base URL）
  - 绝对 URL（http/https）
  - fragment（#id、#epubcfi(...) 等）
  - 禁止/危险 scheme（file: 必须拒绝；data: 有使用限制）
  - **out-of-container**：通过 `../` 试图逃逸容器根（必须检测并拒绝）

---

### 1.2 container.xml：入口与多 rootfile（多 rendition）
`META-INF/container.xml` 的核心结构：
- `<rootfiles><rootfile full-path="path/to/book.opf" media-type="application/oebps-package+xml"/></rootfiles>`
- 可能存在多个 `<rootfile>`：
  - EPUB 3：多个 rootfile 必须都是同一版本的 package document，每个代表一个“rendition”（不同呈现版本）。
  - EPUB 2：可能混入 PDF/其他格式（历史包袱），需按 media-type 筛选。

#### 1.2.1 Multiple-Rendition（多版本呈现）要点
- 可能通过 `META-INF/metadata.xml` 存放“跨 rendition 的统一标识”。
- container.xml 的 rootfile 可能带选择属性（如 rendition:media / rendition:layout / rendition:language 等）用于选择最合适的 rendition。
- 还可能通过 `<links>` 指向“rendition mapping document”（用于不同 rendition 之间位置映射）。

---

### 1.3 Package Document（OPF）：书的“目录与装配说明书”
OPF 是 EPUB 的“大脑”，描述：
- 书籍元数据（metadata）
- 资源清单（manifest）
- 阅读顺序（spine）
- 导航与封面提示（EPUB2 的 guide，EPUB3 的 nav/landmarks 等）
- 资源 fallback 链与（已废弃的）bindings 等扩展机制

你必须同时支持：
- **EPUB 3.x OPF**（版本 3.0/3.1/3.2/3.3/3.4 等，语义接近）
- **EPUB 2.0.1 OPF**（manifest/spine/guide + NCX）

#### 1.3.1 metadata（元数据）
要支持的常见来源与写法：
- Dublin Core：`dc:title`, `dc:language`, `dc:identifier`, `dc:creator` 等
- EPUB3 的 `<meta property="...">`（支持 `refines`、自定义词表、prefix 机制）
- EPUB2 的 `<meta name="cover" content="cover-image-id">`（封面指示的常见写法）
- EPUB3 的 `<link rel="...">` 元数据链接（可能是外部资源/记录）

特别注意：
- `unique-identifier` 属性指向某个 `dc:identifier` 的 id，用于：
  - 书籍唯一标识
  - 字体混淆（obfuscation）密钥推导

#### 1.3.2 manifest（资源清单）
每个 `<item>` 至少：
- `id`：唯一标识
- `href`：相对 OPF 的路径（也可能是绝对 URL）
- `media-type`：MIME 类型（真实世界可能缺失/写错 → 需要嗅探/容错）
- 可选：
  - `properties`：空格分隔属性（非常关键）
  - `fallback`：manifest fallback 链（避免资源不支持时内容缺失）
  - `media-overlay`：与 SMIL 媒体叠加关联

常见 `properties`（需至少识别并保留）：
- `nav`：EPUB3 导航文档
- `cover-image`：封面图片（EPUB3）
- `scripted`：脚本/表单内容文档提示
- `mathml`, `svg`, `switch`, `remote-resources` 等（用于能力/策略判断）
- 以及各种词表扩展（必须“未知即保留”，不要丢）

#### 1.3.3 spine（阅读顺序）
- `<spine>` 由 `<itemref idref="...">` 组成：定义默认阅读顺序。
- `linear="no"`：不在默认线性阅读流里（但仍可通过 TOC/链接访问；渲染器必须能打开它，且审计时要标记它的位置与可达性）
- `page-progression-direction="ltr|rtl|default"`：影响翻页方向与 spread 行为（尤其固定版式）

EPUB2 还可能有：
- `toc="ncx-id"`：指向 NCX 导航文件。

#### 1.3.4 guide（EPUB2，已废弃但现实里常见）
- `<guide><reference type="cover|toc|text|..."/></guide>`
- 常用于：
  - 找 cover 页、正文起点、toc 页等
- 你的渲染器应读取并用于“增强定位”，但不要依赖它（可能缺失/错误）。

#### 1.3.5 bindings（已废弃，但需解析/保留扩展点）
- 用于给非支持 media-type 指定自定义 handler。
- 现实里少见，但如果出现：
  - 至少要解析并暴露给上层扩展机制（插件/回调）
  - 默认可降级为“提示不可渲染 + 打开 fallback”

---

### 1.4 内容文档与资源类型（Content Plane）
EPUB 的内容文档本质上是：
- XHTML（application/xhtml+xml，XML 语法的 HTML）
- SVG（image/svg+xml）作为内容文档
- CSS、字体、图片、音频等资源
- 可能包含脚本（JS）、表单、iframe、媒体元素等

#### 1.4.1 XHTML Content Documents
- EPUB3 要求 XHTML 用 XML 语法；现实里可能有不严格 XML 的“伪 XHTML/HTML”：
  - **渲染目标是“不遗漏内容”** → 推荐用 HTML5 宽容解析作为 fallback
- 需要正确处理：
  - `<img>`, `<picture>`, `<svg>` 内嵌
  - `<audio>/<video>/<source>` 的 intrinsic fallback
  - `<math>`/MathML（引擎不支持则需要 fallback 或提示）
  - `<a href="#...">`、跨文档链接与 fragment
  - `epub:type` 语义标注（landmarks、结构语义等）

#### 1.4.2 SVG Content Documents
- SVG 可以作为 spine item（整页矢量/漫画等）
- 可能嵌入图片、字体、脚本（取决于引擎能力/策略）

#### 1.4.3 Navigation Document（EPUB3）
- 这是一个特殊 XHTML 文档（manifest item `properties` 含 `nav`）
- 内含多个 `<nav epub:type="...">`：
  - toc（目录）
  - landmarks（地标：cover、bodymatter、toc 等）
  - page-list（纸质页码映射；可能用 `#epubcfi(...)`）
  - 其他 nav（loi/lot/index 等）
- 渲染器要做两件事：
  1) 解析 nav，生成结构化 TOC/landmarks/pageList
  2) nav 文档本身也必须能渲染（用户可以“看到目录页”）

#### 1.4.4 NCX（EPUB2）
- `application/x-dtbncx+xml`
- 结构：`<ncx><navMap><navPoint>...` 等
- 你应把它转换成与 EPUB3 nav 同构的数据模型（TOC Tree）

#### 1.4.5 Media Overlays（EPUB3，SMIL）
- SMIL 文档（media-type `application/smil+xml`）
- OPF manifest item（内容文档）通过 `media-overlay="smilItemId"` 关联
- 需要支持：
  - par/seq 结构
  - text/src 指向内容片段，audio/src 指向音频片段（可带 clipBegin/clipEnd）
  - 包级 metadata 的 `media:active-class` 与 `media:playback-active-class`（播放高亮）

---

### 1.5 固定版式、滚动卷轴与渲染提示（Rendering Hints）
EPUB3/3.3 固定版式常见：
- `rendition:layout` = `pre-paginated` / `reflowable`
- `rendition:orientation` = landscape/portrait/auto
- `rendition:spread` 与 spine item 的 page-spread 属性（left/right/center）
- 固定版式尺寸：内容文档 head 中 `meta name="viewport" content="width=...,height=..."`（需按规范解析）
- reflowable 的溢出/分页偏好：`rendition:flow`（paginated/scrolled-*）

EPUB3.4 新增（前向兼容）：
- `rendition:layout` = `roll`：把每个固定版式 spine item 适配宽度后连续纵向“卷轴式”显示（无页间空隙）
- AVIF（`image/avif`）作为核心图片类型（仍建议有 fallback）

---

### 1.6 加密/混淆与 DRM（必须能识别并处理）
- `META-INF/encryption.xml` 可能声明：
  - 字体混淆（常见，需支持解混淆，否则字体缺失导致“看起来内容不全”）
  - DRM/强加密（一般无法通用解密）
- 渲染器策略：
  - 对可解混淆算法：实现并在资源加载时解混淆
  - 对不可解密算法：标记资源为“不可访问”，并触发 fallback 或 UI 提示

---

## 2. 技术架构设计（面向“不遗漏”的工程化拆分）

### 2.1 模块划分
1) `ZipContainerReader`
   - 以“随机访问 + 流式解压”为核心
   - 输出：`entryIndex`（path → entry metadata + readStream）

2) `OcfParser`
   - 读取 `/mimetype`（宽容）
   - 读取 `/META-INF/container.xml`
   - 读取可选 `META-INF/*`（encryption/metadata/rights/signatures/manifest）
   - 输出：`Rootfiles[]` + `ContainerMeta`

3) `PackageParser`（OPF 2 + OPF 3 通吃）
   - 输入：某个 rootfile 的 OPF bytes
   - 输出：`PackageModel`：
     - metadata（含 prefix 解析后的 property）
     - manifest（items + properties + fallback graph）
     - spine（readingOrder + linear/no + spread/layout overrides）
     - navRef / ncxRef / guide
     - collection/bindings（保留）

4) `EpubResourceResolver`
   - 输入：container + package + policy
   - 能力：
     - URL → bytes + content-type（含解混淆）
     - out-of-container 防护
     - remote 资源策略（允许/拦截/代理）
     - MIME 嗅探与纠错（可配置）
     - 缓存（内存/磁盘）

5) `EpubAudit`（强烈推荐）
   - 输出：`CoverageReport`
     - spine 覆盖率（每个 item 是否可加载/是否被加密/是否缺 fallback）
     - nav 覆盖率（TOC 指向目标是否存在）
     - 资源可达性（从 spine/ncx/nav 深度遍历链接与资源引用，找“引用了但找不到”的、以及“存在但永远不可达”的）
     - 策略拦截统计（remote/script/file/url escape）

6) `EpubRenderer`
   - 基于 Web 引擎（Chromium/WebKit/系统 WebView）或自研排版引擎
   - 负责：
     - 用自定义 scheme（如 `epub://bookId/...`）加载文档
     - 注入 user stylesheet（字号/主题/边距）
     - 分页与翻页（reflowable / pre-paginated / roll）
     - 目录/地标/页码导航
     - media overlays（可选）

---

## 3. 关键数据模型（建议直接照此实现，避免遗漏字段）

### 3.1 Container / OCF
```ts
type EpubContainer = {
  id: string,                      // 内部生成（可用 OPF unique-id）
  entries: Map<string, ZipEntry>,   // 规范路径 → entry
  metaInf: {
    containerXmlPath: "META-INF/container.xml",
    encryptionXmlPath?: string,
    signaturesXmlPath?: string,
    rightsXmlPath?: string,
    metadataXmlPath?: string,
    manifestXmlPath?: string,
  },
  rootfiles: Rootfile[],
}

type Rootfile = {
  fullPath: string, // 相对 root dir
  mediaType: "application/oebps-package+xml",
  // multiple-rendition 选择属性（可能出现在 rootfile 上）
  rendition?: {
    media?: string,
    layout?: string,
    language?: string,
    accessMode?: string,
    label?: string,
  }
}
````

### 3.2 Package / OPF

```ts
type PackageModel = {
  version: string,                     // "2.0" / "3.0" / "3.3" / "3.4" 等
  uniqueIdentifierId?: string,          // <package unique-identifier="...">
  identifiers: DcIdentifier[],          // dc:identifier 列表
  primaryIdentifier?: string,           // 由 uniqueIdentifierId 解引用得到（用于混淆 key）
  metadata: PackageMetadata,            // 结构化 & 原始保留
  manifest: Map<string, ManifestItem>,  // id → item
  spine: SpineModel,
  guide?: GuideModel,                  // EPUB2
  nav?: NavRef,                        // EPUB3
  ncx?: NcxRef,                        // EPUB2/兼容
  bindings?: BindingsModel,            // deprecated
  collections?: CollectionModel[],     // 可选
  opfPath: string,                     // OPF 自身路径
  opfDir: string,                      // OPF 所在目录（用于 href resolve）
}

type ManifestItem = {
  id: string,
  href: string,               // 原始 href
  resolvedPath?: string,      // 解析后（相对 root）的规范路径；remote 则为空
  mediaType?: string,         // 原始声明，可缺失/错误
  properties: Set<string>,    // 解析后的 tokens（含自定义词表，必须保留）
  fallback?: string,          // fallback item id
  mediaOverlay?: string,      // smil item id
  isRemote: boolean,          // href 是否为绝对 URL
}

type SpineModel = {
  pageProgressionDirection: "ltr"|"rtl"|"default"|"unknown",
  toc?: string, // EPUB2: spine@toc = manifest item id (NCX)
  items: SpineItemRef[],
  // 计算得到：
  linearReadingOrder: SpineItemRef[],    // linear!=no 的顺序
  nonLinearItems: SpineItemRef[],        // linear=no
  resolvedReadingOrder: ResolvedSpineItem[], // 结合 manifest fallback、支持能力后的最终可渲染顺序
}

type SpineItemRef = {
  idref: string,              // 对应 manifest item id
  linear: boolean,            // default true
  properties: Set<string>,    // rendition:* / page-spread-* 等
}
```

### 3.3 Navigation（统一 TOC 模型）

```ts
type NavTree = {
  toc: NavNode[],
  landmarks?: NavNode[],
  pageList?: NavNode[],       // 可能包含 epubcfi fragment
  others: Record<string, NavNode[]>, // loi/lot/index 等
}

type NavNode = {
  label: string,
  href?: string,              // 可能是相对路径 + fragment；也可能是 epubcfi
  children: NavNode[],
}
```

---

## 4. 解析流程（逐步处理 + 关键容错点）

### 4.1 解包与索引（ZipContainerReader）

**必须**做到：

* 不把所有文件一次性解压到磁盘（避免大书/压缩炸弹）
* 对 entry 名称做安全检查（拒绝 `../`、绝对路径、驱动器前缀等）
* 建立 `entries` 索引：`normalizedPath → entry`

**路径规范化建议（非常关键）**：

* 使用 `/` 作为统一分隔符（ZIP 内一般如此）
* 对 `.` 与 `..` 进行规范化，得到 `canonicalPath`
* canonicalPath 若逃逸 root（变成空或上溯）→ 标记为 out-of-container（拒绝）
* 保留原始大小写（规范是大小写敏感），但为了兼容：

  * 可额外建立一个 `foldedIndex`：对路径做 Unicode NFC + casefold 后映射到真实路径（用于“猜测性修复”）
  * 若 foldedIndex 出现冲突（多个真实路径映射到同一个 folded key）→ 不做自动修复，输出诊断

### 4.2 验证最小结构

* 若 `META-INF/container.xml` 不存在：

  * fallback：扫描 ZIP 寻找 `.opf`（或 `application/oebps-package+xml` 特征），选第一个作为 rootfile，并把该 EPUB 标记为“结构不合规但可尝试打开”
* `mimetype` 不合规也不要拒绝（现实里大量如此），但要记录 warning

### 4.3 解析 container.xml（OcfParser）

* XML 解析必须禁用外部实体、DTD 外部引用（安全 & 规范）
* 读取所有 `rootfile`：

  * 过滤：`media-type == application/oebps-package+xml`
  * 校验 full-path 存在且不在 META-INF 内（真实世界可能错 → 宽容但标记）
* 多 rootfile 选择策略：

  * 默认：选第一个为 default rendition（最兼容）
  * 若检测到 multiple-rendition 属性/metadata.xml：

    * 按设备特征与用户偏好打分选最优（language/layout/media 等）
    * 但仍保留所有 rootfile，用于“切换 rendition”或诊断

### 4.4 解析 OPF（PackageParser）

#### 4.4.1 OPF 版本分流

* `package@version`：

  * `2.0`/`2.0.1` → EPUB2 模式
  * `3.x` → EPUB3 模式（3.3/3.4 只是在词表与渲染提示上增量）

#### 4.4.2 href 解析规则（必须统一）

对 OPF 内 `manifest@href`、`metadata<link>@href` 等：

* base = OPF 文档所在目录
* 解析为：

  * 若为绝对 URL（含 scheme）→ `isRemote=true`
  * 否则 → `resolvedPath = normalize(opfDir + href)`，并做 out-of-container 检查
* **容错**：

  * 如果 href 以 `/` 开头（path-absolute，规范不推荐但现实会出现）：

    * 兼容策略 A：把它当作 root-relative（从容器根解析）
    * 兼容策略 B：把它当作 opfDir-relative（某些制书工具误用）
    * 建议：同时尝试 A/B，若其中一个存在则采用，并记录“修复来源”

#### 4.4.3 manifest fallback 链（防遗漏的核心）

你需要计算 `effectiveRenderableItem(id)`：

1. 若 item 是 XHTML/SVG 内容文档且引擎支持 → OK
2. 若 item 是“外来内容文档”（如直接把 jpeg 放进 spine）：

   * 必须沿 `fallback` 链找到至少一个 XHTML/SVG 内容文档（或引擎可直接渲染的）
3. 若 fallback 链循环/断裂 → 标记为错误，并在 UI/诊断中暴露（否则会“漏页”）

**实现建议：**

* 建图：`id -> fallbackId`
* DFS 找到首个“可渲染类型”
* 记录链路：用于 debug 与报告

#### 4.4.4 spine 解析与阅读顺序构建

* 读取 `page-progression-direction`（用于 RTL/翻页）
* 构建：

  * `linearReadingOrder`
  * `nonLinearItems`
* 生成 `resolvedReadingOrder`：

  * 对每个 spine itemref，计算其最终可渲染目标（考虑 fallback）
  * 如果最终仍不可渲染（加密/缺失）→ 插入占位“错误页”（不可悄悄跳过，否则就是遗漏）

#### 4.4.5 封面定位（不要漏封面）

优先级建议：

1. EPUB3：manifest item `properties` 含 `cover-image`
2. EPUB2：`<meta name="cover" content="id">` 指向 manifest item
3. guide：`reference@type="cover"` 指向某内容页
4. 资源启发：文件名/路径含 cover + 图片类型
5. fallback：用第一篇 spine 内容的首图/首屏作为“无明示封面”的封面

所有规则都要记录“命中来源”，便于诊断不同书的差异。

### 4.5 解析导航（Nav / NCX / 回退生成）

* EPUB3：优先 manifest item `properties` 含 `nav`

  * 解析 XHTML：

    * 找 `<nav epub:type="toc">` → TOC
    * `<nav epub:type="landmarks">` → 地标
    * `<nav epub:type="page-list">` → 页码映射（可能含 `#epubcfi(...)`）
* 若无 nav：用 NCX

  * EPUB2：spine@toc 指向 NCX；否则在 manifest 中找 `application/x-dtbncx+xml`
* 若仍无：

  * 回退生成 TOC：

    * 每个 spine item 用 `<title>` 或第一个 h1/h2 或文件名
    * 保留层级：可按文件内 heading 生成二级目录（可选）
    * nonLinearItems 放到“附录/补充内容”分组

### 4.6 encryption.xml：解混淆与加密识别

* 解析 `META-INF/encryption.xml`：

  * 建映射：`resourcePath -> algorithm`
* 对已知字体混淆算法：

  * 在 resolver 返回 bytes 前进行“解混淆”
* 对未知/DRM 算法：

  * 标记资源为 encrypted，触发 fallback；无 fallback 则明确提示“受 DRM/加密保护不可渲染”

---

## 5. 资源解析与渲染（保证“不漏资源”的关键）

### 5.1 统一资源加载：自定义 scheme + 拦截器

建议实现：

* 所有文档加载 URL 统一为：`epub://<bookId>/<path>`
* Web 引擎资源请求由你的 `EpubResourceResolver` 拦截：

  * 解析 URL → bytes/content-type
  * 处理解混淆、缓存、远程策略
  * 阻断 out-of-container 与 file://

这样能保证：

* 相对引用（图片/CSS/字体）都可正确加载
* 即使 manifest 缺失某资源，只要文件存在且被引用，也能加载（避免“书里图没了”）

### 5.2 content-type 与编码（容错必备）

* 优先用 manifest 声明的 media-type
* 若缺失/明显错误：

  * 根据扩展名 + 魔数嗅探（png/jpg/gif/webp/avif/ttf/otf/woff/woff2/mp3/mp4/ogg 等）
  * XHTML 若 XML 不可解析：作为 text/html 宽容加载
* 输出诊断：列出“声明类型 vs 嗅探类型”的差异（很多真实 EPUB 靠这个才能不漏）

### 5.3 远程资源（remote）策略（完整性 vs 安全/离线）

规范允许某些资源类型（音频/视频/脚本拉取/字体）是 remote，但现实里会滥用。
建议给渲染器一个显式策略：

* `NetworkPolicy = { allowRemote: boolean, allowInsecureHttp: boolean, cache: ... }`
* 默认：`allowRemote=false`（安全与离线一致性）
* 若禁用 remote：

  * 对关键资源（如音频旁白）显示占位与提示
  * 对图片 remote：尽量依靠 intrinsic fallback（picture/source）或 manifest fallback，否则提示“远程资源被禁用”

### 5.4 脚本与交互（完整性 vs 风险）

两类脚本语境（EPUB3）：

* container-constrained：在 iframe 内
* spine-level：顶层内容文档内
  建议策略化：
* `ScriptingPolicy = { enable: boolean, allowTopLevel: boolean, allowIFrame: boolean, allowNetworkFetchFromScript: boolean }`
* 若禁用脚本：

  * 不要跳过该文档；仍渲染静态 DOM
  * 对需脚本生成的内容，通过 manifest fallback 或显式提示“交互内容被禁用”

### 5.5 三种渲染模式

#### 5.5.1 Reflowable（可重排）

* 以 CSS 适配用户设置：

  * font-size / font-family / line-height / theme / margins
* 分页/滚动：

  * `rendition:flow` 为提示（paginated/scrolled-continuous/scrolled-doc）
  * 允许用户覆盖（阅读体验比作者提示更重要）

#### 5.5.2 Fixed Layout（pre-paginated）

* 解析 viewport meta 的 width/height
* 缩放适配屏幕，保持纵横比
* 支持 synthetic spread：

  * 结合 `rendition:spread`（全局）与 itemref 属性（spread/page-spread-left/right/center）
  * 结合 RTL/LTR 决定左右页的先后
* 通常限制用户样式注入（否则版式崩），但可以提供“最小无破坏性”选项（如背景色）

#### 5.5.3 Roll（EPUB 3.4，前向兼容）

* 若检测 `rendition:layout = roll`：

  * 每个 spine item 必须是固定版式（按规范）
  * 将每页适配宽度后，纵向连续排列（无间隙）
  * 性能：虚拟列表/懒加载（只渲染可视附近）

---

## 6. “不遗漏”专项：资源可达性审计（EpubAudit）

### 6.1 为什么必须做审计

很多“漏内容”不是渲染器 bug，而是：

* OPF spine 漏列
* TOC 指向不存在
* 图片/字体路径大小写不一致
* manifest media-type 错导致引擎拒绝
* 资源被加密或 remote 被策略拦截
* out-of-container 被你正确拦截但书本依赖该错误路径

如果没有审计，你只能靠用户反馈“某一页图没了”，很难规模化解决。

### 6.2 审计输出（建议）

`CoverageReport` 至少包含：

* `spineItems`：

  * idref → resolved target → 是否可加载 → 失败原因（missing/encrypted/blocked/unsupported）
* `navTargets`：

  * toc/landmarks/page-list 中每个 href 的解析结果（存在/缺失/跳转循环）
* `referencedResources`：

  * 从每个 spine 文档解析 DOM，收集：

    * img/src, source/srcset, link/href, script/src, audio/video/source, object/data, iframe/src, svg image/href 等
  * 逐个 resolve 是否存在/可加载
* `orphanResources`：

  * 容器中存在但永远不可达的资源（可能是垃圾，也可能是漏链接）
* `policyBlocks`：

  * 远程资源被禁用数量、file:// 被拒数量、out-of-container 被拒数量

---

## 7. 单元测试规划（尽可能覆盖所有场景）

> 核心原则：测试不是只测“规范 happy path”，而是要覆盖真实世界的“脏 EPUB”。

### 7.1 测试体系结构

1. **纯单元测试（不依赖 UI/Web 引擎）**

   * OCF/OPF/Nav/NCX/Encryption 解析
   * URL resolve 与 out-of-container 检测
   * fallback chain 解析
   * cover 检测
   * viewport meta 解析
   * 资源嗅探与 content-type 决策
2. **带资源加载的单元测试（Resolver 层）**

   * zip 内资源读取、缓存、解混淆
   * remote 策略与占位
3. **渲染集成测试（可选但强烈推荐）**

   * headless WebView/Chromium：加载 spine 文档，断言关键 DOM 节点/资源请求发生
   * 固定版式：截图对比（允许一定阈值）
4. **Fuzz / property-based**

   * XML/HTML 轻量 fuzz（避免崩溃）
   * 路径组合 fuzz（确保无穿越）

### 7.2 Fixture 生成策略（建议自动化生成 EPUB）

为了覆盖多场景，建议实现一个 `EpubFixtureBuilder`：

* 输入：文件树 + container.xml + opf + xhtml/svg/nav/ncx/encryption 等模板片段
* 输出：内存中的 .epub bytes（ZIP）
  这样你可以用代码组合出几十/上百种变体，而不是手工维护一堆静态样本。

### 7.3 必测用例清单（按模块）

#### A. OCF/ZIP 层

1. mimetype：

   * 正确：首条目 + 不压缩
   * 错误：不在首位 / 被压缩 / 内容不对（仍应能打开但报警）
2. container.xml：

   * 正常存在
   * 缺失（应 fallback 扫描 opf）
   * XML 非法（应报错但不崩）
3. 路径安全：

   * ZIP entry 包含 `../evil`（必须拒绝）
   * entry 名包含反斜杠、奇怪编码（容错 + 安全）
4. Unicode 文件名：

   * NFC/NFD 组合、大小写差异
   * 同目录下折叠冲突（必须诊断）

#### B. container.xml / 多 rootfile / multiple-rendition

1. 单 rootfile（标准）
2. 多 rootfile（同版本 OPF）：

   * 默认取第一个
   * 有 rendition:* 属性时按策略选择
3. rootfile 指向不存在路径（报错 + 尝试其他 rootfile）
4. container.xml `<links>` 存在/不存在（至少解析不丢）

#### C. OPF 解析（EPUB2/EPUB3）

1. OPF2：

   * metadata/manifest/spine/guide 基本字段
   * spine@toc 指向 NCX
   * meta name="cover"
2. OPF3：

   * manifest item properties=nav/cover-image/scripted/remote-resources
   * metadata `<meta property>` + prefix + refines
   * collection/bindings（解析不丢）
3. media-type 缺失/错误：

   * XHTML 误写 text/html
   * 图片 media-type 写错（png 写成 jpeg）
   * 断言嗅探策略生效

#### D. manifest fallback 链（防遗漏关键）

1. spine item 直接是 image/jpeg（foreign content doc）：

   * 必须有 fallback 到 XHTML/SVG
2. fallback 链多级：

   * A → B → C（选择首个可渲染）
3. fallback 链循环：

   * A → B → A（必须检测并报错，不可死循环）
4. fallback 缺失：

   * A → (missing)（必须报错 + 插入占位页）

#### E. spine 与阅读顺序

1. linear 默认 true
2. linear=no：

   * 不进入默认阅读流，但可通过 nav/链接打开
   * 审计中应标记为 non-linear
3. page-progression-direction：

   * ltr/rtl/default
4. fixed-layout overrides：

   * itemref properties: rendition:layout-pre-paginated / rendition:layout-reflowable
   * spread/page-spread-left/right/center 的组合

#### F. 导航（Nav/NCX/回退生成）

1. EPUB3 nav.xhtml：

   * toc/landmarks/page-list 都存在
   * 嵌套多层 ol/li
   * href 含 fragment
   * page-list 含 epubcfi fragment（至少能存储并传递）
2. EPUB2 NCX：

   * 多层 navPoint
   * content@src 含 fragment
3. 无 nav 无 ncx：

   * 生成 TOC（按 spine + title/heading）

#### G. 资源解析与 out-of-container

1. 相对路径解析：

   * `../images/a.png`（在容器内合法）
2. out-of-container：

   * `../../secret.txt`（必须拒绝）
3. path-absolute：

   * `/images/a.png`（按兼容策略 A/B 探测）
4. base 改写：

   * HTML `<base href="...">`（引擎处理；你的自定义 scheme 也要能工作）

#### H. encryption.xml 与字体混淆

1. 存在 encryption.xml 且声明字体混淆：

   * 解混淆后字体可用（可用 hash 或渲染截图/字体度量断言）
2. 声明未知算法（DRM）：

   * 资源标记 encrypted，触发 fallback 或提示
3. encryption.xml 缺失但资源实际被混淆（现实偶发）：

   * 可选启发式：检测字体头部异常并尝试常见混淆（谨慎，需开关）

#### I. 固定版式 viewport meta 解析

1. `content="width=1200,height=900"`
2. 带空格/逗号/分号分隔的各种写法
3. width/height 重复声明（按规范应拒绝或取第一个并报警）
4. 缺 width/height（固定版式无法正确适配 → 明确提示）

#### J. Roll 布局（EPUB 3.4 前向兼容）

1. rendition:layout=roll：

   * spine items 全是固定版式（否则报错/降级）
2. 资源类型包含 image/avif：

   * 引擎支持则直接渲染
   * 不支持则必须走 fallback（manifest fallback）

#### K. 脚本与远程资源策略

1. scripted 文档在脚本禁用时仍应显示静态内容
2. remote 资源禁用时：

   * 阻断并统计
   * 若存在 intrinsic fallback，应能显示 fallback
3. file:// 引用：

   * 必须拒绝，并输出诊断

#### L. “不崩溃”健壮性测试

1. container.xml / opf / nav / ncx XML 非法输入（fuzz）
2. XHTML 非法（缺闭合标签、错误命名空间）
3. 超大图片/超长路径（资源上限策略）
4. ZIP bomb（压缩比异常、解压大小超限）

---

## 8. 与官方测试/校验生态对齐（强烈建议纳入 CI）

1. 引入 W3C `epub-tests`：

   * 作为“规范覆盖”的基线（不是全部现实世界，但能保证你没漏实现关键 MUST/SHOULD）
2. 引入 `EPUBCheck`：

   * 作为 fixture 的校验器（对“合规样本”应无 error）
   * 对“不合规但要兼容”的样本，记录预期 warning，并确保渲染器仍能读

---

## 9. 交付验收清单（给你自己/给 AI 的 Done Definition）

1. 能打开并渲染：

   * EPUB2（含 NCX + guide）
   * EPUB3（含 nav）
   * 固定版式（pre-paginated）
2. 任意 spine item 不可渲染时：

   * 不可静默跳过；必须有占位/提示 + 日志
3. 资源引用缺失：

   * audit 能列出“缺失资源列表 + 来源文档 + 引用位置”
4. out-of-container/file://：

   * 必须拦截且可定位
5. 字体混淆：

   * 至少支持 IDPF 算法；（可选）支持 Adobe 算法
6. 单元测试覆盖：

   * 解析、fallback、URL、导航、加密识别、固定版式 viewport、策略拦截等均有对应测试

---

## 10. 规范链接（建议随实现提示一起发给 AI）

* EPUB 3.3 (W3C Recommendation): [https://www.w3.org/TR/epub-33/](https://www.w3.org/TR/epub-33/)
* EPUB Reading Systems 3.3: [https://www.w3.org/TR/epub-rs-33/](https://www.w3.org/TR/epub-rs-33/)
* EPUB 3.4 (Working Draft): [https://www.w3.org/TR/epub-34/](https://www.w3.org/TR/epub-34/)
* EPUB Multiple-Rendition Publications 1.1 (Group Note): [https://www.w3.org/TR/epub-multi-rend-11/](https://www.w3.org/TR/epub-multi-rend-11/)
* EPUB 2 OPF (IDPF): [https://idpf.org/epub/20/spec/OPF_2.0_final_spec.html](https://idpf.org/epub/20/spec/OPF_2.0_final_spec.html)
* W3C EPUB tests repo: [https://github.com/w3c/epub-tests](https://github.com/w3c/epub-tests)
* EPUBCheck: [https://github.com/w3c/epubcheck](https://github.com/w3c/epubcheck)

（完）

```

**规范与官方工具引用（用于你对照实现/写测试时的权威来源）**：EPUB 3.3 核心规范（含 OCF/Package/Content/Nav/Media Overlays 等）。:contentReference[oaicite:1]{index=1}  
EPUB 3.4 工作草案（包含 roll 布局、AVIF 核心图片类型等前向兼容点）。:contentReference[oaicite:2]{index=2}  
Multiple-Rendition（多 rootfile / metadata.xml / rendition 选择与映射）。:contentReference[oaicite:3]{index=3}  
Reading Systems 3.3（渲染系统侧的处理要求与能力约束）。:contentReference[oaicite:4]{index=4}  
W3C 官方 epub-tests（覆盖规范中的 MUST/SHOULD 测试资产）。:contentReference[oaicite:5]{index=5}  
EPUBCheck（官方一致性检查工具，适合纳入 CI）。:contentReference[oaicite:6]{index=6}
::contentReference[oaicite:7]{index=7}
```

[1]: https://www.w3.org/TR/epub-33/ "https://www.w3.org/TR/epub-33/"
