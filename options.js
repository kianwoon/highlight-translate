document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const toggleBtn = document.getElementById('toggleBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');
  const customPromptInput = document.getElementById('customPrompt');

  // Load saved API key
  chrome.storage.local.get('geminiApiKey', function (data) {
    if (data.geminiApiKey) {
      apiKeyInput.value = data.geminiApiKey;
    }
  });

  chrome.storage.local.get('customPrompt', function (data) {
    if (data.customPrompt) {
      customPromptInput.value = data.customPrompt;
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
    const key = apiKeyInput.value.trim();
    if (!key) {
      statusDiv.textContent = 'Please enter an API key.';
      statusDiv.className = 'status error';
      return;
    }
    const prompt = customPromptInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key, customPrompt: prompt }, function () {
      statusDiv.textContent = 'Saved!';
      statusDiv.className = 'status success';
      setTimeout(function () {
        statusDiv.textContent = '';
      }, 2000);
    });
  });
});
