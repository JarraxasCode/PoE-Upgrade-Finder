// PoB's file hash (update_manifest.py): sha1 of the bytes, except that a file with no NUL byte has its line
// endings normalised to CRLF first (`\r\n`, a lone `\r` and a lone `\n` all become `\r\n`). Checked against
// all 1,437 files of an installed PoB (V20).

import { createHash, type Hash } from 'node:crypto';

const CR: number = 0x0d;
const LF: number = 0x0a;

export function pobSha1(data: Uint8Array): string {
    const hash: Hash = createHash('sha1');
    if (data.includes(0)) {
        hash.update(data);
        return hash.digest('hex');
    }
    // Normalise in one pass into a buffer at most twice the size.
    const out: Uint8Array = new Uint8Array(data.length * 2);
    let n: number = 0;
    for (let i: number = 0; i < data.length; i++) {
        const byte: number = data[i] ?? 0;
        if (byte === CR) {
            out[n++] = CR;
            out[n++] = LF;
            if (data[i + 1] === LF) {
                i++;
            }
        } else if (byte === LF) {
            out[n++] = CR;
            out[n++] = LF;
        } else {
            out[n++] = byte;
        }
    }
    hash.update(out.subarray(0, n));
    return hash.digest('hex');
}
