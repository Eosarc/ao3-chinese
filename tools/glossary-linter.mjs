#!/usr/bin/env node

/**
 * Aria - AO3 Translator 在线术语表智能审查与质检内核
 * 深度对齐《术语表编写指南》与 AOT 客户端离线解析器规则
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };
const TERM_SEPARATOR_RE = /[\s-－﹣—–]+/;
const TRANSLATION_SEPARATOR_RE = /[\s·・]+/;
const RESIDUAL_SEP_RE = /[=＝:：]/;
const BRACKET_DEPTH_MAP = {
  '(': 1, ')': -1, '[': 1, ']': -1, '{': 1, '}': -1,
  '（': 1, '）': -1, '【': 1, '】': -1, '「': 1, '」': -1
};

const SECTION_HEADERS = {
  TERMS: ['terms', '词条'],
  GENERAL_TERMS: ['general terms', '通用词条'],
  FORBIDDEN_TERMS: ['forbidden terms', '禁翻词条'],
  REGEX_TERMS: ['regex', 'regex_terms', '正则表达式']
};

/**
 * 安全解析键值对（复刻客户端 parseGlossaryKeyValuePair 算法）
 */
export function parseGlossaryKeyValuePair(entry) {
  if (!entry) return null;
  let inQuote = false;
  let expectedCloseQuote = '';
  let splitIndex = -1;
  let separator = '';

  const rawChars = entry.split('');
  for (let i = 0; i < rawChars.length; i++) {
    const char = rawChars[i];
    if (inQuote) {
      if (char === expectedCloseQuote) {
        let nextNonSpaceChar = null;
        for (let k = i + 1; k < rawChars.length; k++) {
          if (!/\s/.test(rawChars[k])) {
            nextNonSpaceChar = rawChars[k];
            break;
          }
        }
        const isSeparator =
          nextNonSpaceChar === ':' ||
          nextNonSpaceChar === '：' ||
          nextNonSpaceChar === '=' ||
          nextNonSpaceChar === '＝';
        if (isSeparator) {
          inQuote = false;
        }
      }
    } else {
      if (QUOTE_PAIRS.hasOwnProperty(char)) {
        inQuote = true;
        expectedCloseQuote = QUOTE_PAIRS[char];
      } else {
        if (char === ':' || char === '：') {
          splitIndex = i;
          separator = ':';
          break;
        }
        if (char === '=' || char === '＝') {
          splitIndex = i;
          separator = '=';
          break;
        }
      }
    }
  }

  if (splitIndex === -1) return null;
  const key = entry.substring(0, splitIndex).trim();
  const value = entry.substring(splitIndex + 1).trim();
  return { key, value, separator };
}

/**
 * 检测整行被引号包裹的错误写法
 */
export function isWholeLineQuotedWithSeparator(entry) {
  if (!entry || entry.length < 2) return null;
  const first = entry[0];
  const last = entry[entry.length - 1];
  if (typeof QUOTE_PAIRS[first] !== 'string') return null;
  if (QUOTE_PAIRS[first] !== last) return null;
  const inner = entry.slice(1, -1);
  const parsed = parseGlossaryKeyValuePair(inner);
  if (!parsed) return null;
  return { key: first + parsed.key + last, value: parsed.value };
}

/**
 * 译文中是否有残留的顶层未闭合分隔符
 */
export function hasTopLevelResidualSeparator(value) {
  if (!value) return false;
  let depth = 0;
  let inQuote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (QUOTE_PAIRS[ch]) {
      inQuote = QUOTE_PAIRS[ch];
      continue;
    }
    const delta = BRACKET_DEPTH_MAP[ch];
    if (delta) {
      depth += delta;
      continue;
    }
    if (depth <= 0 && RESIDUAL_SEP_RE.test(ch)) return true;
  }
  return false;
}

/**
 * 版本号大小比较
 */
export function compareVersions(v1, v2) {
  const cleanV1 = String(v1 || '').replace(/[^\d.]/g, '');
  const cleanV2 = String(v2 || '').replace(/[^\d.]/g, '');
  const parts1 = cleanV1.split('.').map(Number);
  const parts2 = cleanV2.split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * 引号感知分词
 */
export function smartSplit(str, regex) {
  const quoteRe = /["“‘'”’]/;
  if (!quoteRe.test(str)) return str.split(regex);
  const parts = [];
  let current = '';
  let inQuote = false;
  let currentQuote = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (quoteRe.test(char)) {
      if (!inQuote) {
        inQuote = true;
        currentQuote = char;
      } else if (char === currentQuote || (currentQuote === '“' && char === '”') || (currentQuote === '‘' && char === '’')) {
        inQuote = false;
      }
      current += char;
    } else if (!inQuote && regex.test(char)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * 审查单个术语表文件
 */
export function lintGlossaryFile(filePath, baseBranchContent = null) {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  const fileReport = {
    file: fileName,
    filePath,
    errors: [],
    warnings: [],
    tips: [],
    stats: {
      terms: 0,
      generalTerms: 0,
      forbiddenTerms: 0,
      regexTerms: 0
    }
  };

  // 1. 文件后缀检查
  if (!fileName.endsWith('.txt')) {
    fileReport.errors.push(`文件缺少 ".txt" 后缀。AOT 在线术语表文件必须以 ".txt" 结尾。`);
  }

  // 2. 扫描并定位各区域
  const sections = [];
  const metadataLines = [];
  let inMetadata = true;

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim().toLowerCase().replace(/[:：\s]*$/, '');
    let matchedHeaderKey = null;

    for (const key in SECTION_HEADERS) {
      if (SECTION_HEADERS[key].includes(trimmedLine)) {
        matchedHeaderKey = key;
        break;
      }
    }

    if (matchedHeaderKey) {
      sections.push({ type: matchedHeaderKey, title: lines[i].trim(), start: i + 1 });
      inMetadata = false;
    } else if (inMetadata && lines[i].trim()) {
      metadataLines.push({ text: lines[i], lineNo: i + 1 });
    }
  }

  // 3. 元数据区检查
  const metadata = {};
  const metadataRegex = /^\s*(maintainer|version|last_updated|visibility|feedback|contact|维护者|版本号|更新时间|可见性|反馈方式|联系方式)\s*[:：]\s*(.*?)\s*[,，]?\s*$/i;

  for (const item of metadataLines) {
    const match = item.text.match(metadataRegex);
    if (match) {
      const rawKey = match[1].trim().toLowerCase();
      const val = match[2].trim();
      const keyMap = {
        '维护者': 'maintainer', '版本号': 'version', '更新时间': 'last_updated',
        '可见性': 'visibility', '反馈方式': 'feedback', '联系方式': 'feedback', 'contact': 'feedback'
      };
      const key = keyMap[rawKey] || rawKey;
      metadata[key] = val;
    } else if (!item.text.trim().startsWith('//')) {
      fileReport.warnings.push(`第 ${item.lineNo} 行元数据 "${item.text.trim()}" 格式不规范，未能被识别为有效元数据。请使用「键：值」格式。`);
    }
  }

  if (!metadata.version) {
    fileReport.errors.push(`元数据缺失：文件头部缺少必填的 "版本号"（例如「版本号：1.0.0」）。客户端依赖该字段执行版本检测。`);
  }
  if (!metadata.maintainer) {
    fileReport.errors.push(`元数据缺失：文件头部缺少必填的 "维护者"（例如「维护者：昵称」）。`);
  }

  // 日期格式检查
  if (metadata.last_updated) {
    const dateStr = metadata.last_updated;
    if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
      fileReport.warnings.push(`元数据中更新时间 "${dateStr}" 存在日-月-年与月-日-年的二义性，建议统一使用 ISO 8601 标准「YYYY-MM-DD」格式（例如「更新时间：2026-11-02」）。`);
    }
  }

  // 对比主分支已有版本号
  if (metadata.version && baseBranchContent) {
    const baseMatch = baseBranchContent.match(/^\s*(?:版本号|version)\s*[:：]\s*([^\s,，]+)/im);
    if (baseMatch && baseMatch[1]) {
      const baseVersion = baseMatch[1].trim();
      const cmp = compareVersions(metadata.version, baseVersion);
      if (cmp <= 0) {
        fileReport.errors.push(`版本号未递增：当前版本号 (v${metadata.version}) 必须大于主分支已有版本号 (v${baseVersion})。若未提升版本号，已订阅该术语表的读者客户端将无法自动同步更新。`);
      }
    }
  }

  // 4. 有效分区检查
  if (sections.length === 0) {
    fileReport.errors.push(`文件结构错误：未找到任何有效分区标题。请至少包含「词条」、「通用词条」、「禁翻词条」或「正则表达式」中的一个。`);
    return fileReport;
  }

  // 5. 逐行解析审查各分区词条
  const seenKeys = new Map();

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    const end = (s + 1 < sections.length) ? sections[s + 1].start - 1 : lines.length;
    const sectionLines = lines.slice(section.start, end);

    for (let j = 0; j < sectionLines.length; j++) {
      const rawLine = sectionLines[j];
      const lineNo = section.start + j + 1;
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      // 检查行尾注释 //
      if (line.includes('//') && !line.startsWith('//')) {
        fileReport.warnings.push(`第 ${lineNo} 行词条内包含行尾注释 "${line.substring(line.indexOf('//'))}"。AOT 客户端不会自动剔除行尾注释，注释内容会被当成译文一同替换进正文！建议将说明注释单独另起一行。`);
      }

      // 检查行尾多余逗号
      if (/[,，]$/.test(line)) {
        fileReport.warnings.push(`第 ${lineNo} 行末尾含有多余的逗号，建议移除。`);
      }

      const cleanLine = line.replace(/[,，]$/, '');

      if (section.type === 'FORBIDDEN_TERMS') {
        fileReport.stats.forbiddenTerms++;
        if (cleanLine.includes(':') || cleanLine.includes('：') || cleanLine.includes('=')) {
          fileReport.warnings.push(`第 ${lineNo} 行禁翻词条 "${cleanLine}" 包含了分隔符或译文。禁翻词条区只需填写需要保持原文不被翻译的词条本身即可。`);
        }
        continue;
      }

      if (section.type === 'REGEX_TERMS') {
        fileReport.stats.regexTerms++;
        const regexMatch = cleanLine.match(/^(.+?)\s*[:：]\s*(.*)$/s);
        if (!regexMatch) {
          fileReport.errors.push(`第 ${lineNo} 行正则表达式缺少冒号分隔符。正则区格式应为「正则表达式: 替换后的文本」。`);
          continue;
        }
        const pattern = regexMatch[1].trim();
        try {
          const testRegex = new RegExp(pattern);
          if (testRegex.test('')) {
            fileReport.errors.push(`第 ${lineNo} 行正则表达式 "${pattern}" 能够匹配空字符串。这会导致浏览器端死循环卡死！`);
          }
          if (/[\(][^()]*[*+{][^()]*[\)][*+]/.test(pattern)) {
            fileReport.errors.push(`第 ${lineNo} 行正则表达式 "${pattern}" 包含嵌套量词，存在灾难性回溯（ReDoS）假死风险。`);
          }
        } catch (e) {
          fileReport.errors.push(`第 ${lineNo} 行正则表达式 "${pattern}" 语法非法: ${e.message}`);
        }
        continue;
      }

      // TERMS 或 GENERAL_TERMS
      if (section.type === 'TERMS') fileReport.stats.terms++;
      if (section.type === 'GENERAL_TERMS') fileReport.stats.generalTerms++;

      const wholeQuoted = isWholeLineQuotedWithSeparator(cleanLine);
      if (wholeQuoted) {
        fileReport.warnings.push(`第 ${lineNo} 行引号包裹了整条规则，而非仅包裹词条。请改为「引号只包词条、分隔符放引号外」，例如 ${wholeQuoted.key}：${wholeQuoted.value}。`);
      }

      const parsed = parseGlossaryKeyValuePair(cleanLine);
      if (!parsed) {
        if (cleanLine.includes("'") || cleanLine.includes('‘')) {
          fileReport.errors.push(`第 ${lineNo} 行词条 "${cleanLine}" 原文包含撇号/单引号但未用双引号包裹。客户端解析器会因找不到闭合单引号而直接丢弃整行规则！请改为在原文两端加半角双引号，例如："Girls' Academy"：女子学园。`);
        } else {
          fileReport.errors.push(`第 ${lineNo} 行词条 "${cleanLine}" 缺失冒号 (:) 或等号 (=) 分隔符，已被客户端跳过。若仅有空格分隔，请补齐分隔符。`);
        }
        continue;
      }

      const key = parsed.key.trim();
      const val = parsed.value.trim().replace(/[,，]$/, '');

      // 检查原文中是否使用了斜杠 / 表示并列
      if (key.includes('/') && !key.includes('://')) {
        fileReport.errors.push(`第 ${lineNo} 行词条原文 "${key}" 包含了斜杠 "/"。AOT 不支持用斜杠表达同义词或备选词，这会导致整个包含斜杠的长短语整体匹配，两边的独立词汇均无法被翻译！请拆分为独立的多行词条。`);
      }

      // 检查原文是否包含标点符号但未用半角双引号包裹（通用语言与标点）
      const isQuoted = (key.startsWith('"') && key.endsWith('"')) || (key.startsWith('“') && key.endsWith('”'));
      const punctuationMatch = key.replace(/^["“](.*)["”]$/, '$1').match(/[\'\’\-\(\)\[\]\!\?\:\.\/]/);
      if (punctuationMatch && !isQuoted) {
        if (key.includes("'") || key.includes('‘')) {
          fileReport.errors.push(`第 ${lineNo} 行词条原文 "${key}" 包含撇号/单引号，必须使用半角双引号包裹（如 "${key}"：${val}），否则会导致 AOT 解析丢弃整行规则！`);
        } else if (!key.includes('/')) {
          fileReport.warnings.push(`第 ${lineNo} 行词条原文 "${key}" 包含标点符号但未用双引号包裹。建议使用双引号包裹原文（如 "${key}"：${val}）以开启精准字面量匹配，避免被拆词或符号影响。`);
        }
      }

      // 检查等号关联语法（=）
      if (parsed.separator === '=') {
        const keyParts = smartSplit(key.replace(/^["“](.*)["”]$/, '$1'), TERM_SEPARATOR_RE);
        const valParts = smartSplit(val.replace(/^["“](.*)["”]$/, '$1'), TRANSLATION_SEPARATOR_RE);
        if (keyParts.length > 1 && keyParts.length !== valParts.length) {
          fileReport.errors.push(`第 ${lineNo} 行等号关联规则 "${key} = ${val}" 的原文分段数 (${keyParts.length}) 与译文分段数 (${valParts.length}) 不一致。AOT 要求等号两侧段数必须完全对等（以空格或·分隔），否则拆分单姓名/单词规则将完全失效！`);
        }
      } else {
        // 使用冒号但原文为人名多词
        if (section.type === 'TERMS') {
          const parts = smartSplit(key, TERM_SEPARATOR_RE);
          if (parts.length > 1 && (val.includes(' ') || val.includes('·'))) {
            fileReport.warnings.push(`第 ${lineNo} 行人名 "${key}" 使用了冒号 ":"。如果希望在小说中单独出现主角名字或姓氏时也能自动匹配，建议改用等号语法（如 "${key} = ${val}"）。若作者有意只匹配全名，可忽略本条建议。`);
          }
        }
      }

      // 检查译文内残留未闭合的分隔符
      if (val && !/^https?:\/\//.test(val) && hasTopLevelResidualSeparator(val)) {
        fileReport.warnings.push(`第 ${lineNo} 行译文 "${val}" 内含有额外的冒号或等号分隔符，请确认是否为误输入。如需在译文中保留标点，请用双引号包裹。`);
      }

      // 检查重复词条
      const lowerKey = key.toLowerCase();
      if (seenKeys.has(lowerKey)) {
        const prevLine = seenKeys.get(lowerKey);
        fileReport.warnings.push(`第 ${lineNo} 行词条 "${key}" 重复定义（已在第 ${prevLine} 行定义过）。`);
      } else {
        seenKeys.set(lowerKey, lineNo);
      }
    }
  }

  return fileReport;
}

/**
 * 自动修复缺失 .txt 后缀的文件
 */
export function autoFixMissingTxtExtensions(dirPath) {
  const fixedFiles = [];
  if (!fs.existsSync(dirPath)) return fixedFiles;

  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.endsWith('.json')) continue;
    const fullPath = path.join(dirPath, entry);
    if (!fs.statSync(fullPath).isFile()) continue;

    if (!entry.endsWith('.txt')) {
      const targetPath = `${fullPath}.txt`;
      fs.renameSync(fullPath, targetPath);
      fixedFiles.push({ oldName: entry, newName: `${entry}.txt` });
    }
  }
  return fixedFiles;
}

/**
 * 检查 PR 描述表单内容（单选防呆校验）
 */
export function checkPrBody(body) {
  const warnings = [];
  if (!body) return warnings;

  // PR 类型单选检查
  const typeMatches = body.match(/\[[xX]\]\s*(?:在线术语表提交|功能改进|界面汉化|文档与其他)/g) || [];
  if (typeMatches.length > 1) {
    warnings.push('「Pull Request 类型」同时勾选了多个选项，建议单选其一，便于维护者快速归类。');
  } else if (typeMatches.length === 0) {
    warnings.push('未在 PR 描述中勾选「Pull Request 类型」，建议单选其一以明确意图。');
  }

  // 变更类型单选检查
  const changeMatches = body.match(/\[[xX]\]\s*(?:新增在线术语表|更新已有在线术语表)/g) || [];
  if (changeMatches.length > 1) {
    warnings.push('「变更类型」同时勾选了“新增”与“更新”，建议单选其一。');
  }

  return warnings;
}

/**
 * 生成 Aria Markdown 审查报告
 */
export function formatMarkdownReport(reports, autoFixedList = [], isHeadBranchMain = true, prBodyWarnings = []) {
  let md = `## Aria 术语表自动审查报告\n\n`;

  if (autoFixedList.length > 0) {
    md += `> [!NOTE]\n`;
    md += `> **自动修复记录**：\n`;
    for (const item of autoFixedList) {
      md += `> - 检测到文件 \`${item.oldName}\` 缺少 \`.txt\` 后缀，已自动补充并重命名为 \`${item.newName}\`。\n`;
    }
    md += `\n`;
  }

  if (prBodyWarnings.length > 0) {
    md += `### PR 描述表单核对\n\n`;
    for (const pw of prBodyWarnings) {
      md += `- **提示**：${pw}\n`;
    }
    md += `\n`;
  }

  let totalErrors = 0;
  let totalWarnings = prBodyWarnings.length;

  for (const report of reports) {
    totalErrors += report.errors.length;
    totalWarnings += report.warnings.length;

    md += `### 文件：\`${report.file}\`\n\n`;
    md += `- **词条统计**：词条区 ${report.stats.terms} 条，通用词条区 ${report.stats.generalTerms} 条，禁翻词条区 ${report.stats.forbiddenTerms} 条，正则表达式 ${report.stats.regexTerms} 条。\n\n`;

    if (report.errors.length > 0) {
      md += `#### 阻断性错误（必须修复）\n`;
      for (const err of report.errors) {
        md += `- [ ] **错误**：${err}\n`;
      }
      md += `\n`;
    }

    if (report.warnings.length > 0) {
      md += `#### 格式与体验建议（建议优化）\n`;
      for (const warn of report.warnings) {
        md += `- **提示**：${warn}\n`;
      }
      md += `\n`;
    }

    if (report.errors.length === 0 && report.warnings.length === 0) {
      md += `> [!TIP]\n`;
      md += `> 该术语表编写极其规范，未发现任何格式语法问题，符合 AOT 客户端解析标准！\n\n`;
    }
  }

  if (!isHeadBranchMain) {
    md += `---\n\n`;
    md += `### 维护者贴心提示：\n`;
    md += `检测到本次 PR 的源分支非 \`main\` 主分支。建议后续在网页端直接选择 **Commit directly to the \`main\` branch** 进行更新。这样订阅了你 \`main\` 分支链接的读者无需重新导入，就能永久自动接收更新。\n\n`;
  }

  md += `\n<!-- aria-glossary-review -->\n`;
  return { markdown: md, totalErrors, totalWarnings };
}

// CLI 执行入口
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  const args = process.argv.slice(2);
  let shouldFix = args.includes('--fix');
  let headBranch = 'main';
  const branchIdx = args.indexOf('--head-branch');
  if (branchIdx !== -1 && args[branchIdx + 1]) {
    headBranch = args[branchIdx + 1];
  }

  const explicitFiles = args.filter(a => !a.startsWith('--') && (a.endsWith('.txt') || fs.existsSync(a)));

  const glossariesDir = path.resolve('glossaries');
  let autoFixed = [];
  if (shouldFix) {
    autoFixed = autoFixMissingTxtExtensions(glossariesDir);
  } else if (fs.existsSync('.auto_fixed_files.json')) {
    try {
      const list = JSON.parse(fs.readFileSync('.auto_fixed_files.json', 'utf-8'));
      autoFixed = list.map(f => ({ oldName: path.basename(f), newName: `${path.basename(f)}.txt` }));
    } catch (e) {}
  }

  let filesToLint = [];
  if (explicitFiles.length > 0) {
    filesToLint = explicitFiles;
  } else if (fs.existsSync(glossariesDir)) {
    filesToLint = fs.readdirSync(glossariesDir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.json'))
      .map(f => path.join(glossariesDir, f));
  }

  const reports = [];
  for (const f of filesToLint) {
    const full = path.isAbsolute(f) ? f : path.resolve(f);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      reports.push(lintGlossaryFile(full));
    }
  }

  const prBody = process.env.PR_BODY || '';
  const prBodyWarnings = checkPrBody(prBody);

  const { markdown, totalErrors } = formatMarkdownReport(reports, autoFixed, headBranch === 'main', prBodyWarnings);
  console.log(markdown);

  if (totalErrors > 0) {
    process.exit(1);
  }
  process.exit(0);
}
