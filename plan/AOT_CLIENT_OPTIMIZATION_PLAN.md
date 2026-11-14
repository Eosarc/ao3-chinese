# AOT 客户端解析引擎与 `=` 语法演进优化方案

> **状态**：待规划 / 暂缓实施（储备方案）  
> **归档路径**：`plan/AOT_CLIENT_OPTIMIZATION_PLAN.md`  
> **针对版本**：AOT 客户端后续发版（1.10.3+）

---

## 一、 背景与当前痛点

在当前 AOT 客户端（`1.10.2`）的术语表解析与执行链条中，存在两处相互踩脚的历史遗留设计：

1. **`processEqualsSyntax` 引号硬拦截**：
   ```javascript
   function processEqualsSyntax(term, translation, ctx, glossaryIndex, sourceName, isSensitive) {
       tryAddRule(term, translation, ctx, glossaryIndex, sourceName, isSensitive, false, false, true);
       if (term.match(/^["“‘'](.*)["”’']$/)) return; // 👈 只要有引号，一律终止拆分！
       ...
   }
   ```
   **痛点**：该逻辑原本假定“用户加双引号表示希望整体精确匹配，不希望拆分名和姓”。但与此同时，由于旧规范一刀切要求“包含标点的词条必须加双引号”，导致带有缩写点的人名（如 `"J.J. Boiziau" = J.J. 博伊佐`）或连字符人名一旦加上双引号，**子词拆分逻辑被彻底阉割**，等号语法直接退化为普通的冒号。

2. **`parseGlossaryKeyValuePair` 单引号状态机死锁**：
   ```javascript
   const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };
   ```
   **痛点**：ASCII 直单引号 `'` 被注册为开引号。当词条包含英语缩写/所有格中的撇号（如 `O'Connor: 奥康纳`、`Collector's: 典藏版`）且未用双引号包裹时，解析器进入 `inQuote = true` 状态并在行内不断寻找下一个闭引号，从而跳过分隔符 `:` 或 `=`。扫描结束仍为 `splitIndex === -1`，导致**整行词条被判定为“无法定位分隔符”而静默丢弃（Dropped）**。

---

## 二、 客户端底层优化调整方案

### 优化 1：解绑 `processEqualsSyntax` 中的引号死锁

#### 目标
使加了引号的词条也能正常享受 `=` 的名和姓自动拆分能力。双引号只代表“精准字面量匹配”，不再剥夺子规则拆分权。

#### 建议代码改造
```javascript
function processEqualsSyntax(term, translation, ctx, glossaryIndex, sourceName, isSensitive) {
    // 1. 注册整体规则
    tryAddRule(term, translation, ctx, glossaryIndex, sourceName, isSensitive, false, false, true);
    
    // 2. 先剥离外层成对引号，提取纯净词条进行分词
    const cleanTerm = smartUnquote(term);
    const cleanTrans = smartUnquote(translation);
    
    // 3. 按分隔符分词
    const termParts = smartSplit(cleanTerm, TERM_SEPARATOR_RE);
    const transParts = smartSplit(cleanTrans, TRANSLATION_SEPARATOR_RE);
    
    // 4. 只要分段数量对齐且大于 1，无论外层是否有引号，均正常生成子词规则
    if (termParts.length > 1 && termParts.length === transParts.length) {
        for (let i = 0; i < termParts.length; i++) {
            tryAddRule(termParts[i], transParts[i], ctx, glossaryIndex, sourceName, isSensitive, false, false, false);
        }
    }
}
```

---

### 优化 2：撇号上下文感知（Apostrophe Context-Aware Parsing）

#### 目标
从根本上消除“`O'Connor` 不加双引号直接被丢弃”的致命隐患，无需强制用户加双引号也能安全解析。

#### 建议代码改造
在 `parseGlossaryKeyValuePair` 中扫描单引号 `'` 时，增加上下文感知判定：
```javascript
if (char === "'" || char === "‘") {
    // 检查是否为单词内部的缩写撇号（前后均紧邻字母，如 O'Connor, don't, rock 'n' roll）
    const prevChar = i > 0 ? rawChars[i - 1] : '';
    const nextChar = i + 1 < rawChars.length ? rawChars[i + 1] : '';
    const isWordInternalApostrophe = /[a-zA-Z]/.test(prevChar) && /[a-zA-Z]/.test(nextChar);

    if (!isWordInternalApostrophe) {
        // 只有非单词内部的独立单引号，才切换 inQuote 状态
        inQuote = true;
        expectedCloseQuote = quotePairs[char];
    }
}
```
**收益**：自然兼容英文世界海量带撇号人名与专有名词，使词法分析器具备现代编译器的上下文容错能力。

---

### 优化 3：单词末尾缩写点的正则词边界补齐

#### 目标
修复单单词词尾带点（如 `Dr.`、`vs.`、`Inc.`）在 `isLiteral` 正则分支中右侧缺失 `\b` 单词边界的问题。

#### 建议代码改造
```javascript
// 原逻辑：/[a-zA-Z0-9]$/.test(normalizedTerm) ? '\\b' : '';
// 优化：若以字母结尾，或以 [点号] 结尾但前面是字母，均追加严格词边界检测
const suffix = /[a-zA-Z0-9]$/.test(normalizedTerm)
    ? '\\b'
    : (/[a-zA-Z]\.$/.test(normalizedTerm) ? '(?=[\\s,，.。!！?？:：;；"\'”’]|$)' : '');
```

---

## 三、 实施计划与版本规划

| 阶段 | 任务项 | 预计版本 | 风险与测试重点 |
| :--- | :--- | :--- | :--- |
| **阶段 1（前置生态保障）** | 在 `glossary-linter.mjs` 中放宽标点白名单，最佳体验版主动去除豁免标点的外层引号 | 即刻生效 | 零风险，完全兼容现存各版本客户端 |
| **阶段 2（客户端测试）** | 在开发分支中引入 `processEqualsSyntax` 剥离引号拆分与单引号上下文感知 | 1.10.3-beta | 需针对 `O'Connor`、`"J.J. Boiziau" = ...`、`Rock 'n' Roll` 进行回归测试 |
| **阶段 3（正式发版）** | 正式合入发布版本，更新文档站相关说明 | 1.10.3 正式版 | 客户端完全免除用户加引号的心智负担 |
