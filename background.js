// background.js - High-Performance Service Worker for HN Gist Drawer (Manifest V3)

const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_CACHED_STORIES = 25;

// ~8,000 tokens (~25 pages of high-signal comments) for fast Gemini prefill & 5x concurrency safety
const MAX_TRANSCRIPT_CHARS = 32000;
const MAX_COMMENT_CHARS = 1200;
const MAX_ARTICLE_EXCERPT_CHARS = 3000;
const ARTICLE_FETCH_TIMEOUT_MS = 1800;
const MAX_DEPTH = 3;

const SYSTEM_PROMPT = `Give me an unbiased gist of this Hacker News post and its comment thread.

1. Start with a concise 2–3 sentence "What It's About" overview of the linked article or post being discussed so the reader has immediate context before reading the reactions (use the provided article excerpt/post text, or infer it from the title, URL, and how commenters describe it).
2. Then summarize the comment thread: capture the main camps of opinion, high-signal insights from people with firsthand experience, sentiment on any products or tools mentioned, and any standout tangents or links.`;

// Ephemeral in-memory cache for flattened comment transcripts (never persisted to storage)
// Map<storyId, { title, commentCount, transcript }>
const transcriptCache = new Map();

// Deduplicate concurrent Algolia transcript fetches (e.g. hover prefetch + click)
const inFlightTranscripts = new Map();

// Deduplicate concurrent Gemini gist requests for the same storyId
const inFlightGists = new Map();

// Remember which thinkingConfig shape works best for a given model ('level' | 'budget' | 'none')
const modelThinkingSupport = new Map();

// Serialize chrome.storage.session LRU read-modify-writes across concurrent requests
let sessionStorageMutex = Promise.resolve();

function withSessionLock(fn) {
  const next = sessionStorageMutex.then(fn, fn);
  sessionStorageMutex = next.catch(() => {});
  return next;
}

/**
 * Decode HTML entities and strip HTML tags cleanly from Algolia HN comment HTML.
 */
function cleanHtmlToText(html) {
  if (!html) return '';
  let text = String(html);

  // Preserve paragraph and line breaks
  text = text.replace(/<\s*p\s*>/gi, '\n');
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');

  // Keep links compact so long tracking URLs don't bloat token count
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    const compactUrl = href.length > 90 ? href.slice(0, 87) + '...' : href;
    if (!cleanLabel || cleanLabel === href || cleanLabel.endsWith('...')) {
      return compactUrl;
    }
    return `${cleanLabel} (${compactUrl})`;
  });

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode named HTML entities in a single pass
  const namedEntities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#x27;': "'",
    '&#39;': "'",
    '&#x2f;': '/',
    '&#47;': '/',
    '&nbsp;': ' '
  };
  text = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#x27|#39|#x2F|#47);/gi, (match) => {
    return namedEntities[match.toLowerCase()] || match;
  });

  // Numeric hex & decimal entities
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  text = text.replace(/&#([0-9]+);/g, (_, dec) => {
    const code = parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });

  return text.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Fetch a lightweight excerpt (meta description + lead paragraphs) of the linked article
 * with a strict 1.8s timeout so slow external sites never block gist generation.
 */
async function fetchArticleExcerpt(url) {
  if (!url || !/^https?:\/\//i.test(url) || url.includes('news.ycombinator.com')) {
    return '';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1'
      }
    });

    if (!response.ok) return '';

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml')
    ) {
      return '';
    }

    // Read up to ~150KB of the HTML response so we don't parse huge pages
    const reader = response.body?.getReader();
    if (!reader) return '';

    const decoder = new TextDecoder('utf-8');
    let rawHtml = '';
    while (rawHtml.length < 150000) {
      const { value, done } = await reader.read();
      if (done) break;
      rawHtml += decoder.decode(value, { stream: true });
    }
    try {
      reader.cancel();
    } catch (_) {}

    const parts = [];

    // Extract meta description / og:description if present
    const metaMatch =
      rawHtml.match(
        /<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/i
      ) ||
      rawHtml.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["']/i
      );
    if (metaMatch && metaMatch[1]) {
      const desc = cleanHtmlToText(metaMatch[1]);
      if (desc.length > 20) {
        parts.push(`Meta Description: ${desc}`);
      }
    }

    // Strip script, style, nav, header, footer, svg, noscript blocks
    const bodyHtml = rawHtml
      .replace(/<(script|style|svg|noscript|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // Extract meaningful <p> paragraphs
    const paragraphs = [];
    const pRegex = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
    let match;
    let totalLen = 0;
    while ((match = pRegex.exec(bodyHtml)) !== null && totalLen < MAX_ARTICLE_EXCERPT_CHARS) {
      const pText = cleanHtmlToText(match[1]).replace(/\s+/g, ' ').trim();
      if (pText.length >= 60) {
        paragraphs.push(pText);
        totalLen += pText.length;
      }
    }

    if (paragraphs.length > 0) {
      parts.push(paragraphs.join('\n').slice(0, MAX_ARTICLE_EXCERPT_CHARS));
    }

    return parts.join('\n').slice(0, MAX_ARTICLE_EXCERPT_CHARS).trim();
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Engagement-weighted, depth-limited Breadth-First comment selection.
 * Ensures top-level camps of opinion and their key replies across the whole thread
 * are captured before deep nested tangents, while maintaining hierarchy indentation.
 */
function flattenAlgoliaItem(item, articleExcerpt = '') {
  const headerParts = [`Story Title: ${item.title || 'Untitled'}`];
  if (item.url) headerParts.push(`Story URL: ${item.url}`);
  if (item.author) headerParts.push(`Submitted by: ${item.author}`);
  if (item.points != null) headerParts.push(`Points: ${item.points}`);
  if (item.text) {
    const storyText = cleanHtmlToText(item.text);
    headerParts.push(`Story Text:\n${storyText.slice(0, 2000)}`);
  }
  if (articleExcerpt) {
    headerParts.push(`--- Linked Article Excerpt ---\n${articleExcerpt}`);
  }
  headerParts.push('--- Comment Thread ---');

  const headerText = headerParts.join('\n') + '\n';
  let usedChars = headerText.length;
  let totalComments = 0;

  // Single-pass tree preparation: clean text, compute subtree engagement weight, cap depth
  function prepareNode(rawNode, depth) {
    if (!rawNode) return null;
    const hasAuthorAndText = Boolean(rawNode.author && rawNode.text);
    if (hasAuthorAndText) {
      totalComments += 1;
    }

    const childNodes = [];
    let descendantCount = 0;
    if (Array.isArray(rawNode.children)) {
      for (const rawChild of rawNode.children) {
        const preparedChild = prepareNode(rawChild, depth + 1);
        if (preparedChild) {
          childNodes.push(preparedChild);
          descendantCount += 1 + preparedChild.descendantCount;
        }
      }
    }

    if (!hasAuthorAndText && childNodes.length === 0) return null;

    let cleanText = '';
    if (hasAuthorAndText && depth <= MAX_DEPTH) {
      cleanText = cleanHtmlToText(rawNode.text);
      if (cleanText.length > MAX_COMMENT_CHARS) {
        cleanText = cleanText.slice(0, MAX_COMMENT_CHARS) + '...';
      }
    }

    const indent = '  '.repeat(Math.min(depth, MAX_DEPTH));
    const formattedLine =
      cleanText && rawNode.author
        ? `${indent}- [@${rawNode.author}]: ${cleanText.replace(/\n/g, `\n${indent}  `)}`
        : '';

    return {
      id: rawNode.id,
      depth,
      formattedLine,
      children: depth < MAX_DEPTH ? childNodes : [],
      descendantCount,
      selected: false
    };
  }

  const rootNodes = [];
  if (Array.isArray(item.children)) {
    for (const child of item.children) {
      const prepared = prepareNode(child, 0);
      if (prepared) rootNodes.push(prepared);
    }
  }

  // Rank root comments by engagement (descendant reply count + text substance),
  // while giving a slight boost to the first few root comments in the thread.
  const rankedRoots = rootNodes.slice().sort((a, b) => {
    const scoreA = a.descendantCount * 2 + (a.formattedLine.length > 80 ? 1 : 0);
    const scoreB = b.descendantCount * 2 + (b.formattedLine.length > 80 ? 1 : 0);
    return scoreB - scoreA;
  });

  // Sort direct replies by engagement as well
  for (const root of rankedRoots) {
    root.children.sort((a, b) => b.descendantCount - a.descendantCount);
  }

  function trySelectNode(node) {
    if (!node || node.selected || !node.formattedLine) return false;
    const len = node.formattedLine.length + 1;
    if (usedChars + len > MAX_TRANSCRIPT_CHARS) return false;
    node.selected = true;
    usedChars += len;
    return true;
  }

  // Pass 1 (Breadth-First): Select top-level root comments + their top 2 direct replies
  for (const root of rankedRoots) {
    if (usedChars >= MAX_TRANSCRIPT_CHARS) break;
    if (trySelectNode(root)) {
      for (let i = 0; i < Math.min(2, root.children.length); i++) {
        trySelectNode(root.children[i]);
      }
    }
  }

  // Pass 2: Fill remaining budget with depth 1-3 replies in breadth-first waves
  const queue = [];
  for (const root of rankedRoots) {
    if (root.selected) {
      for (const child of root.children) {
        queue.push(child);
      }
    }
  }

  while (queue.length > 0 && usedChars < MAX_TRANSCRIPT_CHARS) {
    const current = queue.shift();
    if (!current.selected) {
      trySelectNode(current);
    }
    if (current.selected && current.children) {
      for (const grandChild of current.children) {
        queue.push(grandChild);
      }
    }
  }

  // Emit selected comments in coherent thread/hierarchy order
  const outputLines = [headerText.trimEnd()];
  function emitSelectedTree(nodes) {
    for (const node of nodes) {
      if (node.selected && node.formattedLine) {
        outputLines.push(node.formattedLine);
      }
      if (node.children && node.children.length > 0) {
        emitSelectedTree(node.children);
      }
    }
  }
  emitSelectedTree(rankedRoots);

  return {
    title: item.title || '',
    commentCount: totalComments,
    transcript: outputLines.join('\n')
  };
}

/**
 * Store flattened object in memory (capped at 25 entries).
 */
function setInMemoryTranscript(storyId, flattenedObj) {
  const id = String(storyId);
  if (transcriptCache.has(id)) {
    transcriptCache.delete(id);
  }
  transcriptCache.set(id, flattenedObj);
  while (transcriptCache.size > MAX_CACHED_STORIES) {
    const oldestKey = transcriptCache.keys().next().value;
    transcriptCache.delete(oldestKey);
  }
}

/**
 * Fetch thread from Algolia HN API and a lightweight excerpt of the linked article in parallel.
 */
async function getOrFetchTranscript(storyId, forceRefresh = false, storyUrlHint = '') {
  const id = String(storyId);
  if (!forceRefresh && transcriptCache.has(id)) {
    return transcriptCache.get(id);
  }

  if (!forceRefresh && inFlightTranscripts.has(id)) {
    return inFlightTranscripts.get(id);
  }

  const fetchPromise = (async () => {
    try {
      // If we already know the external URL from the HN DOM, fetch the article excerpt in parallel with Algolia
      const earlyExcerptPromise = storyUrlHint
        ? fetchArticleExcerpt(storyUrlHint)
        : Promise.resolve('');

      const response = await fetch(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`);
      if (!response.ok) {
        throw new Error(`Algolia HN API error (HTTP ${response.status})`);
      }
      const item = await response.json();

      let articleExcerpt = await earlyExcerptPromise;
      if (!articleExcerpt && item.url && item.url !== storyUrlHint) {
        articleExcerpt = await fetchArticleExcerpt(item.url);
      }

      const flattened = flattenAlgoliaItem(item, articleExcerpt);
      setInMemoryTranscript(id, flattened);
      return flattened;
    } finally {
      inFlightTranscripts.delete(id);
    }
  })();

  inFlightTranscripts.set(id, fetchPromise);
  return fetchPromise;
}

/**
 * Get user API key and selected model from chrome.storage.local.
 */
async function getSettings() {
  const { apiKey, selectedModel } = await chrome.storage.local.get(['apiKey', 'selectedModel']);
  const trimmedKey = (apiKey || '').trim();
  if (!trimmedKey) {
    throw new Error(
      'Missing Google AI Studio API Key. Click the "HN Gist Drawer" extension icon in your browser toolbar to save your key.'
    );
  }
  return {
    apiKey: trimmedKey,
    selectedModel: (selectedModel || DEFAULT_MODEL).trim()
  };
}

/**
 * Read a story entry from chrome.storage.session.
 */
async function getSessionStory(storyId) {
  const key = `story_${storyId}`;
  const result = await chrome.storage.session.get([key]);
  return result[key] || null;
}

/**
 * Save a story entry to chrome.storage.session with strict 25-story LRU eviction.
 * Serialized via sessionStorageMutex so concurrent saves never race.
 */
function saveSessionStory(storyData) {
  return withSessionLock(async () => {
    const id = String(storyData.storyId);
    const key = `story_${id}`;

    const { lruOrder = [] } = await chrome.storage.session.get(['lruOrder']);
    const nextLru = lruOrder.filter((existingId) => String(existingId) !== id);
    nextLru.push(id);

    const keysToRemove = [];
    while (nextLru.length > MAX_CACHED_STORIES) {
      const evictedId = String(nextLru.shift());
      keysToRemove.push(`story_${evictedId}`);
      transcriptCache.delete(evictedId);
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.session.remove(keysToRemove);
    }

    const sanitizedEntry = {
      storyId: id,
      title: storyData.title || 'Hacker News Thread',
      commentCount: Number.isFinite(storyData.commentCount) ? storyData.commentCount : 0,
      gistMarkdown: storyData.gistMarkdown || '',
      chatHistory: Array.isArray(storyData.chatHistory) ? storyData.chatHistory : [],
      timestamp: storyData.timestamp || Date.now()
    };

    await chrome.storage.session.set({
      [key]: sanitizedEntry,
      lruOrder: nextLru
    });

    return sanitizedEntry;
  });
}

/**
 * Touch a story's position in lruOrder when accessed from cache.
 */
function touchSessionLru(storyId) {
  return withSessionLock(async () => {
    const id = String(storyId);
    const { lruOrder = [] } = await chrome.storage.session.get(['lruOrder']);
    if (!lruOrder.includes(id)) return;
    const nextLru = lruOrder.filter((item) => item !== id);
    nextLru.push(id);
    await chrome.storage.session.set({ lruOrder: nextLru });
  });
}

/**
 * Build generationConfig with minimal/zero thinking overhead so Gemini responds in ~1s instead of 12s.
 */
function buildGenerationConfig(cleanModel, thinkingMode) {
  const config = {
    temperature: 1.0,
    maxOutputTokens: 1280
  };

  if (thinkingMode === 'level') {
    config.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  } else if (thinkingMode === 'budget') {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

/**
 * Determine initial thinkingMode for a model ('level' for Gemini 3+/flash-latest, 'budget' for 2.5, 'none' otherwise).
 */
function getInitialThinkingMode(cleanModel) {
  if (modelThinkingSupport.has(cleanModel)) {
    return modelThinkingSupport.get(cleanModel);
  }
  if (cleanModel.includes('gemini-3') || cleanModel === 'gemini-flash-latest') {
    return 'level';
  }
  if (cleanModel.includes('gemini-2.5')) {
    return 'budget';
  }
  return 'none';
}

/**
 * Stream Gemini response via SSE (:streamGenerateContent?alt=sse) for sub-2s Time-To-First-Token.
 */
async function streamGeminiSingleAttempt({
  apiKey,
  cleanModel,
  thinkingMode,
  systemInstruction,
  contents,
  onPartialText
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cleanModel
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents,
    generationConfig: buildGenerationConfig(cleanModel, thinkingMode)
  };
  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => null);
    const apiErrMsg =
      errData?.error?.message || `Gemini API request failed with status ${response.status}`;
    const err = new Error(apiErrMsg);
    err.status = response.status;
    throw err;
  }

  // Remember that this thinkingMode was accepted by the API for this model
  modelThinkingSupport.set(cleanModel, thinkingMode);

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulatedText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(jsonStr);
        const parts = chunk?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          let added = false;
          for (const part of parts) {
            // Skip internal thought parts if any; append visible text parts
            if (part && !part.thought && typeof part.text === 'string') {
              accumulatedText += part.text;
              added = true;
            }
          }
          if (added && typeof onPartialText === 'function') {
            onPartialText(accumulatedText);
          }
        }
      } catch (_) {
        // Ignore partial JSON line parse errors
      }
    }
  }

  const finalResult = accumulatedText.trim();
  if (!finalResult) {
    throw new Error('Gemini returned an empty response.');
  }
  return finalResult;
}

/**
 * Call Gemini with SSE streaming, automatic thinkingConfig negotiation, and 503 retry.
 */
async function callGemini({ apiKey, model, systemInstruction, contents, onPartialText }) {
  const cleanModel = (model || DEFAULT_MODEL).replace(/^models\//, '');
  let thinkingMode = getInitialThinkingMode(cleanModel);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await streamGeminiSingleAttempt({
        apiKey,
        cleanModel,
        thinkingMode,
        systemInstruction,
        contents,
        onPartialText
      });
    } catch (err) {
      const msg = (err.message || '').toLowerCase();

      // If the model rejected thinkingLevel or thinkingBudget (HTTP 400), step down automatically
      if (
        err.status === 400 &&
        (msg.includes('thinking') || msg.includes('invalid argument') || msg.includes('unknown name'))
      ) {
        if (thinkingMode === 'level') {
          thinkingMode = 'budget';
          continue;
        }
        if (thinkingMode === 'budget') {
          thinkingMode = 'none';
          modelThinkingSupport.set(cleanModel, 'none');
          continue;
        }
      }

      // Brief retry on temporary 503 high-demand spikes
      const isTemporarySpike =
        err.status === 503 || msg.includes('high demand') || msg.includes('overloaded');

      if (isTemporarySpike && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
        continue;
      }

      throw err;
    }
  }
}

/**
 * Notify active HN tabs of story status or streaming chunks.
 */
async function notifyTabs(payload) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://news.ycombinator.com/*' });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
      }
    }
  } catch (_) {
    // Ignore tab query/messaging errors
  }
}

/**
 * Generate or retrieve a gist for a story, streaming partial Markdown live to the drawer.
 */
async function getOrGenerateGist({
  storyId,
  titleFallback,
  storyUrlFallback,
  commentCountFallback,
  forceRefresh
}) {
  const id = String(storyId);

  if (!forceRefresh) {
    const cached = await getSessionStory(id);
    if (cached && cached.gistMarkdown) {
      touchSessionLru(id);
      return { data: cached, fromCache: true };
    }
  }

  if (!forceRefresh && inFlightGists.has(id)) {
    const data = await inFlightGists.get(id);
    return { data, fromCache: false };
  }

  const generationPromise = (async () => {
    // Fire loading notification without blocking network setup
    notifyTabs({
      type: 'STORY_GIST_STATUS',
      storyId: id,
      status: 'loading'
    });

    try {
      // Run settings lookup and Algolia + article excerpt fetch in parallel
      const [{ apiKey, selectedModel }, algoliaData] = await Promise.all([
        getSettings(),
        getOrFetchTranscript(id, Boolean(forceRefresh), storyUrlFallback || '')
      ]);

      const finalTitle = algoliaData.title || titleFallback || `HN Story #${id}`;
      const finalCount =
        algoliaData.commentCount != null
          ? algoliaData.commentCount
          : Number.isFinite(commentCountFallback)
          ? commentCountFallback
          : 0;

      if (finalCount === 0 && !algoliaData.transcript.includes('- [@')) {
        const noCommentsEntry = await saveSessionStory({
          storyId: id,
          title: finalTitle,
          commentCount: 0,
          gistMarkdown: '_No comments have been posted on this thread yet._',
          chatHistory: [],
          timestamp: Date.now()
        });
        notifyTabs({
          type: 'STORY_GIST_STATUS',
          storyId: id,
          status: 'ready',
          data: noCommentsEntry
        });
        return noCommentsEntry;
      }

      // Throttle streaming updates to ~75ms so DOM updates stay buttery smooth
      let lastBroadcastTime = 0;
      const onPartialText = (partialMarkdown) => {
        const now = Date.now();
        if (now - lastBroadcastTime >= 75) {
          lastBroadcastTime = now;
          notifyTabs({
            type: 'STORY_GIST_STREAM',
            storyId: id,
            title: finalTitle,
            commentCount: finalCount,
            partialMarkdown
          });
        }
      };

      const gistMarkdown = await callGemini({
        apiKey,
        model: selectedModel,
        systemInstruction: SYSTEM_PROMPT,
        contents: [
          {
            role: 'user',
            parts: [{ text: algoliaData.transcript }]
          }
        ],
        onPartialText
      });

      const savedEntry = await saveSessionStory({
        storyId: id,
        title: finalTitle,
        commentCount: finalCount,
        gistMarkdown,
        chatHistory: [],
        timestamp: Date.now()
      });

      notifyTabs({
        type: 'STORY_GIST_STATUS',
        storyId: id,
        status: 'ready',
        data: savedEntry
      });
      return savedEntry;
    } catch (err) {
      notifyTabs({
        type: 'STORY_GIST_STATUS',
        storyId: id,
        status: 'error',
        error: err.message || String(err)
      });
      throw err;
    } finally {
      inFlightGists.delete(id);
    }
  })();

  inFlightGists.set(id, generationPromise);
  const data = await generationPromise;
  return { data, fromCache: false };
}

/**
 * Handle a follow-up question in the drawer using the thread's flattened comments context,
 * initial gist, and prior chatHistory turns.
 */
async function handleFollowUpQuestion({ storyId, question }) {
  const id = String(storyId);
  const trimmedQuestion = (question || '').trim();
  if (!trimmedQuestion) {
    throw new Error('Please enter a question.');
  }

  const [{ apiKey, selectedModel }, existingSessionEntry] = await Promise.all([
    getSettings(),
    getSessionStory(id)
  ]);

  let sessionEntry = existingSessionEntry;
  if (!sessionEntry) {
    const generated = await getOrGenerateGist({ storyId: id, forceRefresh: false });
    sessionEntry = generated.data;
  }

  const { transcript } = await getOrFetchTranscript(id, false);

  const contents = [
    {
      role: 'user',
      parts: [{ text: transcript }]
    },
    {
      role: 'model',
      parts: [{ text: sessionEntry.gistMarkdown }]
    }
  ];

  for (const turn of sessionEntry.chatHistory || []) {
    contents.push({
      role: turn.role === 'user' ? 'user' : 'model',
      parts: [{ text: turn.text }]
    });
  }

  contents.push({
    role: 'user',
    parts: [
      {
        text: `Follow-up question about this Hacker News thread: ${trimmedQuestion}`
      }
    ]
  });

  const followUpSystemInstruction = `${SYSTEM_PROMPT}\n\nYou are now answering follow-up questions about this Hacker News comment thread. Ground your answers directly in what commenters actually said (referencing @usernames where helpful), and clearly note if something was not mentioned in the thread.`;

  const answer = await callGemini({
    apiKey,
    model: selectedModel,
    systemInstruction: followUpSystemInstruction,
    contents
  });

  const updatedHistory = [
    ...(sessionEntry.chatHistory || []),
    { role: 'user', text: trimmedQuestion, timestamp: Date.now() },
    { role: 'model', text: answer, timestamp: Date.now() }
  ];

  const updatedEntry = await saveSessionStory({
    ...sessionEntry,
    chatHistory: updatedHistory,
    timestamp: sessionEntry.timestamp || Date.now()
  });

  return {
    answer,
    data: updatedEntry
  };
}

/**
 * Listen for messages from content.js and popup.js
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Lightweight Algolia + article excerpt hover prefetch (zero Gemini cost)
  if (message.type === 'PREFETCH_TRANSCRIPT') {
    if (message.storyId) {
      getOrFetchTranscript(String(message.storyId), false, message.storyUrl || '').catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'CHECK_CACHED_STORIES') {
    (async () => {
      try {
        const storyIds = Array.isArray(message.storyIds) ? message.storyIds.map(String) : [];
        const keys = storyIds.map((id) => `story_${id}`);
        const stored = keys.length > 0 ? await chrome.storage.session.get(keys) : {};
        const cachedIds = [];
        const inFlightIds = [];

        for (const id of storyIds) {
          if (stored[`story_${id}`]?.gistMarkdown) {
            cachedIds.push(id);
          } else if (inFlightGists.has(id)) {
            inFlightIds.push(id);
          }
        }
        sendResponse({ ok: true, cachedIds, inFlightIds });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'GET_OR_GENERATE_GIST') {
    (async () => {
      try {
        const result = await getOrGenerateGist({
          storyId: message.storyId,
          titleFallback: message.title,
          storyUrlFallback: message.storyUrl,
          commentCountFallback: message.commentCount,
          forceRefresh: Boolean(message.forceRefresh)
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'ASK_FOLLOWUP') {
    (async () => {
      try {
        const result = await handleFollowUpQuestion({
          storyId: message.storyId,
          question: message.question
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
