# PDF Outline Editor

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/electron-30.0.0-47848F?logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

A powerful desktop application for viewing and editing PDF outline (table of contents) metadata. Create, modify, and reorganize your PDF bookmarks with an intuitive visual interface.

## ✨ Features

### Outline Management
- **Add/Remove entries** - Create new outline items or delete existing ones
- **Nested structure** - Support for hierarchical outlines up to 6 levels deep
- **Inline editing** - Double-click or press F2 to rename entries
- **Page targeting** - Set which page each outline entry links to

### Visual Interface
- **Tree view** - Clean hierarchical display with connecting lines
- **Expand/Collapse** - Show or hide nested children
- **Multi-select** - Select multiple items with CMD/CTRL+click or SHIFT+click
- **Drag & drop** - Reorder entries by dragging with visual drop indicators

### PDF Viewer
- **Built-in preview** - View PDF pages alongside the outline
- **Zoom control** - Slider from 50% to 200%
- **Fit to width** - One-click optimal zoom
- **Page navigation** - Previous/next buttons and page indicator
- **Click to navigate** - Click outline entries to jump to their target page

### Editing Features
- **Undo/Redo** - Up to 10 history steps with descriptive action names
- **Keyboard shortcuts** - Full keyboard navigation and editing
- **Unsaved changes warning** - Prompt before closing modified documents
- **Auto-backup** - Creates `.backup` file before overwriting

## ⌨️ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open PDF | `⌘O` / `Ctrl+O` |
| Save | `⌘S` / `Ctrl+S` |
| Save As | `⌘⇧S` / `Ctrl+Shift+S` |
| Add title | `⌘T` / `Ctrl+T` |
| Add nested title | `⌘⇧T` / `Ctrl+Shift+T` |
| Undo | `⌘Z` / `Ctrl+Z` |
| Redo | `⌘⇧Z` / `⌘Y` / `Ctrl+Y` |
| Select all | `⌘A` / `Ctrl+A` |
| Navigate | `↑` `↓` |
| Extend selection | `⇧↑` `⇧↓` |
| Move item | `⌘↑` `⌘↓` |
| Indent/Outdent | `⌘→` `⌘←` |
| Expand/Collapse | `→` `←` |
| Rename | `F2` or `Enter` |
| Delete | `Delete` or `Backspace` |

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 18 or higher
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/pdf-toc-editor.git
cd pdf-toc-editor

# Install dependencies
npm install

# Start the application
npm start
```

### Building for Distribution

```bash
# Build for current platform
npm run build

# Build for specific platform
npm run build:mac
npm run build:win
npm run build:linux
```

Built packages are output to the `dist/` directory.

## 🛠️ Technology Stack

| Component | Technology |
|-----------|------------|
| Framework | [Electron](https://www.electronjs.org/) 30.0.0 |
| PDF Rendering | [PDF.js](https://mozilla.github.io/pdf.js/) (pdfjs-dist) |
| PDF Manipulation | [pdf-lib](https://pdf-lib.js.org/) |
| Packaging | [electron-builder](https://www.electron.build/) |
| Module System | ES Modules |

## 📖 How It Works

1. **Opening a PDF**: The app uses PDF.js to render pages and pdf-lib to extract existing outline metadata.

2. **Editing**: Changes are stored in memory as a flat array with level information. The tree structure is computed dynamically for display.

3. **Saving**: pdf-lib rebuilds the outline tree from the flat array and writes it to the PDF's catalog with proper parent/child/sibling references.

### Importing a table of contents

Import a TOC from JSON, text, an external PDF, or selected pages of the current PDF. AI extracts the TOC when needed; JSON imports skip extraction. Heading matching scans the current PDF locally, uses printed page numbers and layout, and ignores TOC pages and repeated headers/watermarks. It handles split text fragments, multiline headings, accents, ligatures and hyphenation.

Layout indexing and matching run in a background worker so the dialog remains responsive. Cancel stops the worker and preserves the current outline.

Enable **Use AI to help match ambiguous headings** for an optional second step using the selected provider. It sends only locally shortlisted heading snippets, never the full PDF. Each import allows at most 3 requests, 18 KB of complete prompts total and 1,500 output tokens per request. Input tokens vary by model; the prompt limit is measured in UTF-8 bytes. For OpenAI, [the output cap includes reasoning tokens](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). A rejected, truncated or failed AI response leaves the local results intact. No suitable candidates means no requests; AI suggestions remain orange for review.

Black entries have strong local heading evidence. Orange entries need review (including missing parent sheets linked to their first available child). Red entries could not be located. A missing page is never reconstructed by extrapolating a global offset. Image-only body pages still need OCR before local heading matching can work; the optional step resolves text candidates rather than reading every page with vision.

Use `npm version patch --no-git-tag-version` (or `minor`) for future version bumps so `package.json` and both root version fields in `package-lock.json` stay synchronized. `npm run lint` checks their names, versions and dependency metadata.

## 🧪 Running Tests

```bash
npm test
```

The George manual regression also runs when the supplied PDF and JSON are present in `tests/samples/`; it skips when those local files are absent. No tests call a paid AI provider.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📜 Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed history of changes.
