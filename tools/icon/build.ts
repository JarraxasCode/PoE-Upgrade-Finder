// Renders assets/icon/icon.svg to assets/icon/icon.ico (and icon-256.png) with Electron's own Chromium, so
// nothing is downloaded. Run it as an Electron main, from the repo root:
//
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/icon/build.ts
//
// The .ico holds one PNG per size (16 to 256), which Windows Vista and later read. Re-run after editing the
// SVG and commit the outputs: the launcher (csc /win32icon) and the app's windows use icon.ico.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';

const ROOT: string = resolve(import.meta.dirname, '..', '..');
const DIR: string = join(ROOT, 'assets', 'icon');
const SIZES: readonly number[] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** An .ico with PNG entries: 6-byte header, a 16-byte directory entry per image, then the PNGs. */
export function icoFromPngs(images: readonly { readonly size: number; readonly png: Buffer }[]): Buffer {
    const header: Buffer = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // icon
    header.writeUInt16LE(images.length, 4);
    const entries: Buffer[] = [];
    let offset: number = 6 + 16 * images.length;
    for (const image of images) {
        const entry: Buffer = Buffer.alloc(16);
        entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0); // 0 means 256
        entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
        entry.writeUInt8(0, 2); // no palette
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4); // planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(image.png.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += image.png.length;
    }
    return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/**
 * Draws the SVG onto a canvas per size in one hidden page and reads the PNGs back (no screen capture, which
 * hangs on an offscreen window).
 */
async function renderAll(svg: string, sizes: readonly number[]): Promise<{ size: number; png: Buffer }[]> {
    const win: BrowserWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(`data:text/html;base64,${Buffer.from('<!doctype html><title>icon</title>').toString('base64')}`);
    const script: string = `(async () => { try {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
        await img.decode();
        const out = [];
        for (const size of ${JSON.stringify(sizes)}) {
            const c = document.createElement('canvas');
            c.width = size; c.height = size;
            const g = c.getContext('2d');
            g.imageSmoothingQuality = 'high';
            g.drawImage(img, 0, 0, size, size);
            out.push(c.toDataURL('image/png'));
        }
        return out;
    } catch (e) { return String(e); } })()`;
    const urls: unknown = await win.webContents.executeJavaScript(script);
    win.destroy();
    if (!Array.isArray(urls) || urls.length !== sizes.length) {
        throw new Error(`the page returned no images: ${String(urls)}`);
    }
    return sizes.map((size: number, i: number) => {
        const url: unknown = urls[i];
        if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) {
            throw new Error(`no PNG for ${size}px`);
        }
        return { size: size, png: Buffer.from(url.slice('data:image/png;base64,'.length), 'base64') };
    });
}

// Never hang: give up after 30 s.
setTimeout(() => {
    process.stderr.write('icon build timed out\n');
    app.exit(2);
}, 30_000).unref();

// A throwaway profile, not %APPDATA%\Electron.
app.setPath('userData', join(tmpdir(), 'poe-uf-icon-build'));

function fail(error: unknown): void {
    process.stderr.write(`icon build failed: ${error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error)}\n`);
    app.exit(1);
}

void app.whenReady().then(async () => {
    const svg: string = readFileSync(join(DIR, 'icon.svg'), 'utf8');
    const images: { size: number; png: Buffer }[] = await renderAll(svg, SIZES);
    writeFileSync(join(DIR, 'icon.ico'), icoFromPngs(images));
    const big: { size: number; png: Buffer } | undefined = images.find((i) => i.size === 256);
    if (big !== undefined) {
        writeFileSync(join(DIR, 'icon-256.png'), big.png);
    }
    process.stdout.write(`icon.ico: ${images.map((i) => `${i.size}px ${i.png.length} B`).join(', ')}\n`);
    app.exit(0);
}).catch(fail);
