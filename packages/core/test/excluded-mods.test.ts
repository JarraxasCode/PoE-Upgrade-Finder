// Excluding a hybrid mod (#38, G19), on the V19 recording: 420 real Covens boots (21 Nov, seller names replaced).
// An exclude keeps the mod off the results, not every item with its stats: a Not group on a hybrid's two stats
// dropped every boot with either one (88 of 420 for flat ES + mana, 298 for flat ES + life, 303 for Movement
// Speed + Onslaught). The recording lives in the private repo's test/fixtures/, so this skips in the public copy.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFetchResponse } from '@poe-upgrade-finder/trade';
import type { TradeListing } from '@poe-upgrade-finder/trade';
import { excludedModOf, modDomain } from '../src/excluded-mods.ts';
import type { SearchModExclusion } from '../src/spec.ts';

const V19_FILE: string = fileURLToPath(new URL('../../../test/fixtures/trade/v19-boots-raw.json', import.meta.url));
const skip: string | false = existsSync(V19_FILE) ? false : `no fixture at ${V19_FILE}`;

const FLAT_ES: string = 'explicit.stat_4052037485';
const MANA: string = 'explicit.stat_1050105434';
const LIFE: string = 'explicit.stat_3299347043';
const MS: string = 'explicit.stat_2250533757';
const ONSLAUGHT: string = 'explicit.stat_3023957681';

/** Every distinct listing in the recording. */
function v19(): readonly TradeListing[] {
    const raw: unknown = JSON.parse(readFileSync(V19_FILE, 'utf8'));
    assert.ok(typeof raw === 'object' && raw !== null && 'fetch' in raw && Array.isArray(raw.fetch));
    const byId: Map<string, TradeListing> = new Map<string, TradeListing>();
    for (const call of raw.fetch as readonly unknown[]) {
        assert.ok(typeof call === 'object' && call !== null && 'ids' in call && 'json' in call && Array.isArray(call.ids));
        const ids: string[] = call.ids.filter((id: unknown): id is string => typeof id === 'string');
        for (const l of readFetchResponse(call.json, ids).listings) {
            byId.set(l.id, l);
        }
    }
    return [...byId.values()];
}

/** Listings with a line for any of the stats, in any of the domains an explicit stat id counts (V24, decision 9). */
function withAny(listings: readonly TradeListing[], statIds: readonly string[]): readonly TradeListing[] {
    const hashes: readonly string[] = statIds.map((id: string) => id.slice(id.indexOf('.') + 1));
    return listings.filter((l: TradeListing) =>
        l.statSources.some(
            (s) => ['explicit', 'crafted', 'fractured'].includes(s.kind) && hashes.includes(s.statId.slice(s.statId.indexOf('.') + 1)),
        ),
    );
}

function ids(listings: readonly TradeListing[], statIds: readonly string[]): readonly string[] {
    return listings.filter((l: TradeListing) => modDomain(statIds, l.statSources) !== undefined).map((l: TradeListing) => l.id);
}

test('the flat ES + mana hybrid: 8 of 420 boots have it, not the 88 with either stat', { skip: skip }, () => {
    const listings: readonly TradeListing[] = v19();
    assert.equal(listings.length, 420);
    assert.equal(withAny(listings, [FLAT_ES, MANA]).length, 88);
    const hit: readonly string[] = ids(listings, [FLAT_ES, MANA]);
    assert.equal(hit.length, 8);
    // Deacon's: flat ES and mana from mod 3.
    assert.ok(hit.includes('2ec94c022cec19007a9031a7c507b3f591e24204df096f23d1d4d1263b101449'));
    // Flat ES from the ES + life hybrid (mod 4), mana from the pure prefix (mod 0): both stats, not the mod.
    assert.ok(!hit.includes('fc82c25153028551d41adcbb769d5c2b4245fdff6888d12bcc74b3a0e3910e43'));
    // The order of the stats doesn't matter.
    assert.deepEqual(ids(listings, [MANA, FLAT_ES]), hit);
});

test('the flat ES + life hybrid: a line summed from two mods still shows it; two other hybrids do not', { skip: skip }, () => {
    const listings: readonly TradeListing[] = v19();
    assert.equal(withAny(listings, [FLAT_ES, LIFE]).length, 298);
    const hit: readonly string[] = ids(listings, [FLAT_ES, LIFE]);
    assert.equal(hit.length, 7);
    // ES on mods 1 and 2, life on mods 1 and 3: mod 1 is the hybrid.
    assert.ok(hit.includes('a47a11318074b3830bfe1cbee989d1837b23d8dbeb15a051e993c1e8d58dac8b'));
    // Armour + life on mod 4 and armour + ES on mod 5: both stats, from two other hybrids.
    assert.ok(!hit.includes('fb4d76e10b814ce38b6805146fd086c1664bb2f5cb686388a76d5a52a30f3dfd'));
});

test('a crafted or fractured copy of a hybrid counts as the mod; the same index in two domains does not', { skip: skip }, () => {
    const listings: readonly TradeListing[] = v19();
    assert.equal(withAny(listings, [MS, ONSLAUGHT]).length, 303);
    const byDomain: Map<string, number> = new Map<string, number>();
    for (const l of listings) {
        const kind: string | undefined = modDomain([MS, ONSLAUGHT], l.statSources);
        if (kind !== undefined) {
            byDomain.set(kind, (byDomain.get(kind) ?? 0) + 1);
        }
    }
    // The bench's "Upgraded" craft, fractured copies and one natural: 30 boots, of 303 with either stat.
    assert.deepEqual(Object.fromEntries(byDomain), { crafted: 25, fractured: 4, explicit: 1 });
    // Deacon's has the craft as crafted mod 0 and Chaos Resistance as explicit mod 0: not one mod.
    const deacon: TradeListing | undefined = listings.find((l) => l.id.startsWith('2ec94c02'));
    assert.ok(deacon);
    assert.equal(modDomain([MS, 'explicit.stat_2923486259'], deacon.statSources), undefined);
    assert.equal(modDomain([MS, ONSLAUGHT], deacon.statSources), 'crafted');
});

test('excludedModOf names the first excluded mod an item has; an item with no sources has none', { skip: skip }, () => {
    const listings: readonly TradeListing[] = v19();
    const deacon: TradeListing | undefined = listings.find((l) => l.id.startsWith('2ec94c02'));
    assert.ok(deacon);
    const esMana: SearchModExclusion = {
        statIds: [MANA, FLAT_ES],
        name: '+# to maximum Energy Shield / +# to maximum Mana',
        origin: 'plan',
        label: 'Excluded: +# to maximum Energy Shield / +# to maximum Mana (hybrid mod), from plan',
    };
    const esLife: SearchModExclusion = { ...esMana, statIds: [LIFE, FLAT_ES], name: '+# to maximum Energy Shield / +# to maximum Life' };
    assert.equal(excludedModOf([esLife, esMana], deacon.statSources), esMana);
    assert.equal(excludedModOf([esLife], deacon.statSources), undefined);
    assert.equal(excludedModOf([esMana], []), undefined);
});
