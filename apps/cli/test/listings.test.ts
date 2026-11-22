import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupe, parseItemDump, parsePrice, parseTradeJson, rarityOf } from '../src/listings.ts';
import { parseBlend, parseSlot, parseTarget, UsageError } from '../src/args.ts';

const BOOTS: string = 'Item Class: Boots\nRarity: Rare\nMind March\nAssassin\'s Boots\n--------\nItem Level: 85\n--------\n+43% to Lightning Resistance';

test('item dump: header label and price, text kept as is', () => {
    const dump: string = `##ITEM Boots | Viper Urge Precursor Greaves | 220 chaos\r\n${BOOTS}\r\n##ITEM Boots | Second | 1 divine\n${BOOTS.replace('Rare', 'Magic')}\n\n`;
    const listings = parseItemDump(dump, 'items.txt');
    assert.equal(listings.length, 2);
    assert.deepEqual(listings[0]?.price, { amount: 220, currency: 'chaos' });
    assert.equal(listings[0]?.label, 'Viper Urge Precursor Greaves');
    assert.equal(listings[0]?.text, BOOTS);
    assert.equal(listings[1]?.rarity, 'Magic');
    assert.equal(listings[1]?.id, 'items.txt#1');
});

test('trade JSON: finds fetch results anywhere and decodes the item text', () => {
    const result = (id: string): unknown => ({
        id: id,
        listing: { price: { type: '~b/o', amount: 1.5, currency: 'divine' }, account: { name: 'x' } },
        item: { rarity: 'Rare', extended: { text: Buffer.from(`${BOOTS}\r\n`).toString('base64') } },
    });
    const raw: unknown = { fetch: [{ label: 'a', json: { result: [result('a1'), result('a2')] } }, { json: { result: [result('a1'), null] } }], exchange: [{ json: { result: { x: { id: 'not-a-listing' } } } }] };
    const listings = dedupe(parseTradeJson(raw, 'raw.json'));
    assert.deepEqual(listings.map((l) => l.id), ['a1', 'a2']);
    assert.equal(listings[0]?.text, BOOTS);
    assert.equal(listings[0]?.label, 'Mind March, Assassin\'s Boots');
    assert.deepEqual(listings[0]?.price, { amount: 1.5, currency: 'divine' });
    assert.equal(listings[0]?.rarity, 'Rare');
});

test('small parsers', () => {
    assert.equal(rarityOf('Rarity: Unique\nX'), 'Unique');
    assert.equal(parsePrice('a lot'), undefined);
    assert.deepEqual(parseTarget(undefined), { kind: 'saved' });
    assert.deepEqual(parseTarget('full'), { kind: 'fullDps' });
    assert.deepEqual(parseTarget('skill:8.1.2'), { kind: 'skill', group: 8, activeSkill: 1, part: 2 });
    assert.deepEqual(parseTarget('skill:5.1'), { kind: 'skill', group: 5, activeSkill: 1 });
    assert.throws(() => parseTarget('skill:5'), UsageError);
    assert.equal(parseSlot('body armour'), 'Body Armour');
    assert.throws(() => parseSlot('Shoes'), UsageError);
    assert.equal(parseBlend('0.25'), 0.25);
    assert.throws(() => parseBlend('2'), UsageError);
});
