// The PoB hooks the engine relies on (engine/lua): every PoB function, table, field and file it calls or reads.
// A cheap text check on a new copy before anything runs it: a renamed function shows up here with its file and
// the engine file that uses it named, rather than as a Lua error mid-run or, worse, as an empty result (#66).
//
// Each needle is the most specific text that still means "PoB has this": a definition where there is one
// (`function ItemsTabClass:AddItem(`), else the assignment or read PoB itself makes. test/golden/pob-hooks.test.ts
// checks every needle on the pinned copy, that each one is caught on its own when it's gone, and that every PoB
// method, data table and data file engine/lua uses has a hook here. Keep the table in pob-internals.md ("Hooks the
// engine relies on") in step.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PobHook {
    /** The file in the PoB copy, relative to its root (src/…, runtime/…). */
    readonly file: string;
    /** Text the file must contain. */
    readonly needle: string;
    /** The engine/lua file(s) that rely on it, for the message. */
    readonly usedIn: string;
}

const ITEM: string = 'src/Classes/Item.lua';
const ITEMS_TAB: string = 'src/Classes/ItemsTab.lua';
const GENERATOR: string = 'src/Classes/TradeQueryGenerator.lua';
const DATA: string = 'src/Modules/Data.lua';
const BUILD: string = 'src/Modules/Build.lua';
const ITEM_TOOLS: string = 'src/Modules/ItemTools.lua';

/** The influence keys slotdata sets on its test item (`item[key] = true`), which GetModSpawnWeight reads. */
const INFLUENCE_KEYS: readonly string[] = ['shaper', 'elder', 'adjudicator', 'basilisk', 'crusader', 'eyrie'];

export const POB_HOOKS: readonly PobHook[] = [
    // Start-up and loading a build.
    { file: 'src/HeadlessWrapper.lua', needle: 'function loadBuildFromXML(', usedIn: 'dispatcher' },
    { file: 'src/HeadlessWrapper.lua', needle: 'function runCallback(', usedIn: 'buildedit' },
    // loadBuildFromXML doesn't raise PoB's error: it's left in launch.promptMsg. Nor does a rebuild: Launch's
    // OnFrame PCalls PoB's and passes the error to ShowErrMsg (pob-internals P28).
    { file: 'src/Launch.lua', needle: 'self.promptMsg = str', usedIn: 'dispatcher, buildedit' },
    { file: 'src/Launch.lua', needle: `self:ShowErrMsg("In 'OnFrame': %s", errMsg)`, usedIn: 'buildedit' },
    { file: 'src/Launch.lua', needle: 'self.versionNumber = node.attrib.number', usedIn: 'dispatcher' },
    { file: 'src/_SimpleGraphic.def.lua', needle: 'function StripEscapes(', usedIn: 'buildedit, itemview' },
    { file: BUILD, needle: 'self.itemsTab = new("ItemsTab")', usedIn: 'dispatcher, buildedit' },
    { file: BUILD, needle: 'self.skillsTab = new("SkillsTab")', usedIn: 'target' },
    { file: BUILD, needle: 'self.calcsTab = new("CalcsTab")', usedIn: 'dispatcher, buildedit' },
    // buildedit's rebuild: set the flag, run OnFrame.
    { file: BUILD, needle: 'if self.buildFlag then', usedIn: 'buildedit' },
    { file: BUILD, needle: 'self.mainSocketGroup = tonumber(xml.attrib.mainSkillIndex)', usedIn: 'target' },
    // PoB loads every build in TREE view, and TREE view forces the Full DPS roll-up (target.lua moves off it).
    { file: BUILD, needle: 'self.viewMode = "TREE"', usedIn: 'target' },
    // The build info loadBuild sends back.
    { file: BUILD, needle: 'self.characterLevel = tonumber(xml.attrib.level)', usedIn: 'dispatcher' },
    { file: 'src/Classes/TreeTab.lua', needle: 'self.build.spec = ', usedIn: 'dispatcher' },
    { file: 'src/Classes/PassiveSpec.lua', needle: 'self.curClassName = ', usedIn: 'dispatcher' },
    { file: 'src/Classes/PassiveSpec.lua', needle: 'self.curAscendClassName = ', usedIn: 'dispatcher' },
    { file: 'src/Classes/PassiveSpec.lua', needle: 'self.treeVersion = ', usedIn: 'dispatcher' },

    // The compare calculator (pob-internals P10).
    { file: 'src/Classes/CalcsTab.lua', needle: 'function CalcsTabClass:GetMiscCalculator()', usedIn: 'dispatcher, buildedit' },
    { file: 'src/Classes/CalcsTab.lua', needle: 'self.miscCalculator = ', usedIn: 'dispatcher' },
    { file: 'src/Modules/Calcs.lua', needle: 'return function(override, useFullDPS)', usedIn: 'dispatcher, buildedit' },
    { file: 'src/Modules/Calcs.lua', needle: 'build.viewMode == "TREE"', usedIn: 'target' },
    { file: 'src/Modules/CalcSetup.lua', needle: 'override.repSlotName', usedIn: 'dispatcher' },
    { file: 'src/Modules/CalcSetup.lua', needle: 'override.repItem', usedIn: 'dispatcher' },
    { file: ITEMS_TAB, needle: 'repSlotName', usedIn: 'dispatcher' },

    // Damage targets.
    { file: 'src/Classes/SkillsTab.lua', needle: 'self.socketGroupList = ', usedIn: 'target' },
    { file: 'src/Classes/SkillsTab.lua', needle: 'socketGroup.includeInFullDPS = ', usedIn: 'target' },
    { file: 'src/Classes/SkillsTab.lua', needle: 'socketGroup.mainActiveSkill = ', usedIn: 'target' },
    { file: 'src/Modules/Calcs.lua', needle: 'activeSkill.socketGroup.includeInFullDPS', usedIn: 'target' },
    { file: 'src/Modules/CalcSetup.lua', needle: 'group.displaySkillList = ', usedIn: 'target' },
    { file: 'src/Modules/CalcActiveSkill.lua', needle: 'activeEffect.srcInstance.skillPartCalcs', usedIn: 'target' },
    { file: BUILD, needle: 'srcInstance.skillPart = ', usedIn: 'target' },
    { file: 'src/Modules/CalcActiveSkill.lua', needle: 'activeSkill.disableReason = ', usedIn: 'target' },
    // The stats the generator's weights read (FullDPS, CombinedDPS, TotalEHP).
    { file: DATA, needle: 'data.powerStatList = ', usedIn: 'generator' },

    // Items.
    { file: ITEM, needle: 'function ItemClass:Item(', usedIn: 'dispatcher, slotdata' },
    { file: ITEM, needle: 'function ItemClass:NormaliseQuality()', usedIn: 'dispatcher' },
    { file: ITEM, needle: 'function ItemClass:BuildModList()', usedIn: 'dispatcher' },
    { file: ITEM, needle: 'function ItemClass:BuildRaw()', usedIn: 'dispatcher' },
    { file: ITEM, needle: 'function ItemClass:GetModLineVariantCount(', usedIn: 'itemview' },
    { file: ITEM, needle: 'function ItemClass:GetModSpawnWeight(', usedIn: 'slotdata' },
    { file: ITEM, needle: 'function ItemClass:GetNecropolisModSpawnWeight(', usedIn: 'slotdata' },
    { file: ITEM, needle: 'function ItemClass:CheckIfModIsDelve(', usedIn: 'slotdata' },
    { file: ITEM, needle: 'self.affixes = ', usedIn: 'slotdata' },
    // The slot item's own totals for the strip (#34): its parsed mods, summed through a ModList.
    { file: ITEM, needle: 'self.modList = self:BuildModListForSlotNum(baseList)', usedIn: 'dispatcher' },
    { file: ITEM, needle: 'self.slotModList[i] = self:BuildModListForSlotNum(baseList, i)', usedIn: 'dispatcher' },
    { file: 'src/Classes/ModList.lua', needle: 'function ModListClass:ModList(', usedIn: 'dispatcher' },
    { file: 'src/Classes/ModList.lua', needle: 'function ModListClass:AddList(', usedIn: 'dispatcher' },
    { file: 'src/Classes/ModStore.lua', needle: 'function ModStoreClass:Sum(', usedIn: 'dispatcher' },
    // Lines PoB couldn't parse (pob-internals P3).
    { file: ITEM, needle: 'modLine.extra = ', usedIn: 'dispatcher' },
    { file: ITEM_TOOLS, needle: 'function itemLib.formatModLine(', usedIn: 'itemview' },
    ...INFLUENCE_KEYS.map((key: string): PobHook => ({ file: ITEM_TOOLS, needle: `key="${key}"`, usedIn: 'slotdata, itemview' })),

    // The items tab.
    { file: ITEMS_TAB, needle: 'self.slots = ', usedIn: 'dispatcher, buildedit' },
    { file: ITEMS_TAB, needle: 'self.orderedSlots = ', usedIn: 'dispatcher' },
    { file: ITEMS_TAB, needle: 'self.items = ', usedIn: 'dispatcher' },
    { file: ITEMS_TAB, needle: 'function ItemsTabClass:AddItem(', usedIn: 'buildedit' },
    { file: ITEMS_TAB, needle: 'function ItemsTabClass:DeleteItem(', usedIn: 'buildedit' },
    { file: ITEMS_TAB, needle: 'function ItemsTabClass:PopulateSlots()', usedIn: 'buildedit' },
    { file: ITEMS_TAB, needle: 'function ItemsTabClass:IsItemValidForSlot(', usedIn: 'dispatcher' },
    { file: 'src/Classes/ItemSlotControl.lua', needle: 'function ItemSlotClass:SetSelItemId(', usedIn: 'buildedit' },
    { file: 'src/Classes/ItemSlotControl.lua', needle: 'self.selItemId = selItemId', usedIn: 'dispatcher, buildedit' },
    // Weapon sets: the calc skips the slots of the set not in use, so the engine refuses them (#110, P13).
    { file: ITEMS_TAB, needle: 'slot.weaponSet = 1', usedIn: 'dispatcher' },
    { file: ITEMS_TAB, needle: 'itemSet.useSecondWeaponSet = node.attrib.useSecondWeaponSet == "true"', usedIn: 'dispatcher' },
    { file: 'src/Modules/CalcSetup.lua', needle: 'build.itemsTab.activeItemSet.useSecondWeaponSet and 2 or 1', usedIn: 'dispatcher' },
    // Tree jewel sockets are slots too; the engine skips them by their nodeId.
    { file: 'src/Classes/ItemSlotControl.lua', needle: 'self.nodeId = nodeId', usedIn: 'dispatcher, buildedit' },

    // PoB's trade query generator.
    { file: GENERATOR, needle: 'function TradeQueryGeneratorClass:TradeQueryGenerator(', usedIn: 'generator, querymods-rebuild' },
    { file: GENERATOR, needle: 'function TradeQueryGeneratorClass:StartQuery(', usedIn: 'generator' },
    { file: GENERATOR, needle: 'function TradeQueryGeneratorClass:FinishQuery()', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.calcContext.co = coroutine.create(', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.requesterCallback(self.requesterContext', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.modWeights = ', usedIn: 'dispatcher' },
    { file: GENERATOR, needle: 'tradeModId = entry.tradeMod.id, weight = ', usedIn: 'dispatcher' },
    { file: GENERATOR, needle: 'itemCategoryQueryStr = itemCategoryQueryStr', usedIn: 'dispatcher' },
    { file: GENERATOR, needle: 'baseStatValue = ', usedIn: 'dispatcher' },
    { file: GENERATOR, needle: 'self.calcContext.options.statWeights', usedIn: 'generator' },
    // The uniques command (#113): PoB's generator score, its text matching, PoB's unique list and its rolls.
    {
        file: GENERATOR,
        needle: 'function TradeQueryGeneratorClass.WeightedRatioOutputs(baseOutput, newOutput, statWeights)',
        usedIn: 'uniques',
    },
    { file: 'src/Classes/TradeHelpers.lua', needle: 'function M.swapInverse(modLine)', usedIn: 'uniques' },
    { file: 'src/Modules/Main.lua', needle: 'self.uniqueDB = { list = { }, byTitle = { }, loading = true }', usedIn: 'uniques' },
    { file: 'src/Modules/Main.lua', needle: 'self.uniqueDB.loading = nil', usedIn: 'uniques' },
    { file: ITEM_TOOLS, needle: 'function itemLib.applyRange(line, range, valueScalar, baseValueScalar)', usedIn: 'uniques' },
    { file: ITEM, needle: 'self.implicitModLines = ', usedIn: 'uniques' },
    { file: ITEM, needle: 'self.explicitModLines = ', usedIn: 'uniques' },
    { file: ITEM, needle: 'modLine.variantList[tonumber(varId)] = true', usedIn: 'uniques' },
    // The StartQuery options the engine passes (generator.DEFAULT_OPTIONS): a renamed one would be ignored.
    { file: GENERATOR, needle: 'self.calcContext.options.includeCorrupted', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.calcContext.options.includeScourge', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.calcContext.options.includeTalisman', usedIn: 'generator' },
    { file: GENERATOR, needle: 'self.calcContext.options.includeEldritch', usedIn: 'generator' },
    { file: GENERATOR, needle: 'eldritchOption == "Keep regular"', usedIn: 'generator' },
    { file: GENERATOR, needle: 'options.includeMirrored', usedIn: 'generator' },
    { file: GENERATOR, needle: 'options.maxLevel and', usedIn: 'generator' },
    { file: 'src/Modules/Main.lua', needle: 'self.defaultItemAffixQuality = ', usedIn: 'dispatcher' },
    // QueryMods.lua's rebuild answers lcurl.safe with the bundled stats and redirects the file writes.
    { file: GENERATOR, needle: 'require("lcurl.safe")', usedIn: 'querymods-rebuild' },
    { file: GENERATOR, needle: 'local queryModFilePath = "Data/QueryMods.lua"', usedIn: 'querymods-rebuild' },
    { file: GENERATOR, needle: 'self.modData = ', usedIn: 'querymods-rebuild' },
    { file: 'runtime/lua/dkjson.lua', needle: 'function json.encode (', usedIn: 'querymods-rebuild' },

    // Data tables (the slot data's mod sources), their fields, and the weapon rules.
    { file: DATA, needle: 'data.itemBases = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.itemMods = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'Explicit = LoadModule("Data/ModExplicit")', usedIn: 'slotdata' },
    { file: DATA, needle: 'ItemExclusive = LoadModule("Data/ModItemExclusive")', usedIn: 'slotdata' },
    { file: DATA, needle: 'Delve = LoadModule("Data/ModDelve")', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.masterMods = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.essences = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.veiledMods = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.beastCraft = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.necropolisMods = ', usedIn: 'slotdata' },
    { file: DATA, needle: 'data.weaponTypeInfo = ', usedIn: 'dispatcher' },
    { file: 'src/Data/Bases/gloves.lua', needle: 'implicitIds = ', usedIn: 'slotdata' },
    { file: 'src/Data/ModItemExclusive.lua', needle: 'tradeHashes = ', usedIn: 'slotdata' },
    { file: 'src/Data/ModMaster.lua', needle: 'types = ', usedIn: 'slotdata' },
    { file: 'src/Data/Essence.lua', needle: 'mods = ', usedIn: 'slotdata' },
    { file: 'src/Data/DelveDropOnly.lua', needle: '["categories"] = ', usedIn: 'slotdata' },
    { file: 'src/Data/IncursionDropOnly.lua', needle: '["categories"] = ', usedIn: 'slotdata' },
    { file: 'src/Data/TradeSiteStats.lua', needle: '["entries"] = ', usedIn: 'slotdata, querymods-rebuild' },
];

/** A message per hook missing from the files' texts (`textOf` gives undefined for a missing file), or an empty list. */
export function missingHooks(textOf: (file: string) => string | undefined, hooks: readonly PobHook[] = POB_HOOKS): readonly string[] {
    const missing: string[] = [];
    const missingFiles: Set<string> = new Set<string>();
    for (const hook of hooks) {
        const text: string | undefined = textOf(hook.file);
        if (text === undefined) {
            if (!missingFiles.has(hook.file)) {
                missingFiles.add(hook.file);
                missing.push(`${hook.file} is missing`);
            }
            continue;
        }
        if (!text.includes(hook.needle)) {
            missing.push(`${hook.file} no longer has ${hook.needle} (used by engine/lua: ${hook.usedIn})`);
        }
    }
    return missing;
}

/** Reads the hooks' files from a PoB copy (repo layout): a message per hook that's missing, or an empty list. */
export async function checkHooks(dir: string, hooks: readonly PobHook[] = POB_HOOKS): Promise<readonly string[]> {
    const texts: Map<string, string | undefined> = new Map<string, string | undefined>();
    for (const file of new Set<string>(hooks.map((h: PobHook) => h.file))) {
        try {
            texts.set(file, await readFile(join(dir, file), 'utf8'));
        } catch {
            texts.set(file, undefined);
        }
    }
    return missingHooks((file: string) => texts.get(file), hooks);
}
