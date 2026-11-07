// popup.js - Settings & Dynamic Gemini Model Selector for HN Gist Drawer

const DEFAULT_MODEL = 'gemini-flash-latest';
const BUILTIN_MODELS = ['gemini-flash-latest', 'gemini-3.8-flash'];

const apiKeyInput = document.getElementById('apiKeyInput');
const toggleKeyBtn = document.getElementById('toggleKeyBtn');
const modelSelect = document.getElementById('modelSelect');
const fetchModelsBtn = document.getElementById('fetchModelsBtn');
const saveBtn = document.getElementById('saveBtn');
const statusMessage = document.getElementById('statusMessage');
const cacheCountBadge = document.getElementById('cacheCountBadge');
const clearCacheBtn = document.getElementById('clearCacheBtn');

function showStatus(text, type = 'info') {
  statusMessage.textContent = text;
  statusMessage.className = `status-msg status-msg--${type}`;
}

/**
 * Populate the model <select> dropdown while ensuring `gemini-flash-latest` and the active selection exist.
 */
function populateModelDropdown(modelsList, selectedModel) {
  const activeModel = (selectedModel || DEFAULT_MODEL).replace(/^models\//, '');
  const uniqueIds = new Set(BUILTIN_MODELS);

  if (Array.isArray(modelsList)) {
    for (const modelId of modelsList) {
      const cleanId = String(modelId).replace(/^models\//, '').trim();
      if (cleanId) uniqueIds.add(cleanId);
    }
  }
  uniqueIds.add(activeModel);

  modelSelect.innerHTML = '';
  for (const id of uniqueIds) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id === DEFAULT_MODEL ? `${id} (Default)` : id;
    if (id === activeModel) {
      option.selected = true;
    }
    modelSelect.appendChild(option);
  }
}

/**
 * Fetch available Gemini models supporting generateContent from Google AI Studio API.
 */
async function fetchAvailableModels({ silent = false } = {}) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    if (!silent) {
      showStatus('Please enter your Google AI Studio API Key first.', 'error');
    }
    return;
  }

  fetchModelsBtn.disabled = true;
  fetchModelsBtn.textContent = 'Fetching...';
  if (!silent) {
    showStatus('Fetching models from Google AI Studio...', 'info');
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const msg = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const models = Array.isArray(data?.models) ? data.models : [];
    const supportedModels = models
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          typeof m.name === 'string'
      )
      .map((m) => m.name.replace(/^models\//, ''))
      // Prioritize gemini-* models cleanly
      .sort((a, b) => {
        if (a === DEFAULT_MODEL) return -1;
        if (b === DEFAULT_MODEL) return 1;
        const aFlash = a.includes('flash') ? 0 : 1;
        const bFlash = b.includes('flash') ? 0 : 1;
        if (aFlash !== bFlash) return aFlash - bFlash;
        return a.localeCompare(b);
      });

    const currentSelection = modelSelect.value || DEFAULT_MODEL;
    populateModelDropdown(supportedModels, currentSelection);

    await chrome.storage.local.set({ availableModels: supportedModels });

    if (!silent) {
      showStatus(`Loaded ${supportedModels.length} compatible models.`, 'success');
    }
  } catch (err) {
    if (!silent) {
      showStatus(`Failed to fetch models: ${err.message || err}`, 'error');
    }
  } finally {
    fetchModelsBtn.disabled = false;
    fetchModelsBtn.textContent = 'Fetch Models';
  }
}

/**
 * Update the session cache badge showing how many stories are stored in the 25-story ring buffer.
 */
async function refreshSessionCacheStats() {
  try {
    const { lruOrder = [] } = await chrome.storage.session.get(['lruOrder']);
    const count = Array.isArray(lruOrder) ? lruOrder.length : 0;
    cacheCountBadge.textContent = `${count} / 25 cached`;
  } catch (_) {
    cacheCountBadge.textContent = '0 / 25 cached';
  }
}

/**
 * Initialize popup state from chrome.storage.local and chrome.storage.session.
 */
async function initPopup() {
  const {
    apiKey = '',
    selectedModel = DEFAULT_MODEL,
    availableModels = []
  } = await chrome.storage.local.get(['apiKey', 'selectedModel', 'availableModels']);

  apiKeyInput.value = apiKey;
  populateModelDropdown(availableModels, selectedModel || DEFAULT_MODEL);
  await refreshSessionCacheStats();

  // Auto-fetch available models on open if an API key is already saved
  if (apiKey.trim()) {
    fetchAvailableModels({ silent: true });
  }
}

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
});

fetchModelsBtn.addEventListener('click', () => {
  fetchAvailableModels({ silent: false });
});

saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const selectedModel = (modelSelect.value || DEFAULT_MODEL).trim();

  if (!apiKey) {
    showStatus('Please enter a valid Google AI Studio API Key.', 'error');
    return;
  }

  await chrome.storage.local.set({
    apiKey,
    selectedModel
  });

  showStatus(`Saved! Active model: ${selectedModel}`, 'success');
  fetchAvailableModels({ silent: true });
});

modelSelect.addEventListener('change', async () => {
  const selectedModel = (modelSelect.value || DEFAULT_MODEL).trim();
  await chrome.storage.local.set({ selectedModel });
  showStatus(`Active model set to ${selectedModel}`, 'success');
});

clearCacheBtn.addEventListener('click', async () => {
  await chrome.storage.session.clear();
  await refreshSessionCacheStats();
  showStatus('Cleared session summary cache.', 'info');
});

initPopup();
