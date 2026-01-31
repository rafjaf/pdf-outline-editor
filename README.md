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

## 📁 Project Structure

```
pdf-toc-editor/
├── src/
│   ├── main/
│   │   ├── main.js          # Electron main process
│   │   └── preload.js       # (unused, kept for compatibility)
│   ├── renderer/
│   │   ├── index.html       # Application UI
│   │   ├── styles.css       # Styling
│   │   ├── renderer.js      # Main entry point
│   │   ├── state.js         # Application state
│   │   ├── history.js       # Undo/redo management
│   │   ├── outline-actions.js    # Outline manipulation
│   │   ├── outline-renderer.js   # Outline display
│   │   ├── pdf-viewer.js    # PDF rendering
│   │   ├── file-operations.js    # File I/O
│   │   ├── context-menu.js  # Right-click menu
│   │   ├── page-modal.js    # Page input dialog
│   │   └── keyboard.js      # Keyboard shortcuts
│   └── shared/
│       └── outline.js       # PDF outline extraction/writing
├── tests/
│   └── outline.test.js      # Unit tests
├── scripts/
│   ├── download-fixture.js  # Test file downloader
│   └── lint-config.js       # Configuration checker
├── package.json
├── CHANGELOG.md
└── README.md
```

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

## 🧪 Running Tests

```bash
npm test
```

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
