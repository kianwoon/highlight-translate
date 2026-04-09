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
  const ollamaSetupGuide = document.getElementById('ollamaSetupGuide');
  const ollamaStatus = document.getElementById('ollamaStatus');
  const ollamaInstructions = document.getElementById('ollamaInstructions');
  const modelSelect = document.getElementById('modelSelect');
  const endpointHelp = document.getElementById('endpointHelp');

  const DEFAULT_MODELS = {
    gemini: 'gemini-2.0-flash',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'qwen3:1.7b',
    codingplan: '',
    custom: '',
  };

  const PROVIDER_HELP = {
    gemini: { text: 'Get your API key from', url: 'https://aistudio.google.com/apikey', label: 'Google AI Studio' },
    openai: { text: 'Get your API key from', url: 'https://platform.openai.com/api-keys', label: 'OpenAI' },
    anthropic: { text: 'Get your API key from', url: 'https://console.anthropic.com/settings/keys', label: 'Anthropic Console' },
    openrouter: { text: 'Get your API key from', url: 'https://openrouter.ai/settings/keys', label: 'OpenRouter' },
    ollama: { text: 'Download Ollama from', url: 'https://ollama.com/download', label: 'ollama.com' },
    codingplan: { text: 'Use your coding plan subscription (GLM, MiniMax, etc.)', url: 'https://open.bigmodel.cn', label: 'bigmodel.cn (GLM)' },
    custom: null,
  };

  function setStatusWithDot(container, color, text) {
    container.textContent = '';
    var dot = document.createElement('span');
    dot.className = 'status-dot ' + color;
    container.appendChild(dot);
    container.appendChild(document.createTextNode(text));
  }

  function updateUIForProvider(provider) {
    // Update help link safely
    var help = PROVIDER_HELP[provider];
    if (help) {
      helpLink.classList.remove('hidden');
      while (helpLink.firstChild) helpLink.removeChild(helpLink.firstChild);
      helpLink.appendChild(document.createTextNode(help.text + ' '));
      var a = document.createElement('a');
      a.href = help.url;
      a.target = '_blank';
      a.textContent = help.label;
      helpLink.appendChild(a);
      helpLink.appendChild(document.createTextNode('.'));
    } else {
      helpLink.classList.add('hidden');
    }

    // Show/hide endpoint section
    var needsEndpoint = (provider === 'custom' || provider === 'codingplan');
    if (needsEndpoint) {
      customEndpointSection.classList.remove('hidden');
    } else {
      customEndpointSection.classList.add('hidden');
    }

    // Update endpoint help text
    if (provider === 'codingplan') {
      endpointHelp.textContent = 'Coding plan endpoint. Requests will include AI coding tool headers for plan recognition.';
      customEndpointInput.placeholder = 'e.g. https://open.bigmodel.cn/api/paas/v4';
    } else {
      endpointHelp.textContent = 'Base URL without /v1/chat/completions. Works with Groq, Together, Ollama, etc.';
      customEndpointInput.placeholder = 'e.g. https://api.groq.com/openai';
    }

    // Show/hide Ollama setup guide + model dropdown
    if (provider === 'ollama') {
      ollamaSetupGuide.classList.remove('hidden');
      modelInput.classList.add('hidden');
      modelSelect.classList.remove('hidden');
      checkOllamaConnection();
      discoverOllamaModels();
    } else {
      ollamaSetupGuide.classList.add('hidden');
      modelInput.classList.remove('hidden');
      modelSelect.classList.add('hidden');
    }

    // Update model placeholder
    if (provider === 'custom' || provider === 'codingplan') {
      modelInput.placeholder = 'Required';
    } else {
      modelInput.placeholder = 'Leave empty to use default';
    }
  }

  async function checkOllamaConnection() {
    setStatusWithDot(ollamaStatus, 'yellow', 'Checking connection...');
    ollamaInstructions.classList.add('hidden');
    try {
      var response = await fetch('http://localhost:11434/api/tags');
      if (response.ok) {
        setStatusWithDot(ollamaStatus, 'green', 'Ollama is running and connected.');
      } else if (response.status === 403) {
        setStatusWithDot(ollamaStatus, 'red', 'Ollama is running but blocking the extension (403).');
        ollamaInstructions.classList.remove('hidden');
      } else {
        setStatusWithDot(ollamaStatus, 'red', 'Ollama returned HTTP ' + response.status);
        ollamaInstructions.classList.remove('hidden');
      }
    } catch (e) {
      setStatusWithDot(ollamaStatus, 'red', 'Cannot reach Ollama. Make sure it\'s running on localhost:11434.');
      ollamaInstructions.classList.remove('hidden');
    }
  }

  async function discoverOllamaModels() {
    // Clear dropdown and add loading option
    modelSelect.textContent = '';
    var loadingOpt = document.createElement('option');
    loadingOpt.textContent = 'Detecting models...';
    loadingOpt.disabled = true;
    modelSelect.appendChild(loadingOpt);

    try {
      var response = await fetch('http://localhost:11434/api/tags');
      if (!response.ok) {
        modelSelect.textContent = '';
        var errOpt = document.createElement('option');
        errOpt.textContent = 'Could not fetch models — start Ollama first';
        errOpt.value = '';
        modelSelect.appendChild(errOpt);
        return;
      }
      var data = await response.json();
      var models = (data.models || []).map(function(m) { return m.name; });

      modelSelect.textContent = '';

      if (models.length === 0) {
        var emptyOpt = document.createElement('option');
        emptyOpt.textContent = 'No models installed — run: ollama pull qwen3:1.7b';
        emptyOpt.value = '';
        modelSelect.appendChild(emptyOpt);
        return;
      }

      // Get saved model
      var savedData = await chrome.storage.local.get('model');
      var savedModel = savedData.model || '';

      for (var i = 0; i < models.length; i++) {
        var opt = document.createElement('option');
        opt.value = models[i];
        opt.textContent = models[i];
        if (models[i] === savedModel) opt.selected = true;
        modelSelect.appendChild(opt);
      }

      // If no saved model matched, select the first one
      if (!savedModel && models.length > 0) {
        modelSelect.value = models[0];
      }

      console.log('[HT] Ollama models discovered:', models.join(', '));
    } catch (e) {
      modelSelect.textContent = '';
      var errOpt = document.createElement('option');
      errOpt.textContent = 'Could not fetch models — start Ollama first';
      errOpt.value = '';
      modelSelect.appendChild(errOpt);
      console.log('[HT] Ollama not running or not installed');
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
    var provider = providerSelect.value;
    updateUIForProvider(provider);
    modelInput.value = '';
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
    var provider = providerSelect.value;
    var key = apiKeyInput.value.trim();
    var model = (provider === 'ollama') ? modelSelect.value : modelInput.value.trim();
    var endpoint = customEndpointInput.value.trim();
    var prompt = customPromptInput.value.trim();
    var replyPrompt = replyPromptInput.value.trim();
    var summaryPrompt = summaryPromptInput.value.trim();

    // Validation
    if (!key && provider !== 'ollama') {
      statusDiv.textContent = 'Please enter an API key.';
      statusDiv.className = 'status error';
      return;
    }

    if ((provider === 'custom' || provider === 'codingplan') && !model) {
      statusDiv.textContent = 'Please enter a model name.';
      statusDiv.className = 'status error';
      return;
    }

    if ((provider === 'custom' || provider === 'codingplan') && !endpoint) {
      statusDiv.textContent = 'Please enter an endpoint URL.';
      statusDiv.className = 'status error';
      return;
    }

    // Strip trailing /v1/chat/completions if user accidentally included it
    if (endpoint) {
      endpoint = endpoint.replace(/\/v1\/chat\/completions\/?$/, '');
    }

    // Request optional permissions for providers with custom endpoints
    if (provider === 'custom' || provider === 'codingplan') {
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
    var data = { provider: provider, apiKey: key, customPrompt: prompt, replyPrompt: replyPrompt, summaryPrompt: summaryPrompt };
    if (model) data.model = model;
    if ((provider === 'custom' || provider === 'codingplan') && endpoint) data.customEndpoint = endpoint;

    chrome.storage.local.set(data, function () {
      statusDiv.textContent = 'Saved!';
      statusDiv.className = 'status success';
      setTimeout(function () {
        statusDiv.textContent = '';
      }, 2000);
    });
  }
});
