// What the Search view shows about the loaded build: the damage-target choices (from PoB's skill groups),
// the baseline line, and warnings. Pure, so it is unit-tested on recorded engine output.

import { parseTarget } from '@poe-upgrade-finder/cli/args';
import type {
    ActiveSkillInfo,
    EngineWarning,
    EquippedItem,
    LoadBuildData,
    ResolvedTarget,
    SocketGroupInfo,
    StatBlock,
    TargetRequest,
} from '@poe-upgrade-finder/engine-client';
import type { BuildSummary, EquippedInfo, ItemView, TargetOption } from '@poe-upgrade-finder/ipc';
import type { BaseArt } from './base-art.ts';

/** A target id (saved, full, skill:G.A[.P]) as the engine's request. */
export function targetRequest(id: string): TargetRequest {
    return parseTarget(id);
}

export function resolvedLabel(target: ResolvedTarget): string {
    return target.kind === 'fullDps' ? 'Full DPS' : target.name;
}

function skillLabel(skill: ActiveSkillInfo, part: string | undefined): string {
    const minion: string = skill.minion === undefined ? '' : ` (${skill.minion})`;
    return `${skill.name}${minion}${part === undefined ? '' : `: ${part}`}`;
}

/**
 * The choices: as saved, Full DPS, then each active skill of each enabled group (each part, when a skill has
 * several). A label repeated across groups gets its group's slot or number.
 */
export function targetOptions(skills: readonly SocketGroupInfo[], saved: ResolvedTarget): TargetOption[] {
    const ticked: string[] = skills
        .filter((g: SocketGroupInfo) => g.enabled && g.includeInFullDPS)
        .map((g: SocketGroupInfo) => g.activeSkills[0]?.name ?? g.name);
    const options: TargetOption[] = [
        { id: 'saved', label: `As saved in PoB: ${resolvedLabel(saved)}` },
        { id: 'full', label: ticked.length > 0 ? `Full DPS: ${ticked.join(' + ')}` : 'Full DPS (no groups ticked "Include in Full DPS")' },
    ];
    const perSkill: { group: SocketGroupInfo; id: string; label: string }[] = [];
    for (const group of skills) {
        if (!group.enabled) {
            continue;
        }
        for (const skill of group.activeSkills) {
            if (skill.parts.length > 1) {
                skill.parts.forEach((part: string, i: number) => {
                    perSkill.push({ group: group, id: `skill:${group.index}.${skill.index}.${i + 1}`, label: skillLabel(skill, part) });
                });
            } else {
                perSkill.push({ group: group, id: `skill:${group.index}.${skill.index}`, label: skillLabel(skill, undefined) });
            }
        }
    }
    const counts: Map<string, number> = new Map<string, number>();
    for (const s of perSkill) {
        counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
    }
    for (const s of perSkill) {
        const repeated: boolean = (counts.get(s.label) ?? 0) > 1;
        options.push({ id: s.id, label: repeated ? `${s.label} (${s.group.slot ?? `group ${s.group.index}`})` : s.label });
    }
    return options;
}

function numberValue(stats: StatBlock, key: string): number | null {
    const v: number | boolean | undefined = stats.values[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface SummaryInput {
    readonly buildId: string;
    readonly load: LoadBuildData;
    readonly targetId: string;
    readonly target: ResolvedTarget;
    readonly stats: StatBlock;
    readonly warnings: readonly EngineWarning[];
    readonly fileModifiedMs: number;
    /** Base type and unique name → image (services/base-art.ts `itemArt`); injected so this stays pure. */
    readonly art: ArtLookup;
}

/** An equipped item for the gear layout: PoB's tooltip groups plus its base's image, when known. */
export type ArtLookup = (baseName: string, uniqueName: string | null) => BaseArt | undefined;

export function equippedInfo(e: EquippedItem, art: ArtLookup): EquippedInfo {
    let view: ItemView | null = null;
    if (e.view !== undefined) {
        const { baseName, ...rest } = e.view;
        const a: BaseArt | undefined = art(baseName, rest.rarity === 'unique' ? rest.name : null);
        view = { ...rest, icon: a?.icon ?? null, width: a?.width ?? 1, height: a?.height ?? 1 };
    }
    return { slot: e.slot, name: e.name, base: e.base, rarity: e.rarity, itemType: e.type ?? null, view: view };
}

export function buildSummary(input: SummaryInput): BuildSummary {
    const { load, stats } = input;
    const warnings: string[] = input.warnings.map((w: EngineWarning) => w.message);
    if (!(stats.damage > 0)) {
        warnings.push(
            'The damage target reads 0 (for example an aura as the main skill). Pick the skill to measure under "Measure damage on".',
        );
    }
    return {
        buildId: input.buildId,
        pobVersion: load.pobVersion,
        className: load.info.className ?? null,
        ascendClassName: load.info.ascendClassName === undefined || load.info.ascendClassName === 'None' ? null : load.info.ascendClassName,
        level: load.info.level ?? null,
        targetId: input.targetId,
        targetLabel: resolvedLabel(input.target),
        targets: targetOptions(load.skills, load.target),
        damage: stats.damage,
        ehp: numberValue(stats, 'TotalEHP'),
        life: numberValue(stats, 'Life'),
        equipped: load.equipped.map((e: EquippedItem) => equippedInfo(e, input.art)),
        warnings: warnings,
        fileModifiedMs: input.fileModifiedMs,
    };
}
