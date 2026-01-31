/**
 * Generate app icons for PDF TOC Editor
 * Creates a simple SVG-based icon and converts to PNG sizes needed for macOS
 * 
 * Run: node scripts/generate-icons.js
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const buildDir = join(__dirname, '..', 'build');

if (!existsSync(buildDir)) {
  mkdirSync(buildDir, { recursive: true });
}

// Create SVG icon
const svgIcon = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#4f46e5;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="docGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#ffffff;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#f1f5f9;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Background rounded square -->
  <rect x="64" y="64" width="896" height="896" rx="180" ry="180" fill="url(#bgGrad)"/>
  
  <!-- Document shadow -->
  <rect x="260" y="170" width="520" height="680" rx="30" ry="30" fill="rgba(0,0,0,0.2)" transform="translate(10, 10)"/>
  
  <!-- Document -->
  <rect x="260" y="170" width="520" height="680" rx="30" ry="30" fill="url(#docGrad)"/>
  
  <!-- Document fold -->
  <path d="M680 170 L780 270 L680 270 Z" fill="#e2e8f0"/>
  <path d="M680 170 L780 270" stroke="#cbd5e1" stroke-width="2" fill="none"/>
  
  <!-- TOC lines representing outline hierarchy -->
  <!-- Level 0 items -->
  <rect x="320" y="320" width="400" height="24" rx="6" fill="#6366f1"/>
  <rect x="320" y="480" width="400" height="24" rx="6" fill="#6366f1"/>
  <rect x="320" y="640" width="400" height="24" rx="6" fill="#6366f1"/>
  
  <!-- Level 1 items (indented) -->
  <rect x="370" y="370" width="300" height="20" rx="5" fill="#a5b4fc"/>
  <rect x="370" y="410" width="280" height="20" rx="5" fill="#a5b4fc"/>
  <rect x="370" y="530" width="320" height="20" rx="5" fill="#a5b4fc"/>
  <rect x="370" y="570" width="260" height="20" rx="5" fill="#a5b4fc"/>
  
  <!-- Level 2 items (more indented) -->
  <rect x="420" y="690" width="240" height="16" rx="4" fill="#c7d2fe"/>
  <rect x="420" y="720" width="200" height="16" rx="4" fill="#c7d2fe"/>
  
  <!-- Tree connector lines -->
  <path d="M340 332 L340 730" stroke="#6366f1" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.5"/>
</svg>`;

writeFileSync(join(buildDir, 'icon.svg'), svgIcon);
console.log('Created build/icon.svg');

// Instructions for creating .icns file
console.log(`
To create macOS .icns file, you need to:
1. Open icon.svg in a graphics editor and export as 1024x1024 PNG
2. Or use an online converter like https://cloudconvert.com/svg-to-icns
3. Save as build/icon.icns

For now, electron-builder will use the SVG or you can manually create the icns.
`);
