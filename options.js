document.addEventListener('DOMContentLoaded', function () {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const toggleBtn = document.getElementById('toggleBtn');
  const modelInput = document.getElementById('model');
  const customEndpointSection = document.getElementById('customEndpointSection');
  const customEndpointInput = document.getElementById('customEndpoint');
  const customPromptInput = document.getElementById('customPrompt');
  const replyPromptInput = document.getElementById('replyPrompt');
  const summaryPromptInput = document.getElementById('summaryPrompt');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');
  const helpLink = document.getElementById('helpLink');
  const helpUrl = document.getElementById('helpUrl');

  const DEFAULT_MODELS = {
    gemini: 'gemini-2.0-flash',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    custom: '',
  };

  const PROVIDER_HELP = {
    gemini: { text: 'Get your API key from', url: 'https://aistudio.google.com/apikey', label: 'Google AI Studio' },
    openai: { text: 'Get your API key from', url: 'https://platform.openai.com/api-keys', label: 'OpenAI' },
    anthropic: { text: 'Get your API key from', url: 'https://console.anthropic.com/settings/keys', label: 'Anthropic Console' },
    custom: null,
  };

  function updateUIForProvider(provider) {
    // Update help link
    const help = PROVIDER_HELP[provider];
    if (help) {
      helpLink.classList.remove('hidden');
      helpUrl.href = help.url;
      helpUrl.textContent = help.label;
      helpLink.innerHTML = help.text + ' <a id="helpUrl" href="' + help.url + '" target="_blank">' + help.label + '</a>.';
    } else {
      helpLink.classList.add('hidden');
    }

    // Show/hide custom endpoint
    if (provider === 'custom') {
      customEndpointSection.classList.remove('hidden');
    } else {
      customEndpointSection.classList.add('hidden');
    }

    // Update model placeholder
    if (provider === 'custom') {
      modelInput.placeholder = 'Required for custom provider';
    } else {
      modelInput.placeholder = 'Leave empty to use default';
    }
  }

  // Load saved settings
  chrome.storage.local.get(['provider', 'apiKey', 'model', 'customEndpoint', 'customPrompt', 'replyPrompt', 'summaryPrompt'], function (data) {
    if (data.provider) {
      providerSelect.value = data.provider;
    }
    if (data.apiKey) {
      apiKeyInput.value = data.apiKey;
    }
    if (data.model) {
      modelInput.value = data.model;
    }
    if (data.customEndpoint) {
      customEndpointInput.value = data.customEndpoint;
    }
    if (data.customPrompt) {
      customPromptInput.value = data.customPrompt;
    }
    if (data.replyPrompt) {
      replyPromptInput.value = data.replyPrompt;
    }
    if (data.summaryPrompt) {
      summaryPromptInput.value = data.summaryPrompt;
    }
    updateUIForProvider(providerSelect.value);
  });

  // Provider change handler
  providerSelect.addEventListener('change', function () {
    const provider = providerSelect.value;
    updateUIForProvider(provider);

    // Auto-fill model with provider default (overwrites user override)
    const defaultModel = DEFAULT_MODELS[provider];
    if (defaultModel) {
      modelInput.value = '';
    } else {
      modelInput.value = '';
    }
  });

  // Show/hide toggle
  toggleBtn.addEventListener('click', function () {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      toggleBtn.textContent = 'Show';
    }
  });

  // Save
  saveBtn.addEventListener('click', function () {
    const provider = providerSelect.value;
    const key = apiKeyInput.value.trim();
    const model = modelInput.value.trim();
    let endpoint = customEndpointInput.value.trim();
    const prompt = customPromptInput.value.trim();
    const replyPrompt = replyPromptInput.value.trim();
    const summaryPrompt = summaryPromptInput.value.trim();

    // Validation
    if (!key) {
      statusDiv.textContent = 'Please enter an API key.';
      statusDiv.className = 'status error';
      return;
    }

    if (provider === 'custom' && !model) {
      statusDiv.textContent = 'Please enter a model name for the custom provider.';
      statusDiv.className = 'status error';
      return;
    }

    if (provider === 'custom' && !endpoint) {
      statusDiv.textContent = 'Please enter a custom endpoint URL.';
      statusDiv.className = 'status error';
      return;
    }

    // Strip trailing /v1/chat/completions if user accidentally included it
    if (endpoint) {
      endpoint = endpoint.replace(/\/v1\/chat\/completions\/?$/, '');
    }

    // Request optional permissions for custom provider
    if (provider === 'custom') {
      chrome.permissions.request({
        origins: [endpoint + '/*']
      }, function (granted) {
        if (granted) {
          saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt);
        } else {
          statusDiv.textContent = 'Permission denied. The extension needs access to the custom endpoint.';
          statusDiv.className = 'status error';
        }
      });
    } else {
      saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt);
    }
  });

  function saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt) {
    const data = { provider: provider, apiKey: key, customPrompt: prompt, replyPrompt: replyPrompt, summaryPrompt: summaryPrompt };
    if (model) data.model = model;
    if (provider === 'custom' && endpoint) data.customEndpoint = endpoint;

    chrome.storage.local.set(data, function () {
      statusDiv.textContent = 'Saved!';
      statusDiv.className = 'status success';
      setTimeout(function () {
        statusDiv.textContent = '';
      }, 2000);
    });
  }
});
