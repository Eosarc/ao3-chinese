#!/usr/bin/env node

/**
 * AO3 Translator 在线术语表智能审查与质检内核
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
 * 自动生成修复后术语表全文
 * mode: 'minimal' (仅修复阻断性错误) | 'recommended' (体验最佳推荐)
 */
export function generateFixedGlossary(rawContent, mode = 'minimal') {
  const lines = rawContent.split(/\r?\n/);
  const result = [];
  const seenKeys = new Set();
  let inSection = '';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      result.push('');
      continue;
    }

    if (trimmed.startsWith('//')) {
      result.push(rawLine);
      continue;
    }

    const cleanHeader = trimmed.toLowerCase().replace(/[:：\s]*$/, '');
    let isHeader = false;
    for (const key in SECTION_HEADERS) {
      if (SECTION_HEADERS[key].includes(cleanHeader)) {
        inSection = key;
        isHeader = true;
        result.push(rawLine);
        break;
      }
    }
    if (isHeader) continue;

    // 元数据区
    if (!inSection) {
      if (mode === 'recommended') {
        const dateMatch = rawLine.match(/^(\s*(?:更新时间|last_updated)\s*[:：]\s*)(\d{2})[-/.](\d{2})[-/.](\d{4})(.*)$/i);
        if (dateMatch) {
          result.push(`${dateMatch[1]}${dateMatch[4]}-${dateMatch[3]}-${dateMatch[2]}${dateMatch[5]}`);
          continue;
        }
      }
      result.push(rawLine);
      continue;
    }

    if (inSection === 'FORBIDDEN_TERMS' || inSection === 'REGEX_TERMS') {
      result.push(rawLine.replace(/[,，]$/, ''));
      continue;
    }

    // TERMS 或 GENERAL_TERMS
    let workingLine = trimmed.replace(/[,，]$/, '');
    let inlineComment = '';
    if (workingLine.includes('//') && !workingLine.startsWith('//')) {
      const cIdx = workingLine.indexOf('//');
      inlineComment = workingLine.substring(cIdx).trim();
      workingLine = workingLine.substring(0, cIdx).trim();
    }

    // 检查整行被引号包裹
    const wholeQuoted = isWholeLineQuotedWithSeparator(workingLine);
    if (wholeQuoted) {
      workingLine = `${wholeQuoted.key}：${wholeQuoted.value}`;
    }

    let parsed = parseGlossaryKeyValuePair(workingLine);

    // 若解析失败，尝试自动修复
    if (!parsed) {
      // 1. 撇号未加双引号
      if (workingLine.includes("'") || workingLine.includes('‘')) {
        const cIdx = workingLine.indexOf('：') !== -1 ? workingLine.indexOf('：') : workingLine.indexOf(':');
        const eIdx = workingLine.indexOf('=') !== -1 ? workingLine.indexOf('=') : workingLine.indexOf('＝');
        const sepIdx = cIdx !== -1 ? cIdx : eIdx;
        if (sepIdx !== -1) {
          const rawK = workingLine.substring(0, sepIdx).trim();
          const sep = workingLine[sepIdx];
          const rawV = workingLine.substring(sepIdx + 1).trim();
          workingLine = `"${rawK}"${sep}${rawV}`;
          parsed = parseGlossaryKeyValuePair(workingLine);
        }
      }

      // 2. 缺失冒号或等号（仅有空格）
      if (!parsed) {
        const matchBoundary = workingLine.match(/^([A-Za-z0-9\s.'"-]+?)\s+([\u4e00-\u9fa5\u3040-\u30ff\u0400-\u04ff].*)$/);
        if (matchBoundary) {
          workingLine = `${matchBoundary[1].trim()}：${matchBoundary[2].trim()}`;
          parsed = parseGlossaryKeyValuePair(workingLine);
        } else {
          const spaceParts = workingLine.split(/\s{2,}|\t/);
          if (spaceParts.length >= 2) {
            workingLine = `${spaceParts[0].trim()}：${spaceParts.slice(1).join(' ').trim()}`;
            parsed = parseGlossaryKeyValuePair(workingLine);
          }
        }
      }
    }

    if (!parsed) {
      result.push(rawLine);
      continue;
    }

    let key = parsed.key.trim();
    let val = parsed.value.trim();
    let sep = parsed.separator === '=' ? ' = ' : '：';

    // 修复等号两侧分段数不匹配问题（转为冒号以确保 CI 通过）
    if (parsed.separator === '=') {
      const keyParts = smartSplit(key.replace(/^["“](.*)["”]$/, '$1'), TERM_SEPARATOR_RE);
      const valParts = smartSplit(val.replace(/^["“](.*)["”]$/, '$1'), TRANSLATION_SEPARATOR_RE);
      if (keyParts.length > 1 && keyParts.length !== valParts.length) {
        sep = '：';
      }
    }

    // 拆分斜杠词条
    const subKeys = (key.includes('/') && !key.includes('://'))
      ? key.split('/').map(k => k.trim()).filter(Boolean)
      : [key];

    for (const subK of subKeys) {
      let finalKey = subK;
      let finalSep = sep;
      let finalVal = val;

      const isQuoted = (finalKey.startsWith('"') && finalKey.endsWith('"')) || (finalKey.startsWith('“') && finalKey.endsWith('”'));

      // 必须转义撇号
      if ((finalKey.includes("'") || finalKey.includes('‘')) && !isQuoted) {
        finalKey = `"${finalKey}"`;
      }

      if (mode === 'recommended') {
        // 标点与连字符包裹双引号
        const hasPunctuation = finalKey.replace(/^["“](.*)["”]$/, '$1').match(/[\'\’\-\(\)\[\]\!\?\:\.\/]/);
        if (hasPunctuation && !finalKey.startsWith('"')) {
          finalKey = `"${finalKey.replace(/^["“]|["”]$/g, '')}"`;
        }

        // 人名冒号升级为等号
        if (inSection === 'TERMS' && (finalSep === '：' || finalSep === ':')) {
          const kParts = smartSplit(finalKey.replace(/^["“](.*)["”]$/, '$1'), TERM_SEPARATOR_RE);
          const vParts = smartSplit(finalVal.replace(/^["“](.*)["”]$/, '$1'), TRANSLATION_SEPARATOR_RE);
          if (kParts.length > 1 && kParts.length === vParts.length) {
            finalSep = ' = ';
          }
        }

        // 重复词条去重
        const lowerKey = finalKey.toLowerCase();
        if (seenKeys.has(lowerKey)) {
          result.push(`// [重复词条已略过] ${finalKey}${finalSep}${finalVal}`);
          continue;
        }
        seenKeys.add(lowerKey);

        // 行尾注释提取到前一行
        if (inlineComment) {
          result.push(inlineComment);
          inlineComment = '';
        }
      }

      if (inlineComment) {
        result.push(`${finalKey}${finalSep}${finalVal}          ${inlineComment}`);
      } else {
        result.push(`${finalKey}${finalSep}${finalVal}`);
      }
    }
  }

  return result.join('\n');
}

/**
 * 结构化审查单个术语表文件
 */
export function lintGlossaryFile(filePath, baseBranchContent = null) {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  const fileReport = {
    file: fileName,
    filePath,
    rawContent: content,
    errors: [],
    warnings: [],
    errorGroups: {},
    warningGroups: {},
    stats: {
      terms: 0,
      generalTerms: 0,
      forbiddenTerms: 0,
      regexTerms: 0
    }
  };

  function addIssue(groupMap, list, typeKey, typeTitle, itemSnippet, fullText) {
    if (!groupMap[typeKey]) {
      groupMap[typeKey] = { title: typeTitle, items: [] };
    }
    groupMap[typeKey].items.push({ snippet: itemSnippet, full: fullText });
    list.push(fullText);
  }

  // 1. 文件后缀检查
  if (!fileName.endsWith('.txt')) {
    addIssue(fileReport.errorGroups, fileReport.errors, 'file_ext', '文件缺少 ".txt" 后缀', fileName, '文件缺少 ".txt" 后缀。AOT 在线术语表文件必须以 ".txt" 结尾。');
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
      addIssue(fileReport.warningGroups, fileReport.warnings, 'metadata_format', '元数据格式不规范', `第 ${item.lineNo} 行: "${item.text.trim()}"`, `第 ${item.lineNo} 行元数据 "${item.text.trim()}" 未能被识别为有效元数据。请使用「键：值」格式。`);
    }
  }

  if (!metadata.version) {
    addIssue(fileReport.errorGroups, fileReport.errors, 'missing_version', '元数据缺失版本号', '缺少版本号', '文件头部缺少必填的 "版本号"（例如「版本号：1.0.0」）。客户端依赖该字段执行版本检测。');
  }
  if (!metadata.maintainer) {
    addIssue(fileReport.errorGroups, fileReport.errors, 'missing_maintainer', '元数据缺失维护者', '缺少维护者', '文件头部缺少必填的 "维护者"（例如「维护者：昵称」）。');
  }

  // 日期格式检查
  if (metadata.last_updated) {
    const dateStr = metadata.last_updated;
    if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(dateStr)) {
      addIssue(fileReport.warningGroups, fileReport.warnings, 'date_format', '更新时间日期格式建议', `更新时间 "${dateStr}"`, `元数据中更新时间 "${dateStr}" 存在日-月-年与月-日-年的二义性，建议统一使用 ISO 8601 标准「YYYY-MM-DD」格式（例如「更新时间：2026-11-02」）。`);
    }
  }

  // 对比主分支已有版本号
  if (metadata.version && baseBranchContent) {
    const baseMatch = baseBranchContent.match(/^\s*(?:版本号|version)\s*[:：]\s*([^\s,，]+)/im);
    if (baseMatch && baseMatch[1]) {
      const baseVersion = baseMatch[1].trim();
      const cmp = compareVersions(metadata.version, baseVersion);
      if (cmp <= 0) {
        addIssue(fileReport.errorGroups, fileReport.errors, 'version_not_bumped', '版本号未递增', `当前 v${metadata.version} <= 主分支 v${baseVersion}`, `当前版本号 (v${metadata.version}) 必须大于主分支已有版本号 (v${baseVersion})。若未提升版本号，已订阅读者客户端将无法自动同步更新。`);
      }
    }
  }

  // 4. 有效分区检查
  if (sections.length === 0) {
    addIssue(fileReport.errorGroups, fileReport.errors, 'missing_section', '文件缺少有效分区标题', '未找到有效分区', '文件结构错误：未找到任何有效分区标题。请至少包含「词条」、「通用词条」、「禁翻词条」或「正则表达式」中的一个。');
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
        const commentPart = line.substring(line.indexOf('//')).trim();
        addIssue(fileReport.warningGroups, fileReport.warnings, 'inline_comment', '词条包含行尾注释（会被当成译文一同替换，建议另起一行）', `第 ${lineNo} 行："${commentPart}"`, `第 ${lineNo} 行词条内包含行尾注释 "${commentPart}"。AOT 客户端不会自动剔除行尾注释，注释内容会被当成译文一同替换进正文！建议将说明注释单独另起一行。`);
      }

      // 检查行尾多余逗号
      if (/[,，]$/.test(line)) {
        addIssue(fileReport.warningGroups, fileReport.warnings, 'trailing_comma', '行末含有多余逗号', `第 ${lineNo} 行`, `第 ${lineNo} 行末尾含有多余的逗号，建议移除。`);
      }

      const cleanLine = line.replace(/[,，]$/, '');

      if (section.type === 'FORBIDDEN_TERMS') {
        fileReport.stats.forbiddenTerms++;
        if (cleanLine.includes(':') || cleanLine.includes('：') || cleanLine.includes('=')) {
          addIssue(fileReport.warningGroups, fileReport.warnings, 'forbidden_term_sep', '禁翻词条包含了分隔符或译文（只需保留词条本身）', `第 ${lineNo} 行："${cleanLine}"`, `第 ${lineNo} 行禁翻词条 "${cleanLine}" 包含了分隔符或译文。禁翻词条区只需填写需要保持原文不被翻译的词条本身即可。`);
        }
        continue;
      }

      if (section.type === 'REGEX_TERMS') {
        fileReport.stats.regexTerms++;
        const regexMatch = cleanLine.match(/^(.+?)\s*[:：]\s*(.*)$/s);
        if (!regexMatch) {
          addIssue(fileReport.errorGroups, fileReport.errors, 'regex_missing_sep', '正则表达式缺少冒号分隔符', `第 ${lineNo} 行`, `第 ${lineNo} 行正则表达式缺少冒号分隔符。正则区格式应为「正则表达式: 替换后的文本」。`);
          continue;
        }
        const pattern = regexMatch[1].trim();
        try {
          const testRegex = new RegExp(pattern);
          if (testRegex.test('')) {
            addIssue(fileReport.errorGroups, fileReport.errors, 'regex_empty_match', '正则表达式能匹配空字符串（会导致死循环卡死）', `第 ${lineNo} 行："${pattern}"`, `第 ${lineNo} 行正则表达式 "${pattern}" 能够匹配空字符串。这会导致浏览器端死循环卡死！`);
          }
          if (/[\(][^()]*[*+{][^()]*[\)][*+]/.test(pattern)) {
            addIssue(fileReport.errorGroups, fileReport.errors, 'regex_redos', '正则表达式包含嵌套量词（ReDoS 假死风险）', `第 ${lineNo} 行："${pattern}"`, `第 ${lineNo} 行正则表达式 "${pattern}" 包含嵌套量词，存在灾难性回溯（ReDoS）假死风险。`);
          }
        } catch (e) {
          addIssue(fileReport.errorGroups, fileReport.errors, 'regex_syntax', '正则表达式语法非法', `第 ${lineNo} 行: ${e.message}`, `第 ${lineNo} 行正则表达式 "${pattern}" 语法非法: ${e.message}`);
        }
        continue;
      }

      // TERMS 或 GENERAL_TERMS
      if (section.type === 'TERMS') fileReport.stats.terms++;
      if (section.type === 'GENERAL_TERMS') fileReport.stats.generalTerms++;

      const wholeQuoted = isWholeLineQuotedWithSeparator(cleanLine);
      if (wholeQuoted) {
        addIssue(fileReport.warningGroups, fileReport.warnings, 'whole_line_quoted', '引号包裹了整条规则而非仅包裹词条', `第 ${lineNo} 行："${cleanLine}" -> 建议改为 ${wholeQuoted.key}：${wholeQuoted.value}`, `第 ${lineNo} 行引号包裹了整条规则，而非仅包裹词条。请改为「引号只包词条、分隔符放引号外」，例如 ${wholeQuoted.key}：${wholeQuoted.value}。`);
      }

      const parsed = wholeQuoted ? { key: wholeQuoted.key, value: wholeQuoted.value, separator: ':' } : parseGlossaryKeyValuePair(cleanLine);
      if (!parsed) {
        if (cleanLine.includes("'") || cleanLine.includes('‘')) {
          addIssue(fileReport.errorGroups, fileReport.errors, 'unquoted_apostrophe', '词条原文包含撇号/单引号但未用双引号包裹（会导致规则被丢弃）', `第 ${lineNo} 行："${cleanLine}"`, `第 ${lineNo} 行词条 "${cleanLine}" 原文包含撇号/单引号但未用双引号包裹。客户端解析器会因找不到闭合单引号而直接丢弃整行规则！请改为在原文两端加半角双引号，例如："${cleanLine.split(/[:：=＝]/)[0]}"：...`);
        } else {
          addIssue(fileReport.errorGroups, fileReport.errors, 'missing_separator', '词条缺失冒号 (:) 或等号 (=) 分隔符（已被客户端跳过）', `第 ${lineNo} 行："${cleanLine}"`, `第 ${lineNo} 行词条 "${cleanLine}" 缺失冒号 (:) 或等号 (=) 分隔符，已被客户端跳过。若仅有空格分隔，请补齐分隔符。`);
        }
        continue;
      }

      const key = parsed.key.trim();
      const val = parsed.value.trim().replace(/[,，]$/, '');

      // 检查原文中是否使用了斜杠 / 表示并列
      if (key.includes('/') && !key.includes('://')) {
        addIssue(fileReport.errorGroups, fileReport.errors, 'slash_in_key', '词条原文包含斜杠 "/"（AOT 不支持斜杠表达同义词，请拆分为多行）', `第 ${lineNo} 行："${key}"`, `第 ${lineNo} 行词条原文 "${key}" 包含了斜杠 "/"。AOT 不支持用斜杠表达同义词或备选词，这会导致整个包含斜杠的长短语整体匹配，两边的独立词汇均无法被翻译！请拆分为独立的多行词条。`);
      }

      // 检查原文是否包含标点符号但未用半角双引号包裹
      const isQuoted = (key.startsWith('"') && key.endsWith('"')) || (key.startsWith('“') && key.endsWith('”'));
      const punctuationMatch = key.replace(/^["“](.*)["”]$/, '$1').match(/[\'\’\-\(\)\[\]\!\?\:\.\/]/);
      if (punctuationMatch && !isQuoted) {
        if (key.includes("'") || key.includes('‘')) {
          addIssue(fileReport.errorGroups, fileReport.errors, 'unquoted_apostrophe', '词条原文包含撇号/单引号但未用双引号包裹（会导致规则被丢弃）', `第 ${lineNo} 行："${key}"`, `第 ${lineNo} 行词条原文 "${key}" 包含撇号/单引号，必须使用半角双引号包裹（如 "${key}"：${val}），否则会导致 AOT 解析丢弃整行规则！`);
        } else if (!key.includes('/')) {
          addIssue(fileReport.warningGroups, fileReport.warnings, 'unquoted_punctuation', '词条原文包含标点符号但未用双引号包裹（建议加双引号开启精准匹配）', `第 ${lineNo} 行："${key}"`, `第 ${lineNo} 行词条原文 "${key}" 包含标点符号但未用双引号包裹。建议使用双引号包裹原文（如 "${key}"：${val}）以开启精准字面量匹配，避免被拆词或符号影响。`);
        }
      }

      // 检查等号关联语法（=）
      if (parsed.separator === '=') {
        const keyParts = smartSplit(key.replace(/^["“](.*)["”]$/, '$1'), TERM_SEPARATOR_RE);
        const valParts = smartSplit(val.replace(/^["“](.*)["”]$/, '$1'), TRANSLATION_SEPARATOR_RE);
        if (keyParts.length > 1 && keyParts.length !== valParts.length) {
          addIssue(fileReport.errorGroups, fileReport.errors, 'unequal_equal_parts', '等号关联规则两侧分段数不一致（要求空格/·对等）', `第 ${lineNo} 行："${key} = ${val}" (原文 ${keyParts.length} 段, 译文 ${valParts.length} 段)`, `第 ${lineNo} 行等号关联规则 "${key} = ${val}" 的原文分段数 (${keyParts.length}) 与译文分段数 (${valParts.length}) 不一致。AOT 要求等号两侧段数必须完全对等（以空格或·分隔），否则拆分单姓名/单词规则将完全失效！`);
        }
      } else {
        // 使用冒号但原文为人名多词
        if (section.type === 'TERMS') {
          const parts = smartSplit(key, TERM_SEPARATOR_RE);
          if (parts.length > 1 && (val.includes(' ') || val.includes('·'))) {
            addIssue(fileReport.warningGroups, fileReport.warnings, 'person_colon', '人名使用了冒号 ":"（建议改用等号语法以支持单名/姓氏匹配）', `第 ${lineNo} 行："${key}"`, `第 ${lineNo} 行人名 "${key}" 使用了冒号 ":"。如果希望在小说中单独出现主角名字或姓氏时也能自动匹配，建议改用等号语法（如 "${key} = ${val}"）。若作者有意只匹配全名，可忽略本条建议。`);
          }
        }
      }

      // 检查译文内残留未闭合的分隔符
      if (val && !/^https?:\/\//.test(val) && hasTopLevelResidualSeparator(val)) {
        addIssue(fileReport.warningGroups, fileReport.warnings, 'residual_sep_in_val', '译文内含有额外的冒号或等号分隔符', `第 ${lineNo} 行："${val}"`, `第 ${lineNo} 行译文 "${val}" 内含有额外的冒号或等号分隔符，请确认是否为误输入。如需在译文中保留标点，请用双引号包裹。`);
      }

      // 检查重复词条
      const lowerKey = key.toLowerCase();
      if (seenKeys.has(lowerKey)) {
        const prevLine = seenKeys.get(lowerKey);
        addIssue(fileReport.warningGroups, fileReport.warnings, 'duplicate_term', '词条重复定义', `第 ${lineNo} 行："${key}" (已在第 ${prevLine} 行定义)`, `第 ${lineNo} 行词条 "${key}" 重复定义（已在第 ${prevLine} 行定义过）。`);
      } else {
        seenKeys.set(lowerKey, lineNo);
      }
    }
  }

  return fileReport;
}

/**
 * 格式化渲染聚合问题分组
 */
function renderIssueGroups(groupMap, prefix = '错误', collapseThreshold = 3) {
  let out = '';
  for (const groupKey in groupMap) {
    const group = groupMap[groupKey];
    const count = group.items.length;

    if (count < collapseThreshold) {
      for (const item of group.items) {
        out += `- [ ] **${prefix}**：${item.full}\n`;
      }
    } else {
      out += `- **${prefix}（共 ${count} 处）**：${group.title}：\n`;
      const visibleItems = group.items.slice(0, collapseThreshold);
      const collapsedItems = group.items.slice(collapseThreshold);

      for (const item of visibleItems) {
        out += `  - ${item.snippet}\n`;
      }
      if (collapsedItems.length > 0) {
        out += `  <details>\n`;
        out += `  <summary>展开查看剩余 ${collapsedItems.length} 处</summary>\n\n`;
        for (const item of collapsedItems) {
          out += `  - ${item.snippet}\n`;
        }
        out += `  </details>\n`;
      }
    }
  }
  return out;
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
 * 生成 Markdown 审查报告
 */
export function formatMarkdownReport(reports, autoFixedList = [], isHeadBranchMain = true) {
  let md = `## 在线术语表自动审查报告\n\n`;

  if (autoFixedList.length > 0) {
    md += `> [!NOTE]\n`;
    md += `> **自动修复记录**：\n`;
    for (const item of autoFixedList) {
      md += `> - 检测到文件 \`${item.oldName}\` 缺少 \`.txt\` 后缀，已自动补充并重命名为 \`${item.newName}\`。\n`;
    }
    md += `\n`;
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const report of reports) {
    totalErrors += report.errors.length;
    totalWarnings += report.warnings.length;

    md += `### 文件：\`${report.file}\`\n\n`;
    md += `- **词条统计**：词条区 ${report.stats.terms} 条，通用词条区 ${report.stats.generalTerms} 条，禁翻词条区 ${report.stats.forbiddenTerms} 条，正则表达式 ${report.stats.regexTerms} 条。\n\n`;

    if (report.errors.length > 0) {
      md += `#### 阻断性错误\n`;
      md += renderIssueGroups(report.errorGroups, '错误', 3);
      md += `\n`;
    }

    if (report.warnings.length > 0) {
      md += `#### 格式与体验建议\n`;
      md += renderIssueGroups(report.warningGroups, '建议', 3);
      md += `\n`;
    }

    if (report.errors.length === 0 && report.warnings.length === 0) {
      md += `> [!TIP]\n`;
      md += `> 该术语表编写极其规范，未发现任何格式语法问题，符合 AOT 客户端解析标准！\n\n`;
    }

    // 生成两种意愿的修复版全文
    if (report.rawContent && (report.errors.length > 0 || report.warnings.length > 0)) {
      const fixedMinimal = generateFixedGlossary(report.rawContent, 'minimal');
      const fixedRecommended = generateFixedGlossary(report.rawContent, 'recommended');

      md += `---\n\n`;
      md += `### 🛠️ 修复版本参考（可按需选择复制）\n\n`;
      md += `<details>\n`;
      md += `<summary>📋 <b>意愿一：【仅修复阻断性错误版本】</b>（点击展开查看代码）</summary>\n\n`;
      md += `> [!TIP]\n`;
      md += `> 该版本仅修复导致 CI 审查失败的阻断性错误（如补齐缺失分隔符、拆分斜杠同义词、转义单引号等），**完全保留作者原有的冒号匹配习惯、注释与格式**，复制后覆盖原文件即可立即通过 CI 审查。\n\n`;
      md += '```text\n';
      md += fixedMinimal.trim() + '\n';
      md += '```\n\n';
      md += `</details>\n\n`;

      md += `<details>\n`;
      md += `<summary>✨ <b>意愿二：【体验最佳推荐版本】</b>（点击展开查看代码）</summary>\n\n`;
      md += `> [!TIP]\n`;
      md += `> 该版本在意愿一的基础上，进一步完成了：\n`;
      md += `> 1. 将符合「名+姓」结构的人名规则升级为等号（\`=\`）语法，使读者在小说正文中看到单独名或姓时也能自动翻译；\n`;
      md += `> 2. 为含标点/连字符的词条包裹半角双引号，开启精准匹配；\n`;
      md += `> 3. 将行尾 \`//\` 注释自动提取为独立行注释，避免注释混入正文替换；\n`;
      md += `> 4. 标准化更新时间为 \`YYYY-MM-DD\` 格式；\n`;
      md += `> 5. 自动注释去重重复词条。\n\n`;
      md += '```text\n';
      md += fixedRecommended.trim() + '\n';
      md += '```\n\n';
      md += `</details>\n\n`;
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

  const { markdown, totalErrors } = formatMarkdownReport(reports, autoFixed, headBranch === 'main');
  console.log(markdown);

  if (totalErrors > 0) {
    process.exit(1);
  }
  process.exit(0);
}
