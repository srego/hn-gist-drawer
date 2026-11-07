# Privacy Policy for HN Gist Drawer

**Last Updated:** November 7, 2026

**HN Gist Drawer** is an open-source, client-side Chrome Extension that summarizes Hacker News articles and comment threads using the user's own Google AI Studio (Gemini) API key.

## 1. No Personal Data Collection
HN Gist Drawer does **not** collect, store, log, sell, or transmit any personal data, browsing history, or analytics to any developer-owned server or third party. The extension has no backend server, no analytics scripts, and no tracking mechanisms.

## 2. How Your API Key & Data Are Stored Locally
- **API Key (`chrome.storage.local`):** When you enter your Google AI Studio API key in the extension popup, it is stored exclusively on your local device inside Chrome's isolated extension storage (`chrome.storage.local`). It is never accessible to webpages or other extensions, and it is only transmitted over HTTPS directly from your browser to Google's official Generative Language API (`https://generativelanguage.googleapis.com/*`) to fulfill your summarization requests.
- **Session Summary Cache (`chrome.storage.session`):** Generated thread summaries ("gists") and follow-up Q&A turns are temporarily cached in in-memory session storage (`chrome.storage.session`, capped at the 25 most recent stories) while your browser is open and are automatically cleared when Chrome quits.

## 3. Direct Network Requests
When you click `[⚡ Gist]` on `https://news.ycombinator.com/*`, your browser makes direct HTTPS requests only to:
1. **`https://hn.algolia.com/*`** — to retrieve public Hacker News comment threads.
2. **The linked story URL** — to retrieve a lightweight excerpt of the public article being discussed.
3. **`https://generativelanguage.googleapis.com/*`** — to generate the summary and answer follow-up questions using your personal API key.

## 4. Contact
If you have any questions or concerns regarding this privacy policy, please open an issue at:
https://github.com/srego/hn-gist-drawer/issues
