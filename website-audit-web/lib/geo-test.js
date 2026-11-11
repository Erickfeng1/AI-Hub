'use strict';
/**
 * GEO/AI 问答测试：模拟海外买家向 AI 助手提问采购问题，
 * 检测 AI 回答中是否提及目标品牌/域名（Generative Engine Optimization 可见性）。
 *
 * 流程：1 次 LLM 调用生成贴合行业的买家问题（JSON）→ 逐题独立调用获得 AI 回答
 *      → 本地正则判定品牌/域名命中 → 汇总 GEO 得分。
 * 任一环节失败不阻塞整体检测：返回 { score: null, error }。
 */
const cheerio = require('cheerio');

const QUESTION_COUNT = 6;
const ANSWER_TIMEOUT_MS = 45000;
const GEN_TIMEOUT_MS = 40000;

function extractIndustryContext(rawHtml) {
  try {
    const $ = cheerio.load(rawHtml);
    const title = ($('title').first().text() || '').trim();
    const keywords = ($('meta[name="keywords"]').attr('content') || '').trim();
    const desc = ($('meta[name="description"]').attr('content') || '').trim();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 600);
    return { title, keywords, desc, bodyText };
  } catch (e) {
    return { title: '', keywords: '', desc: '', bodyText: '' };
  }
}

function parseQuestions(content) {
  if (!content) return null;
  // 兼容 ```json ... ``` 包裹
  let text = String(content).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const arr = text.match(/\[[\s\S]*\]/);
  if (!arr) return null;
  try {
    const parsed = JSON.parse(arr[0]);
    if (!Array.isArray(parsed)) return null;
    const qs = parsed
      .map((q) => (typeof q === 'string' ? q : q && q.question))
      .filter((q) => typeof q === 'string' && q.length > 8)
      .slice(0, QUESTION_COUNT);
    return qs.length >= 3 ? qs : null; // 至少 3 个有效问题才可用
  } catch (e) {
    return null;
  }
}

function buildBrandPatterns(brandTerms) {
  const patterns = [];
  if (brandTerms.brand && brandTerms.brand.length >= 3) {
    patterns.push({ kind: 'brand', re: new RegExp('\\b' + brandTerms.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') });
  }
  if (brandTerms.domain) {
    const hostNoWww = brandTerms.domain.replace(/^www\./, '');
    patterns.push({ kind: 'domain', re: new RegExp(hostNoWww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
  }
  return patterns;
}

function checkHit(answerText, patterns) {
  const matched = [];
  for (const p of patterns) {
    if (p.re.test(answerText)) matched.push(p.kind);
  }
  return matched;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} homeRawHtml 首页原始 HTML（行业推断上下文）
 * @param {{brand:string, domain:string}} brandTerms
 * @param {(p:{stage:string,pct:number,detail:string})=>void} onProgress
 * @returns {Promise<object>} GEO 结果对象
 */
async function runGeoTest(homeRawHtml, brandTerms, onProgress) {
  const ctx = extractIndustryContext(homeRawHtml || '');
  const patterns = buildBrandPatterns(brandTerms);
  if (!patterns.length) {
    return { score: null, grade: '—', total: 0, hits: 0, error: 'no-brand-term', note: '无法从域名提取品牌词，跳过 GEO 测试' };
  }

  let client;
  try {
    // 懒加载：避免服务启动期强依赖 SDK（无凭据环境加载会阻塞/失败）
    const { LLMClient: LC, Config: CFG } = require('coze-coding-dev-sdk');
    client = new LC(new CFG({ timeout: 60000 }));
  } catch (e) {
    return { score: null, grade: '—', total: 0, hits: 0, error: 'llm-init-failed', note: 'LLM 初始化失败：' + (e.message || e) };
  }

  // ---- 阶段 1：生成买家问题 ----
  let questions = null;
  try {
    onProgress({ stage: 'geo', pct: 54, detail: 'AI 正在模拟买家提问…' });
    const genPrompt =
      'A foreign wholesale buyer is looking for suppliers on the internet. ' +
      'Here is the homepage of a Chinese supplier website:\n' +
      'TITLE: ' + (ctx.title || '(none)') + '\n' +
      'KEYWORDS: ' + (ctx.keywords || '(none)') + '\n' +
      'DESCRIPTION: ' + (ctx.desc || '(none)') + '\n' +
      'PAGE TEXT (partial): ' + (ctx.bodyText || '(none)') + '\n\n' +
      'Task: write ' + QUESTION_COUNT + ' DIFFERENT questions this buyer would naturally ask an AI assistant ' +
      '(like ChatGPT or Perplexity) when searching for suppliers of this industry. ' +
      'Questions must be in English, buyer-perspective, industry-specific, and NOT mention any specific company name.\n' +
      'Return ONLY a JSON array of strings, no explanations.';
    const resp = await withTimeout(client.invoke([{ role: 'user', content: genPrompt }], { temperature: 0.7 }), GEN_TIMEOUT_MS, 'question-gen');
    questions = parseQuestions(resp && resp.content);
  } catch (e) {
    questions = null;
  }
  if (!questions || !questions.length) {
    return { score: null, grade: '—', total: 0, hits: 0, error: 'question-gen-failed', note: 'AI 问题生成失败，GEO 未测试' };
  }

  // ---- 阶段 2：逐题获得 AI 回答并判定命中 ----
  const answerSystem = 'You are a helpful sourcing assistant for overseas B2B buyers. Answer the buyer question concisely (under 120 words), naming real companies or websites when relevant.';
  const results = [];
  let hits = 0;
  for (let i = 0; i < questions.length; i++) {
    onProgress({ stage: 'geo', pct: 56 + Math.round((i / questions.length) * 14), detail: 'AI 问答 ' + (i + 1) + '/' + questions.length + '…' });
    let answerText = '';
    let err = null;
    try {
      const resp = await withTimeout(
        client.invoke(
          [
            { role: 'system', content: answerSystem },
            { role: 'user', content: questions[i] },
          ],
          { temperature: 0.7 }
        ),
        ANSWER_TIMEOUT_MS,
        'answer'
      );
      answerText = String((resp && resp.content) || '');
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    const matched = answerText ? checkHit(answerText, patterns) : [];
    const hit = matched.length > 0;
    if (hit) hits++;
    results.push({
      q: questions[i],
      hit,
      matchedBy: matched,
      error: err,
      answerSnippet: answerText ? answerText.replace(/\s+/g, ' ').trim().slice(0, 240) : '',
    });
  }

  const total = results.length;
  const score = Math.round((hits / total) * 100);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';
  const note =
    hits === 0
      ? 'AI 在 ' + total + ' 个买家场景问题中均未提及该品牌——AI 时代基本不可见'
      : 'AI 在 ' + total + ' 个买家场景问题中命中 ' + hits + ' 次';

  return { score, grade, total, hits, questions: results, note, brand: brandTerms.brand, domain: brandTerms.domain };
}

/**
 * 动态行业买家词（v16 起为唯一买家词表）：根据站点内容用 AI 识别行业，
 * 生成 8-10 个行业买家决策词；通用采购词（如 oem / moq）仅在行业相关时由 AI 自行纳入。
 * 失败返回 null（调用方词表为空，报告按降级文案展示）。
 */
const WORDS_TIMEOUT_MS = 30000;
async function inferIndustryWords(ctx) {
  let client;
  try {
    const { LLMClient: LC, Config: CFG } = require('coze-coding-dev-sdk');
    client = new LC(new CFG({ timeout: WORDS_TIMEOUT_MS }));
  } catch (e) {
    return null;
  }
  try {
    const prompt =
      'Analyze this Chinese supplier website and identify its industry.\n' +
      'TITLE: ' + (ctx.title || '(none)') + '\n' +
      'KEYWORDS: ' + (ctx.keywords || '(none)') + '\n' +
      'DESCRIPTION: ' + (ctx.desc || '(none)') + '\n' +
      'PAGE TEXT (partial): ' + (ctx.bodyText || '(none)') + '\n\n' +
      'Task: return a JSON object {"industry":"<short industry name in english>","words":["word1","word2"]}\n' +
      '- "words": 8-10 ENGLISH keywords that overseas B2B buyers would naturally use when asking AI assistants for suppliers of this industry.\n' +
      '- Prefer industry-specific words that a GOOD supplier website of this industry would naturally contain multiple times in its visible text (product categories, use cases, materials, applications).\n' +
      '- Generic B2B procurement terms (oem, odm, moq, wholesale, fob, lead time) may be included ONLY if highly relevant for this industry; otherwise use industry-specific words instead.\n' +
      '- Examples: hotel supplies -> ["hotel","hospitality","guest room","banquet"]; auto parts -> ["auto parts","car model","oem"]; garment -> ["apparel","fabric","garment factory"].\n' +
      '- Each word lowercase, 1-3 words, no brand names.\n' +
      'Return ONLY the JSON object, no explanations.';
    const resp = await withTimeout(client.invoke([{ role: 'user', content: prompt }], { temperature: 0.3 }), WORDS_TIMEOUT_MS, 'industry-words');
    const m = String((resp && resp.content) || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const words = Array.isArray(obj.words)
      ? obj.words.map((w) => String(w).toLowerCase().trim()).filter((w) => w && w.length <= 30)
      : [];
    const uniq = [...new Set(words)].slice(0, 10);
    if (!uniq.length) return null;
    return { industry: String(obj.industry || '').trim().slice(0, 40) || null, words: uniq };
  } catch (e) {
    return null;
  }
}

module.exports = { runGeoTest, inferIndustryWords };
