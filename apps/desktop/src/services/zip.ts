// A minimal zip writer, used for "Export logs" (PLAN.md, Logging) and by the packaging script for the app zip
// the launcher embeds (tools/package). Entries are deflated, or stored when deflating doesn't make them
// smaller (PoB's timeless-jewel tables are already compressed). No folder entries, no zip64: it refuses an
// archive past 4 GB or 65,535 entries rather than write a broken one. Node's zlib does the compression and
// the CRC-32, so no package is needed.

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
    /** Name inside the zip (forward slashes). */
    readonly name: string;
    readonly data: Buffer;
}

const MAX_U32: number = 0xffffffff;
const MAX_ENTRIES: number = 0xffff;

/** DOS date and time for the zip headers. */
function dosTime(date: Date): { readonly time: number; readonly date: number } {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/** Writes a zip as a stream of buffers to `sink` (a file, or an array for zip()). */
export class ZipWriter {
    private readonly sink: (chunk: Buffer) => void;
    private readonly stamp: { readonly time: number; readonly date: number };
    private readonly central: Buffer[] = [];
    private offset: number = 0;
    private count: number = 0;
    private finished: boolean = false;

    public constructor(sink: (chunk: Buffer) => void, when: Date = new Date()) {
        this.sink = sink;
        this.stamp = dosTime(when);
    }

    /** Bytes written so far. */
    public get size(): number {
        return this.offset;
    }

    public add(entry: ZipEntry): void {
        if (this.finished) {
            throw new Error('zip: add after finish');
        }
        if (this.count >= MAX_ENTRIES) {
            throw new Error(`zip: more than ${MAX_ENTRIES} entries needs zip64`);
        }
        const name: Buffer = Buffer.from(entry.name, 'utf8');
        const deflated: Buffer = deflateRawSync(entry.data);
        const stored: boolean = deflated.length >= entry.data.length;
        const packed: Buffer = stored ? entry.data : deflated;
        const method: number = stored ? 0 : 8;
        const crc: number = crc32(entry.data);
        const local: Buffer = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(this.stamp.time, 10);
        local.writeUInt16LE(this.stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        const header: Buffer = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(method, 10);
        header.writeUInt16LE(this.stamp.time, 12);
        header.writeUInt16LE(this.stamp.date, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(packed.length, 20);
        header.writeUInt32LE(entry.data.length, 24);
        header.writeUInt16LE(name.length, 28);
        // extra length, comment length, disk start, internal attrs, external attrs: 0
        header.writeUInt32LE(this.offset, 42);

        const next: number = this.offset + local.length + name.length + packed.length;
        if (next > MAX_U32) {
            throw new Error('zip: past 4 GB needs zip64');
        }
        this.sink(local);
        this.sink(name);
        this.sink(packed);
        this.central.push(header, name);
        this.offset = next;
        this.count++;
    }

    public finish(): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        const centralSize: number = this.central.reduce((n: number, b: Buffer) => n + b.length, 0);
        if (this.offset + centralSize > MAX_U32) {
            throw new Error('zip: past 4 GB needs zip64');
        }
        const end: Buffer = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.count, 8);
        end.writeUInt16LE(this.count, 10);
        end.writeUInt32LE(centralSize, 12);
        end.writeUInt32LE(this.offset, 16);
        for (const chunk of this.central) {
            this.sink(chunk);
        }
        this.sink(end);
    }
}

export function zip(entries: readonly ZipEntry[], when: Date = new Date()): Buffer {
    const parts: Buffer[] = [];
    const writer: ZipWriter = new ZipWriter((chunk: Buffer) => {
        parts.push(chunk);
    }, when);
    for (const entry of entries) {
        writer.add(entry);
    }
    writer.finish();
    return Buffer.concat(parts);
}
