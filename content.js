// content.js - HN DOM Integration, Live Streaming Drawer UI & 5-Concurrent Click Manager

(() => {
  const MAX_CONCURRENT_REQUESTS = 5;
  const ALGOLIA_PREFETCH_DELAY_MS = 140;

  // Map of storyId -> { storyId, title, commentCount, buttonEl, status: 'idle' | 'loading' | 'ready' | 'error', partialMarkdown: string, entry: object | null }
  const storiesById = new Map();

  // Track in-flight follow-up questions per storyId so switching stories never locks the input
  const followUpInFlightStories = new Set();

  // Currently active storyId displayed in the drawer
  let activeDrawerStoryId = null;
  let drawerElements = null;

  /**
   * Safely send a message to background.js without throwing "Extension context invalidated"
   * if the extension was reloaded in chrome://extensions while this tab remained open.
   */
  function safeSendMessage(payload, callback, { reloadOnInvalidated = false } = {}) {
    try {
      if (!chrome?.runtime?.id) {
        if (reloadOnInvalidated) {
          window.location.reload();
        }
        return;
      }
      if (typeof callback === 'function') {
        chrome.runtime.sendMessage(payload, (response) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr && /context invalidated/i.test(lastErr.message || '')) {
            if (reloadOnInvalidated) {
              window.location.reload();
            }
            return;
          }
          callback(response, lastErr);
        });
      } else {
        chrome.runtime.sendMessage(payload);
      }
    } catch (err) {
      if (reloadOnInvalidated && /context invalidated/i.test(err?.message || String(err))) {
        window.location.reload();
      }
    }
  }

  /**
   * Escape HTML special characters to prevent XSS before formatting Markdown.
   */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Format inline Markdown safely (inline code, links, bold, italics, @mentions).
   */
  function formatInlineMarkdown(escapedLine) {
    const codeTokens = [];

    // 1. Extract inline code `...` so inner characters aren't formatted
    let text = escapedLine.replace(/`([^`]+)`/g, (_, code) => {
      const token = `%%CODE_${codeTokens.length}%%`;
      codeTokens.push(`<code class="hn-gist-inline-code">${code}</code>`);
      return token;
    });

    // 2. Markdown links [label](https://...)
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer" class="hn-gist-link">${label}</a>`
    );

    // 3. Bare URLs (not already inside href="...")
    text = text.replace(
      /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
      (_, prefix, url) =>
        `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer" class="hn-gist-link">${url}</a>`
    );

    // 4. Bold **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 5. Italic *text*
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

    // 6. Highlight @username references
    text = text.replace(/(^|[\s(])@([a-zA-Z0-9_-]{2,30})\b/g, '$1<span class="hn-gist-user">@$2</span>');

    // 7. Restore inline code tokens
    codeTokens.forEach((html, idx) => {
      text = text.replace(`%%CODE_${idx}%%`, html);
    });

    return text;
  }

  /**
   * Render Markdown string into safe, structured HTML for the drawer.
   */
  function renderMarkdownToHtml(markdown) {
    if (!markdown) return '';
    const escaped = escapeHtml(markdown);
    const lines = escaped.split(/\r?\n/);

    const htmlParts = [];
    let inUl = false;
    let inOl = false;
    let inCodeBlock = false;
    let codeBlockBuffer = [];

    function closeLists() {
      if (inUl) {
        htmlParts.push('</ul>');
        inUl = false;
      }
      if (inOl) {
        htmlParts.push('</ol>');
        inOl = false;
      }
    }

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      // Fenced code blocks ```
      if (trimmed.startsWith('```')) {
        closeLists();
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockBuffer = [];
        } else {
          htmlParts.push(
            `<pre class="hn-gist-code-block"><code>${codeBlockBuffer.join('\n')}</code></pre>`
          );
          inCodeBlock = false;
          codeBlockBuffer = [];
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockBuffer.push(rawLine);
        continue;
      }

      if (!trimmed) {
        closeLists();
        continue;
      }

      // Headings (#, ##, ###, ####)
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (headingMatch) {
        closeLists();
        const level = Math.min(headingMatch[1].length + 1, 4);
        htmlParts.push(
          `<h${level} class="hn-gist-heading">${formatInlineMarkdown(headingMatch[2])}</h${level}>`
        );
        continue;
      }

      // Unordered list items (- or * or •)
      const ulMatch = rawLine.match(/^(\s*)[-*•]\s+(.*)$/);
      if (ulMatch) {
        if (inOl) {
          htmlParts.push('</ol>');
          inOl = false;
        }
        if (!inUl) {
          htmlParts.push('<ul class="hn-gist-list">');
          inUl = true;
        }
        const isNested = ulMatch[1].length >= 2;
        const itemClass = isNested ? ' class="hn-gist-list-item--nested"' : '';
        htmlParts.push(`<li${itemClass}>${formatInlineMarkdown(ulMatch[2])}</li>`);
        continue;
      }

      // Ordered list items (1. 2. etc.)
      const olMatch = rawLine.match(/^\s*\d+\.\s+(.*)$/);
      if (olMatch) {
        if (inUl) {
          htmlParts.push('</ul>');
          inUl = false;
        }
        if (!inOl) {
          htmlParts.push('<ol class="hn-gist-list hn-gist-list--ordered">');
          inOl = true;
        }
        htmlParts.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
        continue;
      }

      // Blockquote (> ...)
      if (trimmed.startsWith('&gt;')) {
        closeLists();
        const quoteBody = trimmed.replace(/^&gt;\s?/, '');
        htmlParts.push(
          `<blockquote class="hn-gist-quote">${formatInlineMarkdown(quoteBody)}</blockquote>`
        );
        continue;
      }

      // Standard paragraph
      closeLists();
      htmlParts.push(`<p class="hn-gist-paragraph">${formatInlineMarkdown(trimmed)}</p>`);
    }

    if (inCodeBlock && codeBlockBuffer.length > 0) {
      htmlParts.push(
        `<pre class="hn-gist-code-block"><code>${codeBlockBuffer.join('\n')}</code></pre>`
      );
    }
    closeLists();

    return htmlParts.join('\n');
  }

  /**
   * Update a story's button UI to reflect its current state.
   */
  function updateButtonState(storyId, status) {
    const info = storiesById.get(String(storyId));
    if (!info || !info.buttonEl) return;

    info.status = status;
    const btn = info.buttonEl;
    btn.classList.remove('hn-gist-btn--loading', 'hn-gist-btn--ready');

    if (status === 'loading') {
      btn.textContent = '[⏳ Loading...]';
      btn.classList.add('hn-gist-btn--loading');
    } else if (status === 'ready') {
      btn.textContent = '[⚡ Gist Ready]';
      btn.classList.add('hn-gist-btn--ready');
    } else {
      btn.textContent = '[⚡ Gist]';
    }
  }

  /**
   * Build the Right-Hand Split Drawer DOM once and attach event listeners.
   */
  function ensureDrawerCreated() {
    if (drawerElements) return drawerElements;

    const aside = document.createElement('aside');
    aside.id = 'hn-gist-drawer';
    aside.className = 'hn-gist-drawer';
    aside.setAttribute('aria-hidden', 'true');

    aside.innerHTML = `
      <header class="hn-gist-drawer__header">
        <div class="hn-gist-drawer__title-wrap">
          <a class="hn-gist-drawer__title" href="#" target="_blank" rel="noopener noreferrer">Select a story</a>
          <span class="hn-gist-drawer__meta"></span>
        </div>
        <div class="hn-gist-drawer__actions">
          <button type="button" class="hn-gist-drawer__action-btn hn-gist-drawer__refresh-btn" title="Force refresh from Algolia & Gemini">[↻ Refresh]</button>
          <button type="button" class="hn-gist-drawer__action-btn hn-gist-drawer__close-btn" title="Close drawer (Esc)">[✕]</button>
        </div>
      </header>
      <div class="hn-gist-drawer__body">
        <div class="hn-gist-drawer__gist-container"></div>
        <div class="hn-gist-drawer__chat-section" hidden>
          <div class="hn-gist-drawer__section-label">Follow-Up Q&amp;A</div>
          <div class="hn-gist-drawer__chat-list"></div>
        </div>
      </div>
      <footer class="hn-gist-drawer__footer">
        <form class="hn-gist-drawer__form">
          <input
            type="text"
            class="hn-gist-drawer__input"
            placeholder="Ask a follow-up about this thread..."
            autocomplete="off"
          />
          <button type="submit" class="hn-gist-drawer__send-btn">Send</button>
        </form>
      </footer>
    `;

    document.body.appendChild(aside);

    const titleEl = aside.querySelector('.hn-gist-drawer__title');
    const metaEl = aside.querySelector('.hn-gist-drawer__meta');
    const refreshBtn = aside.querySelector('.hn-gist-drawer__refresh-btn');
    const closeBtn = aside.querySelector('.hn-gist-drawer__close-btn');
    const bodyEl = aside.querySelector('.hn-gist-drawer__body');
    const gistContainer = aside.querySelector('.hn-gist-drawer__gist-container');
    const chatSection = aside.querySelector('.hn-gist-drawer__chat-section');
    const chatList = aside.querySelector('.hn-gist-drawer__chat-list');
    const formEl = aside.querySelector('.hn-gist-drawer__form');
    const inputEl = aside.querySelector('.hn-gist-drawer__input');
    const sendBtn = aside.querySelector('.hn-gist-drawer__send-btn');

    closeBtn.addEventListener('click', closeDrawer);

    refreshBtn.addEventListener('click', () => {
      if (!activeDrawerStoryId) return;
      requestStoryGist(activeDrawerStoryId, { forceRefresh: true });
    });

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      submitFollowUpQuestion();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && activeDrawerStoryId !== null) {
        closeDrawer();
      }
    });

    drawerElements = {
      aside,
      titleEl,
      metaEl,
      refreshBtn,
      closeBtn,
      bodyEl,
      gistContainer,
      chatSection,
      chatList,
      formEl,
      inputEl,
      sendBtn
    };

    return drawerElements;
  }

  /**
   * Open the right-hand split drawer for a given storyId and start/resume its gist.
   */
  function openDrawerForStory(storyId) {
    const id = String(storyId);
    const info = storiesById.get(id);
    if (!info) return;

    // Check concurrency cap BEFORE switching activeDrawerStoryId so an active story isn't hijacked
    const currentlyLoadingCount = Array.from(storiesById.values()).filter(
      (s) => s.status === 'loading' && s.storyId !== id
    ).length;

    if (info.status !== 'ready' && info.status !== 'loading' && currentlyLoadingCount >= MAX_CONCURRENT_REQUESTS) {
      const els = ensureDrawerCreated();
      els.aside.classList.add('hn-gist-drawer--open');
      els.aside.setAttribute('aria-hidden', 'false');
      document.body.classList.add('hn-gist-drawer-open');
      if (!activeDrawerStoryId) {
        activeDrawerStoryId = id;
        renderDrawerError(
          info,
          `Maximum of ${MAX_CONCURRENT_REQUESTS} concurrent gists are already generating. Wait a moment for one to finish.`
        );
      }
      return;
    }

    const els = ensureDrawerCreated();
    activeDrawerStoryId = id;

    els.aside.classList.add('hn-gist-drawer--open');
    els.aside.setAttribute('aria-hidden', 'false');
    document.body.classList.add('hn-gist-drawer-open');

    els.titleEl.textContent = info.title || `Story #${id}`;
    els.titleEl.href = `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
    els.metaEl.textContent = `${info.commentCount} comment${info.commentCount === 1 ? '' : 's'} • #${id}`;

    // If this story is already streaming in the background, show its live partial text immediately
    if (info.status === 'loading') {
      if (info.partialMarkdown) {
        renderDrawerStreaming(info, info.partialMarkdown);
      } else {
        renderDrawerLoading(info);
      }
      return;
    }

    // If we already have the entry in memory on this page, render immediately and touch cache
    if (info.status === 'ready' && info.entry) {
      renderDrawerContent(info.entry);
      return;
    }

    requestStoryGist(id, { forceRefresh: false });
  }

  /**
   * Trigger a gist fetch when clicked in the UI (up to 5 concurrent requests).
   */
  function requestStoryGist(storyId, { forceRefresh = false } = {}) {
    const id = String(storyId);
    const info = storiesById.get(id);
    if (!info) return;

    if (forceRefresh) {
      info.partialMarkdown = '';
      info.entry = null;
    }

    updateButtonState(id, 'loading');
    if (activeDrawerStoryId === id) {
      renderDrawerLoading(info);
    }

    safeSendMessage(
      {
        type: 'GET_OR_GENERATE_GIST',
        storyId: id,
        title: info.title,
        storyUrl: info.storyUrl,
        commentCount: info.commentCount,
        forceRefresh
      },
      (response, lastErr) => {
        if (lastErr) {
          updateButtonState(id, 'error');
          if (activeDrawerStoryId === id) {
            renderDrawerError(info, lastErr.message);
          }
          return;
        }

        if (!response || !response.ok) {
          updateButtonState(id, 'error');
          if (activeDrawerStoryId === id) {
            renderDrawerError(info, response?.error || 'Failed to generate gist.');
          }
          return;
        }

        const entry = response.data;
        if (entry) {
          info.title = entry.title || info.title;
          if (Number.isFinite(entry.commentCount)) {
            info.commentCount = entry.commentCount;
          }
          info.entry = entry;
          info.partialMarkdown = '';
          updateButtonState(id, 'ready');
          if (activeDrawerStoryId === id) {
            renderDrawerContent(entry);
          }
        }
      },
      { reloadOnInvalidated: true }
    );
  }

  /**
   * Close the right-hand split drawer and restore page margin.
   */
  function closeDrawer() {
    if (!drawerElements) return;
    activeDrawerStoryId = null;
    drawerElements.aside.classList.remove('hn-gist-drawer--open');
    drawerElements.aside.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('hn-gist-drawer-open');
  }

  /**
   * Show skeleton loading UI inside the drawer while waiting for the first streamed token.
   */
  function renderDrawerLoading(info) {
    const els = ensureDrawerCreated();
    els.titleEl.textContent = info.title || `Story #${info.storyId}`;
    els.titleEl.href = `https://news.ycombinator.com/item?id=${encodeURIComponent(info.storyId)}`;
    els.metaEl.textContent = `${info.commentCount} comment${info.commentCount === 1 ? '' : 's'} • Summarizing with Gemini...`;
    els.refreshBtn.disabled = true;
    els.inputEl.disabled = true;
    els.sendBtn.disabled = true;
    els.chatSection.hidden = true;
    els.chatList.innerHTML = '';

    els.gistContainer.innerHTML = `
      <div class="hn-gist-skeleton" aria-busy="true">
        <div class="hn-gist-skeleton__status">Streaming summary from Gemini...</div>
        <div class="hn-gist-skeleton__line hn-gist-skeleton__line--heading"></div>
        <div class="hn-gist-skeleton__line"></div>
        <div class="hn-gist-skeleton__line"></div>
        <div class="hn-gist-skeleton__line hn-gist-skeleton__line--short"></div>
        <div class="hn-gist-skeleton__line hn-gist-skeleton__line--heading"></div>
        <div class="hn-gist-skeleton__line"></div>
        <div class="hn-gist-skeleton__line hn-gist-skeleton__line--medium"></div>
      </div>
    `;
  }

  /**
   * Render live streaming Markdown tokens in the drawer as they arrive.
   */
  function renderDrawerStreaming(info, partialMarkdown) {
    const els = ensureDrawerCreated();
    els.titleEl.textContent = info.title || `Story #${info.storyId}`;
    els.titleEl.href = `https://news.ycombinator.com/item?id=${encodeURIComponent(info.storyId)}`;
    els.metaEl.textContent = `${info.commentCount} comment${info.commentCount === 1 ? '' : 's'} • Streaming...`;
    els.refreshBtn.disabled = true;
    els.inputEl.disabled = true;
    els.sendBtn.disabled = true;

    els.gistContainer.innerHTML = `
      <article class="hn-gist-markdown">
        ${renderMarkdownToHtml(partialMarkdown)}
      </article>
    `;
  }

  /**
   * Show an error state inside the drawer (e.g. missing API key or network error).
   */
  function renderDrawerError(info, errorMessage) {
    const els = ensureDrawerCreated();
    els.titleEl.textContent = info.title || `Story #${info.storyId}`;
    els.titleEl.href = `https://news.ycombinator.com/item?id=${encodeURIComponent(info.storyId)}`;
    els.refreshBtn.disabled = false;
    els.inputEl.disabled = true;
    els.sendBtn.disabled = true;
    els.metaEl.textContent = `${info.commentCount} comment${info.commentCount === 1 ? '' : 's'} • Error`;

    els.gistContainer.innerHTML = `
      <div class="hn-gist-error">
        <div class="hn-gist-error__title">Unable to generate gist</div>
        <div class="hn-gist-error__message">${escapeHtml(errorMessage)}</div>
        <div class="hn-gist-error__hint">
          Check your Google AI Studio API key and selected model in the extension toolbar popup, then click <strong>[↻ Refresh]</strong>.
        </div>
      </div>
    `;
  }

  /**
   * Render the completed gist Markdown and any follow-up Q&A turns in the drawer.
   */
  function renderDrawerContent(entry) {
    const els = ensureDrawerCreated();
    const isFollowUpBusy = followUpInFlightStories.has(String(entry.storyId));

    els.titleEl.textContent = entry.title || `Story #${entry.storyId}`;
    els.titleEl.href = `https://news.ycombinator.com/item?id=${encodeURIComponent(entry.storyId)}`;
    els.metaEl.textContent = `${entry.commentCount} comment${entry.commentCount === 1 ? '' : 's'}`;
    els.refreshBtn.disabled = false;
    els.inputEl.disabled = isFollowUpBusy;
    els.sendBtn.disabled = isFollowUpBusy;

    els.gistContainer.innerHTML = `
      <article class="hn-gist-markdown">
        ${renderMarkdownToHtml(entry.gistMarkdown)}
      </article>
    `;

    renderChatHistory(entry.chatHistory || []);
  }

  /**
   * Render the follow-up Q&A messages below the gist.
   */
  function renderChatHistory(chatHistory) {
    const els = ensureDrawerCreated();
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
      els.chatSection.hidden = true;
      els.chatList.innerHTML = '';
      return;
    }

    els.chatSection.hidden = false;
    els.chatList.innerHTML = chatHistory
      .map((turn) => {
        if (turn.role === 'user') {
          return `
            <div class="hn-gist-chat-msg hn-gist-chat-msg--user">
              <div class="hn-gist-chat-msg__role">You</div>
              <div class="hn-gist-chat-msg__content">${escapeHtml(turn.text)}</div>
            </div>
          `;
        }
        return `
          <div class="hn-gist-chat-msg hn-gist-chat-msg--model">
            <div class="hn-gist-chat-msg__role">Gemini</div>
            <div class="hn-gist-chat-msg__content hn-gist-markdown">${renderMarkdownToHtml(
              turn.text
            )}</div>
          </div>
        `;
      })
      .join('');
  }

  /**
   * Send a follow-up question from the drawer footer input.
   */
  function submitFollowUpQuestion() {
    if (!activeDrawerStoryId || !drawerElements) return;
    const targetStoryId = String(activeDrawerStoryId);
    if (followUpInFlightStories.has(targetStoryId)) return;

    const question = drawerElements.inputEl.value.trim();
    if (!question) return;

    followUpInFlightStories.add(targetStoryId);
    drawerElements.inputEl.value = '';
    drawerElements.inputEl.disabled = true;
    drawerElements.sendBtn.disabled = true;

    // Optimistically show the user's question + thinking indicator
    drawerElements.chatSection.hidden = false;
    const pendingWrapper = document.createElement('div');
    pendingWrapper.className = 'hn-gist-chat-pending';
    pendingWrapper.innerHTML = `
      <div class="hn-gist-chat-msg hn-gist-chat-msg--user">
        <div class="hn-gist-chat-msg__role">You</div>
        <div class="hn-gist-chat-msg__content">${escapeHtml(question)}</div>
      </div>
      <div class="hn-gist-chat-msg hn-gist-chat-msg--model hn-gist-chat-msg--thinking">
        <div class="hn-gist-chat-msg__role">Gemini</div>
        <div class="hn-gist-chat-msg__content">Checking thread comments...</div>
      </div>
    `;
    drawerElements.chatList.appendChild(pendingWrapper);
    drawerElements.bodyEl.scrollTop = drawerElements.bodyEl.scrollHeight;

    safeSendMessage(
      {
        type: 'ASK_FOLLOWUP',
        storyId: targetStoryId,
        question
      },
      (response, lastErr) => {
        followUpInFlightStories.delete(targetStoryId);
        const info = storiesById.get(targetStoryId);
        if (info && response?.data) {
          info.entry = response.data;
        }

        if (!drawerElements || activeDrawerStoryId !== targetStoryId) return;

        drawerElements.inputEl.disabled = false;
        drawerElements.sendBtn.disabled = false;
        drawerElements.inputEl.focus();

        if (lastErr || !response || !response.ok) {
          const errMsg =
            lastErr?.message ||
            response?.error ||
            'Failed to get follow-up response.';
          const thinkingEl = pendingWrapper.querySelector(
            '.hn-gist-chat-msg--thinking .hn-gist-chat-msg__content'
          );
          if (thinkingEl) {
            thinkingEl.innerHTML = `<span class="hn-gist-inline-error">Error: ${escapeHtml(errMsg)}</span>`;
          }
          return;
        }

        if (response.data && Array.isArray(response.data.chatHistory)) {
          renderChatHistory(response.data.chatHistory);
          drawerElements.bodyEl.scrollTop = drawerElements.bodyEl.scrollHeight;
        }
      },
      { reloadOnInvalidated: true }
    );
  }

  /**
   * Parse story rows (tr.athing) and inject [⚡ Gist] button + zero-cost Algolia button hover prefetch.
   */
  function initHackerNewsDom() {
    const storyRows = document.querySelectorAll('tr.athing');

    storyRows.forEach((storyRow) => {
      // Skip comment rows on item?id=... pages (which have class "athing comtr")
      if (storyRow.classList.contains('comtr')) return;

      const storyId = storyRow.getAttribute('id');
      if (!storyId || storiesById.has(storyId)) return;

      const subtextRow = storyRow.nextElementSibling;
      if (!subtextRow) return;

      const subtextCell = subtextRow.querySelector('td.subtext');
      if (!subtextCell) return;

      // Locate the story title and external URL
      const titleLink =
        storyRow.querySelector('.titleline > a') || storyRow.querySelector('a.storylink');
      const title = titleLink ? titleLink.textContent.trim() : `HN Story #${storyId}`;
      const storyUrl = titleLink ? titleLink.href : '';

      // Locate the comments/discuss link inside the subtext row
      const subtextLinks = Array.from(subtextCell.querySelectorAll(`a[href*="item?id=${storyId}"]`));
      let commentsLink = null;
      let commentCount = 0;

      for (const link of subtextLinks) {
        const txt = link.textContent.trim();
        const match = txt.match(/^(\d+)\s*comments?$/i);
        if (match) {
          commentsLink = link;
          commentCount = parseInt(match[1], 10);
          break;
        }
        if (/^discuss$/i.test(txt)) {
          commentsLink = link;
          commentCount = 0;
        }
      }

      // Skip job postings that have no comments/discuss link
      if (!commentsLink) return;

      // Create separator and [⚡ Gist] button
      const separator = document.createTextNode(' | ');
      const gistBtn = document.createElement('button');
      gistBtn.type = 'button';
      gistBtn.className = 'hn-gist-btn';
      gistBtn.textContent = '[⚡ Gist]';
      gistBtn.setAttribute('data-story-id', storyId);

      commentsLink.insertAdjacentElement('afterend', gistBtn);
      commentsLink.parentNode.insertBefore(separator, gistBtn);

      const storyInfo = {
        storyId: String(storyId),
        title,
        storyUrl,
        commentCount,
        buttonEl: gistBtn,
        status: 'idle',
        partialMarkdown: '',
        entry: null
      };
      storiesById.set(String(storyId), storyInfo);

      // Zero-cost Algolia + article excerpt prefetch when hovering over the [⚡ Gist] button for 140ms
      let prefetchTimer = null;
      gistBtn.addEventListener('mouseenter', () => {
        if (storyInfo.commentCount <= 0 || storyInfo.status === 'ready') return;
        prefetchTimer = window.setTimeout(() => {
          prefetchTimer = null;
          safeSendMessage({
            type: 'PREFETCH_TRANSCRIPT',
            storyId: String(storyId),
            storyUrl
          });
        }, ALGOLIA_PREFETCH_DELAY_MS);
      });
      gistBtn.addEventListener('mouseleave', () => {
        if (prefetchTimer !== null) {
          clearTimeout(prefetchTimer);
          prefetchTimer = null;
        }
      });

      // Click-only Gemini trigger: opens the Right-Hand Split Drawer and starts generation (up to 5 concurrently)
      gistBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDrawerForStory(storyId);
      });
    });

    syncCachedStoryButtons();
  }

  /**
   * Query background worker on load (and on Back/Forward navigation) to mark cached stories [⚡ Gist Ready].
   */
  function syncCachedStoryButtons() {
    const allIds = Array.from(storiesById.keys());
    if (allIds.length === 0) return;

    safeSendMessage(
      {
        type: 'CHECK_CACHED_STORIES',
        storyIds: allIds
      },
      (response, lastErr) => {
        if (lastErr || !response || !response.ok) return;

        const cachedSet = new Set((response.cachedIds || []).map(String));
        const inFlightSet = new Set((response.inFlightIds || []).map(String));

        for (const id of allIds) {
          if (cachedSet.has(id)) {
            updateButtonState(id, 'ready');
          } else if (inFlightSet.has(id)) {
            updateButtonState(id, 'loading');
          }
        }
      }
    );
  }

  /**
   * Listen for background streaming chunks and status updates.
   */
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    const id = String(message.storyId || '');
    const info = storiesById.get(id);
    if (!info) return;

    if (message.type === 'STORY_GIST_STREAM') {
      info.partialMarkdown = message.partialMarkdown || '';
      if (message.title) info.title = message.title;
      if (Number.isFinite(message.commentCount)) info.commentCount = message.commentCount;
      if (activeDrawerStoryId === id) {
        renderDrawerStreaming(info, info.partialMarkdown);
      }
      return;
    }

    if (message.type === 'STORY_GIST_STATUS') {
      if (message.status === 'loading') {
        updateButtonState(id, 'loading');
      } else if (message.status === 'ready') {
        if (message.data) {
          info.entry = message.data;
          info.partialMarkdown = '';
        }
        updateButtonState(id, 'ready');
      } else if (message.status === 'error') {
        updateButtonState(id, 'error');
      }
    }
  });

  // Re-sync cached badges when navigating back/forward via browser BFCache
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      syncCachedStoryButtons();
    }
  });

  initHackerNewsDom();
})();
