import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { zip } from '../src/services/zip.ts';

/** Reads a zip back through its central directory (what an unzip tool does). */
function unzip(buffer: Buffer): Map<string, Buffer> {
    const end: number = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0, 'end of central directory');
    const count: number = buffer.readUInt16LE(end + 10);
    let at: number = buffer.readUInt32LE(end + 16);
    const out: Map<string, Buffer> = new Map<string, Buffer>();
    for (let i: number = 0; i < count; i++) {
        assert.equal(buffer.readUInt32LE(at), 0x02014b50);
        const method: number = buffer.readUInt16LE(at + 10);
        const crc: number = buffer.readUInt32LE(at + 16);
        const packedSize: number = buffer.readUInt32LE(at + 20);
        const size: number = buffer.readUInt32LE(at + 24);
        const nameLength: number = buffer.readUInt16LE(at + 28);
        const localAt: number = buffer.readUInt32LE(at + 42);
        const name: string = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
        assert.equal(buffer.readUInt32LE(localAt), 0x04034b50);
        const dataAt: number = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
        const raw: Buffer = buffer.subarray(dataAt, dataAt + packedSize);
        assert.ok(method === 0 || method === 8, `method ${method}`);
        const data: Buffer = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
        assert.equal(data.length, size);
        assert.equal(crc32(data), crc);
        out.set(name, data);
        at += 46 + nameLength;
    }
    return out;
}

test('zip: entries come back byte for byte with matching CRCs', () => {
    const a: Buffer = Buffer.from('{"t":1}\n'.repeat(500));
    const b: Buffer = Buffer.from('');
    const files: Map<string, Buffer> = unzip(zip([{ name: 'logs/app.jsonl', data: a }, { name: 'empty.txt', data: b }]));
    assert.deepEqual([...files.keys()], ['logs/app.jsonl', 'empty.txt']);
    assert.ok(files.get('logs/app.jsonl')?.equals(a));
    assert.equal(files.get('empty.txt')?.length, 0);
});

test('zip: an entry deflate cannot shrink is stored, and comes back the same', () => {
    const noise: Buffer = randomBytes(4096);
    const text: Buffer = Buffer.from('a'.repeat(4096));
    const out: Buffer = zip([{ name: 'noise.bin', data: noise }, { name: 'text.txt', data: text }]);
    assert.ok(out.length < noise.length + 4096, 'text deflated');
    assert.equal(out.readUInt16LE(8), 0, 'first entry stored');
    const files: Map<string, Buffer> = unzip(out);
    assert.ok(files.get('noise.bin')?.equals(noise));
    assert.ok(files.get('text.txt')?.equals(text));
});
