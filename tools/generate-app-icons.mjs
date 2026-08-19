import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import iconTools from 'app-builder-lib/out/toolsets/icons.js';
import sharp from 'sharp';

const { runIconsTool } = iconTools;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = path.join(projectRoot, 'build-resources');
const markSourcePath = path.join(projectRoot, 'assets', 'guanyi-md-mark.svg');
const sourcePreviewPath = path.join(resourcesDir, 'icon-source.png');
const iconsetDir = path.join(resourcesDir, 'icon.iconset');
const masterSize = 1024;
const svgDensity = (masterSize / 64) * 72;

async function normalizeTransparentEdge(input) {
  const { data: pixels, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha === 0 || alpha === 255) continue;
    pixels[offset] = 246;
    pixels[offset + 1] = 241;
    pixels[offset + 2] = 232;
  }

  return sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    .png()
    .toBuffer();
}

async function resizeIcon(input, size) {
  const resized = await sharp(input)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  return normalizeTransparentEdge(resized);
}

const markSource = await readFile(markSourcePath);
const renderedMark = await sharp(markSource, { density: svgDensity })
  .resize(masterSize, masterSize, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
  .png()
  .toBuffer();
const masterIcon = await normalizeTransparentEdge(renderedMark);

await Promise.all([
  sharp(masterIcon)
    .withMetadata({ density: 72 })
    .png()
    .toFile(sourcePreviewPath),
  sharp(masterIcon)
    .withMetadata({ density: 72 })
    .png()
    .toFile(path.join(resourcesDir, 'icon-1024.png')),
  sharp(await resizeIcon(masterIcon, 512))
    .withMetadata({ density: 72 })
    .png()
    .toFile(path.join(resourcesDir, 'icon-512.png'))
]);

const iconsetFiles = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

await Promise.all(iconsetFiles.map(async ([name, size]) => sharp(await resizeIcon(masterIcon, size))
  .withMetadata({ density: 72 })
  .png()
  .toFile(path.join(iconsetDir, name))));

await runIconsTool({
  inputFile: path.join(resourcesDir, 'icon-1024.png'),
  outputFormat: 'icns',
  outDir: resourcesDir
});

console.log('Generated vector app icons.');
