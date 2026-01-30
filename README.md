# PDF Outline Editor

A modern Electron app for editing the outline (table of contents) of PDF files. It uses PDF.js for rendering and pdf-lib for writing updated outline metadata.

## Features
- Resizable outline pane with toolbar actions and context menu
- Drag-and-drop reordering and quick navigation
- Outline titles tied to the currently visible PDF page
- Save updated PDF with outline metadata

## Getting started

```bash
npm install
npm run download:fixture
npm start
```

## Troubleshooting (ELI5)

If you still see preload or PDF.js module errors, you might be running an older build. Here's a simple checklist:

1. **Check what code you have locally (no `rg` needed):**
   ```bash
   # Show the exact line that loads renderer.js (should NOT be type=\"module\")
   grep -n \"renderer.js\" src/renderer/index.html

   # Show the Electron window config (should NOT mention preload)
   grep -n \"preload\" -n src/main/main.js

   # Show the PDF.js legacy import in the renderer
   grep -n \"pdfjs-dist\" src/renderer/renderer.js
   ```

2. **Make a tiny change so you can re-push and be sure the right version is on GitHub:**
   ```bash
   echo \"# Build check $(date)\" >> README.md
   git add README.md
   git commit -m \"docs: add build check marker\"
   git push
   ```

3. **After pulling on your Mac, confirm you have the latest commit:**
   ```bash
   git log -1 --oneline
   ```

4. **Then run the app from the updated source:**
   ```bash
   npm install
   npm start
   ```

**Why conflicts can cause this:** if you resolved a merge conflict by keeping the *old* version of `main.js` or `renderer.js`, the app will still try to load the old preload or module imports. The commands above show you exactly what is in your local files.

## Testing

```bash
npm test
```
