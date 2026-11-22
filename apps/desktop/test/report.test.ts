import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junkFilter, priceBands, valuePick } from '@poe-upgrade-finder/core';
import type { EvaluatedItem, RunResult } from '@poe-upgrade-finder/core';
import { liveLine, priceText, summaryText } from '../src/report.ts';
import { isAllowedSignInUrl } from '../src/signin-hosts.ts';

function item(id: string, gain: number, price: { amount: number; currency: string }, chaos: number | undefined, floorsPass: boolean = true): EvaluatedItem {
    return {
        item: { id: id, text: id, name: `Name ${id}`, baseType: 'Sorcerer Boots', itemLevel: 84, statIds: [], seller: 'Seller', price: { ...price, type: '~b/o' }, chaosEquivalent: chaos, bandId: 'band-2' },
        scored: { stats: { damage: 1, values: {} }, unparsed: [] },
        gain: { dpsPct: gain, ehpPct: gain, gain: gain },
        checks: [],
        notes: [],
        floorsPass: floorsPass,
        failedFloors: [],
        missedTargets: [],
        flags: [],
    };
}

test('prices show natively, with the chaos equivalent for divines', () => {
    assert.equal(priceText(item('a', 1, { amount: 30, currency: 'chaos' }, 30)), '30c');
    assert.equal(priceText(item('a', 1, { amount: 1.5, currency: 'divine' }, 311.85)), '1.5d ≈ 312c');
    assert.equal(priceText(item('a', 1, { amount: 2, currency: 'exalted' }, undefined)), '2 exalted');
});

test('live lines only for finds that pass the floors and the minimum gain', () => {
    assert.match(liveLine(item('a', 2.5, { amount: 30, currency: 'chaos' }, 30), 1) ?? '', /^ {2}find {2}\+2\.50% .*30c {2}Name a, Sorcerer Boots$/);
    assert.equal(liveLine(item('b', 0.5, { amount: 30, currency: 'chaos' }, 30), 1), undefined);
    assert.equal(liveLine(item('c', 5, { amount: 30, currency: 'chaos' }, 30, false), 1), undefined);
});

test('the summary leads with the verdict and lists finds with buy links', () => {
    const items = junkFilter([item('a', 4.5, { amount: 20, currency: 'chaos' }, 20), item('b', 5, { amount: 60, currency: 'chaos' }, 60)]);
    const bands = priceBands(300);
    const result: RunResult = {
        searches: [], items: items, fetchedIds: [], verdict: valuePick(items, bands), stoppedReason: undefined,
        counts: { searches: 0, fetched: 2, scored: 2, failed: 0, skipped: 0, missing: 0 },
    };
    const text: string = summaryText({ league: 'Covens', slot: 'Boots', budgetText: '300c', rateText: '207.9c', bands: bands, result: result, minGainPct: 1, top: 10 });
    assert.match(text, /VERDICT: Pick: Name a/);
    assert.match(text, /Buy links/);
    assert.match(text, /https:\/\/www\.pathofexile\.com\/trade\/search\/Covens\?q=/);
});

test('the sign-in window allows the site and its login providers only', () => {
    assert.equal(isAllowedSignInUrl('https://www.pathofexile.com/login'), true);
    assert.equal(isAllowedSignInUrl('https://steamcommunity.com/openid/login'), true);
    assert.equal(isAllowedSignInUrl('https://pathofexile.com.evil.example/login'), false);
    assert.equal(isAllowedSignInUrl('http://www.pathofexile.com/login'), false);
    assert.equal(isAllowedSignInUrl('not a url'), false);
});
