# <img src="icons/icon128.png" width="36" height="36" align="absmiddle" alt="HN Gist Drawer Logo" /> HN Gist Drawer (v1.0)

A fast, zero-build Manifest V3 Chrome Extension that lets you read Gemini-powered summaries ("gists") and ask follow-up questions for Hacker News stories and comment threads directly on `https://news.ycombinator.com/*` in a right-hand split drawer—without leaving the page.

---

## ✨ Features

- **"What It's About" + Comment Thread Gist:**
  - Automatically fetches a lightweight excerpt of the linked article in parallel with the Algolia HN comment tree so every summary begins with a 2–3 sentence overview of **what the article/post is about**, followed by the main camps of opinion, high-signal firsthand insights, sentiment on tools/products mentioned, and standout links.
- **Click-to-Generate with 5x Parallel Concurrency:**
  - Injects a compact `[⚡ Gist]` button next to the comments link on every story (`[⚡ Gist]` → `[⏳ Loading...]` → `[⚡ Gist Ready]`).
  - Zero wasted background LLM calls—summaries only run when you click `[⚡ Gist]`, and you can click up to **5 stories concurrently** while reading.
- **Sub-2s Live Streaming (`streamGenerateContent`):**
  - Uses Server-Sent Events (SSE) with minimal thinking overhead (`thinkingLevel: "MINIMAL"`) and an engagement-weighted Breadth-First comment selector (~8k tokens) so summaries start rendering live in the drawer in ~1–1.5 seconds.
  - Hovering over `[⚡ Gist]` for 140ms quietly prefetches the free Algolia comment JSON + article excerpt so data is already in memory the instant you click.
- **Right-Hand Split Drawer:**
  - Docks a fixed slide-over drawer (`width: 38vw`) on the right side of the viewport and smoothly shifts the Hacker News page (`margin-right: 38vw`) so the story list is never covered up.
- **Contextual Follow-Up Q&A:**
  - Ask follow-up questions at the bottom of the drawer grounded in the thread's comment transcript, initial gist, and prior Q&A turns.
- **Strict Memory Footprint (25-Story Session Ring Buffer):**
  - Stores your Google AI Studio API key and selected model (defaulting to `gemini-flash-latest` / `gemini-3.8-flash`) exclusively in `chrome.storage.local`.
  - Stores generated gists and follow-up chat histories in `chrome.storage.session` (capped at the **last 25 stories** via strict LRU eviction) so summaries persist across page reloads and Back-button navigation while Chrome is open, and wipe automatically when Chrome quits.

---

## 🚀 Installation

No bundler or build step is required.

1. Clone this repository:
   ```bash
   git clone https://github.com/srego/hn-gist-drawer.git
   ```
2. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** (top-left) and select the `hn-gist-drawer` directory.

---

## 🔑 Configuration & Usage

1. Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
   - *Tip:* Google AI Studio's Free Tier limits `gemini-3.8-flash` to 20 requests/day. Linking a Cloud Billing account (Tier 1 Pay-As-You-Go or Google Cloud credits) unlocks thousands of requests per day at ~\$0.002 per summary.
2. Click the **⚡ HN Gist Drawer** icon in your Chrome toolbar, paste your API key, and click **Save Settings**.
   - Click **Fetch Models** anytime to dynamically populate the dropdown with all `generateContent`-capable Gemini models available to your key.
3. Visit [Hacker News](https://news.ycombinator.com/):
   - Click **`[⚡ Gist]`** on any story (or up to 5 stories in parallel) to open the right-hand split drawer and stream the summary.
   - Ask follow-up questions in the sticky footer input (`Ask a follow-up about this thread...`).
   - Click **`[↻ Refresh]`** in the drawer header to force a fresh fetch, or press **`Esc`** / **`[✕]`** to close the drawer.

---

## 📁 Repository Structure

```text
hn-gist-drawer/
├── manifest.json       # Manifest V3 configuration & custom icons
├── background.js       # Service worker: Algolia BFS selector, article excerpt fetcher, Gemini SSE streaming, 25-story session LRU cache
├── content.js          # HN DOM injection, Algolia hover prefetch, and Right-Hand Split Drawer UI
├── styles.css          # Hacker News-matched styling and split-screen layout
├── popup.html          # Extension toolbar settings popup
├── popup.js            # API key storage and dynamic Gemini model fetching
├── icons/              # Custom extension icons (16px, 32px, 48px, 128px)
├── .gitignore          # Git ignore rules
└── README.md           # Documentation
```
