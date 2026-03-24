# Highlight Translate

Select text on any webpage and instantly translate it to Chinese, or improve your writing with AI-powered Grammar & Humanize.

![Release](https://img.shields.io/badge/Release-v1.1.0-green) ![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Coming%20Soon-blue) ![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- Highlight any text on a webpage to translate to Chinese
- Grammar & Humanize (sparkle icon) -- improve, rewrite, or polish selected text using Gemini AI
- Custom prompt support -- define your own improvement instructions (e.g. "make it professional")
- Inline translate icon appears near selection
- Instant popup with translation or improved results
- Supports single words and full sentences
- Auto-detects source language
- Works on all websites, including LinkedIn post editors
- Compatible with Chrome and Brave browsers

## Installation

### Option 1: Download from GitHub Release (Recommended)

1. [Download `highlight-translate-v1.1.0.zip`](https://github.com/kianwoon/highlight-translate/releases/download/v1.1.0/highlight-translate-v1.1.0.zip)
2. Extract the zip file to a folder on your computer
3. Open Chrome or Brave and go to `chrome://extensions/`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the extracted folder
6. The extension icon will appear in your toolbar

### Option 2: Install from Source

1. Clone this repository
2. Open Chrome or Brave and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select this project folder
5. The extension icon will appear in your toolbar

## How to Use

1. Navigate to any webpage
2. Select (highlight) the text you want to translate or improve
3. Click the translate icon to get a Chinese translation, or click the sparkle icon to improve the text
4. A popup with the result appears -- copy it to clipboard with one click

## Settings

After installing the extension, right-click the toolbar icon and select **Options** (or go to `chrome://extensions/`, find Highlight Translate, and click **Details > Extension options**).

### Gemini API Key (required for Grammar & Humanize)

The Grammar & Humanize feature uses Google Gemini. You need a free API key:

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and generate an API key
2. Paste the key into the **Gemini API Key** field in Settings
3. Click **Save**

The translate feature continues to work without an API key (it uses Google Translate). Only the sparkle icon requires a Gemini key.

### Custom Prompt (optional)

You can customize the improvement instructions used by the sparkle icon. Enter any prompt in the **Custom Prompt** field, for example:

- "Make the sentence neat, professional, and with a human tone"
- "Rewrite this in a more formal academic style"
- "Simplify this for a general audience"

Leave it empty to use the default prompt.

## Privacy

Your privacy matters. This extension only sends the selected text to the Google Translate API (for translation) or the Gemini API (for Grammar & Humanize when enabled). No other data is collected, stored, or transmitted. Your API key is stored locally in your browser.

[Privacy Policy](https://kianwoon.github.io/highlight-translate/)

## Tech Stack

![Manifest V3](https://img.shields.io/badge/Chrome%20Manifest-V3-4285F4)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript&logoColor=black)
![Google Translate](https://img.shields.io/badge/API-Google%20Translate-34A853)
![Gemini](https://img.shields.io/badge/API-Google%20Gemini-4285F4)

## License

[MIT](https://opensource.org/licenses/MIT) &mdash; Built by [kianwoon](https://github.com/kianwoon)
