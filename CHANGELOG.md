# Changelog

All notable changes to PDF Outline Editor are documented here.

## [0.4.0] - Improved headings detection in PDF

- Match TOC headings using PDF layout, joined small-cap fragments, multiline text and typography instead of scattered words across a page.
- Detect printed folios above watermarks and handle reordered sections, missing sheets and bounded gaps without assuming a single page offset.
- Exclude TOC pages and repeated margins from heading search. Missing parent headings point to their first available child and remain uncertain.
- Run layout indexing and heading matching in a background worker, yield during source text extraction and terminate the worker on cancellation so the import dialog remains responsive.
- Keep the AI checkbox inline with its label rather than inheriting full-width text-input styling.
- Add optional AI matching of locally shortlisted heading snippets, limited to 3 requests, 18 KB of complete prompts and 1,500 output tokens per request. Validate returned candidates and quotes; retain local results on provider failure.
- On the supplied George manual: 458 of 465 entries verified locally, 6 missing parent headings mapped to available children, 1 missing heading; zero AI requests.
- Synchronize package/lockfile name, version and dependency metadata; check consistency in `npm run lint`.

## [0.3.2] - Adding OpenAI compatible endpoint

## [0.3.0] - Refactoring Release

### Changed - Code Architecture

The monolithic `renderer.js` (1191 lines) has been split into 9 focused modules for better maintainability:

| File | Purpose | Lines |
|------|---------|-------|
| `renderer.js` | Main entry point, wires up components | ~190 |
| `state.js` | Application state & selection helpers | ~90 |
| `history.js` | Undo/redo management | ~80 |
| `outline-actions.js` | Add, delete, move, adjust level operations | ~160 |
| `outline-renderer.js` | Outline list rendering with drag/drop | ~360 |
| `pdf-viewer.js` | PDF rendering and navigation | ~120 |
| `file-operations.js` | Load/save PDF operations | ~125 |
| `context-menu.js` | Right-click menu handling | ~50 |
| `page-modal.js` | Page number input modal | ~55 |
| `keyboard.js` | Keyboard shortcuts | ~155 |

### Fixed - Logical Issues

1. **Improved `shouldHideItem()` algorithm** - Simplified ancestor traversal logic with early termination when current level reaches 0, making it more efficient and easier to understand.

2. **Optimized `refreshOutline()` performance** - Added `precomputeTreeData()` function that pre-calculates tree structure data in fewer passes instead of recalculating for each item. This improves performance for large outlines.

### Added - Error Handling

- Added comprehensive try/catch blocks with user-friendly error messages in file operations:
  - `loadPdfData()` - Shows error if PDF fails to load
  - `handleFileDrop()` - Shows error if dropped file can't be opened
  - `requestOpenPdf()` - Shows error if PDF dialog/load fails
  - `requestSavePdf()` - Shows error if save fails
  - `requestSavePdfAs()` - Shows error if save-as fails

### Improved - Code Quality

1. **ES Modules** - Updated `index.html` to use `type="module"` for the renderer script, enabling proper ES module imports across all files.

2. **Callback injection pattern** - Modules that need to trigger UI refreshes use a callback injection pattern (`setRefreshCallback()`) to avoid circular dependencies.

3. **DocumentFragment usage** - Outline rendering uses DocumentFragment for batched DOM operations, reducing reflows.

4. **Consistent naming** - Standardized function and variable names across modules.

---

## [0.2.0] - Feature Complete Release

### Added

- **Multi-select support** - Select multiple outline items with CMD/CTRL+click (toggle) or SHIFT+click (range)
- **Comprehensive keyboard shortcuts**:
  - `⌘O` - Open PDF
  - `⌘S` - Save PDF
  - `⌘⇧S` - Save PDF As
  - `⌘T` - Add title
  - `⌘⇧T` - Add nested title
  - `⌘Z` / `⌘⇧Z` - Undo / Redo
  - `⌘Y` - Redo
  - `⌘A` - Select all
  - `Arrow keys` - Navigate outline
  - `⌘+Arrow keys` - Move/indent items
  - `F2` / `Enter` - Rename
  - `Delete` / `Backspace` - Delete selected

- **Undo/Redo with action names** - Up to 10 history steps with descriptive tooltips
- **Dirty state tracking** - Asterisk (*) indicator when document has unsaved changes
- **Unsaved changes dialog** - Prompt before closing with options to save, discard, or cancel
- **Fit to width button** - Auto-zoom PDF to fit viewer width
- **Filename display** - Shows current file name in header

### Fixed

- **Production build paths** - Proper detection of node_modules in asar-unpacked directory
- **Level hierarchy validation** - Items can't exceed parent level + 1
- **Drag indicator positioning** - Visual indicator shows above/below target correctly
- **Shift+arrow key detection** - Consistent behavior across keyboard layouts

---

## [0.1.0] - Initial Release

### Added

- PDF outline (table of contents) viewing and editing
- Add, rename, and delete outline entries
- Adjust entry indentation levels
- Drag and drop to reorder entries
- Set target page for each entry
- Expand/collapse nested entries
- Tree view with visual connectors
- PDF page navigation and zoom
- Open PDF via dialog or drag & drop
- Save with automatic backup creation

### Technical

- Built with Electron 30.0.0
- Uses pdf-lib for PDF manipulation
- Uses pdfjs-dist for PDF rendering
- Cross-platform support (macOS, Windows, Linux)
