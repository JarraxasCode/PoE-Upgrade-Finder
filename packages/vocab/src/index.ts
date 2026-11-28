// The shared vocabulary (issue #44): literal unions, their lists and the item-type tables, in one place for
// engine-client, trade, core, ipc and the renderer. No dependencies and no Node or DOM code, so the renderer
// bundles it and its tests stay DOM-free. Each list is the source of its union, so it always holds every member.

export {
    anyOfType,
    categoryOf,
    DEFENCE_ITEM_TYPES,
    fitsBeside,
    GENERIC_WEAPON_TYPES,
    hasDefences,
    isGenericType,
    isTwoHanded,
    ITEM_TYPE_CATEGORY,
    memberTypes,
    offHandTypes,
    ONE_HANDED,
    SLOT_ITEM_TYPES,
    slotItemTypes,
    slotTakes,
    TWO_HANDED,
} from './item-types.ts';
export type { GenericWeaponType } from './item-types.ts';
export { ICON_ORIGIN, ITEM_INFLUENCES, ITEM_MOD_KINDS, ITEM_RARITIES, ITEM_TONES } from './item.ts';
export type { ItemInfluence, ItemLine, ItemMod, ItemModKind, ItemPart, ItemRarity, ItemTone, ItemView } from './item.ts';
export {
    DEFENCE_KINDS,
    DEFENCE_NAMES,
    emptySlotPlan,
    hasSockets,
    isUniquePlan,
    MAX_INFLUENCES,
    MAX_SOCKET_VALUE,
    MAX_TOTALS,
    MOD_POSITIONS,
    MOD_RULES,
    PLAIN_AFFIXES,
    SLOT_INFLUENCES,
    SLOT_MOD_TYPES,
    SLOT_SOURCES,
    SOCKET_COLOURS,
    SOCKET_ENDS,
    SOCKET_ROWS,
    socketRowText,
    UNIQUE_MODES,
} from './plan.ts';
export type {
    AffixLimits,
    BaseAffixes,
    DefenceKind,
    DefenceRange,
    ModPick,
    ModPosition,
    ModRule,
    PickStat,
    PickedUnique,
    PlanDefences,
    PlanSockets,
    PlanTotal,
    SlotInfluence,
    SlotModType,
    SlotPlan,
    SlotSource,
    SocketColour,
    SocketEnd,
    SocketRange,
    SocketRow,
    UniqueChoice,
    UniqueMode,
} from './plan.ts';
export {
    JUNK_REASONS,
    LEVEL_FILTER_KINDS,
    LISTING_TYPES,
    MAX_CHARACTER_LEVEL,
    PRUNE_REASONS,
    SEARCH_DEPTHS,
    SKIP_REASONS,
    THOROUGH_NOTE,
    WEIGHT_SOURCES,
    excludedModNames,
    excludedModText,
} from './run.ts';
export type {
    BandRole,
    ExcludedModCount,
    JunkReason,
    LevelFilter,
    ListingType,
    PruneReason,
    SearchDepth,
    SkipReason,
    WeightSource,
} from './run.ts';
export { GEAR_SLOTS, isGearSlot } from './slots.ts';
export type { GearSlot } from './slots.ts';
export { ATTRIBUTES, ELEMENTS } from './stats.ts';
export type { Attribute, Element, FloorSettings } from './stats.ts';
export {
    applyWeightEdits,
    effectiveWeight,
    isOn,
    MAX_WEIGHT_FACTOR,
    MAX_WEIGHT_PCT,
    percentOfTop,
    shownPercent,
    topWeight,
    weightCounts,
    withOn,
    withPercent,
} from './weight-model.ts';
export type { StatWeight, WeightCounts, WeightEdit, WeightEdits } from './weight-model.ts';
