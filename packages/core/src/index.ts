export { bandSearches, chaosEquivalent, DEPTH_PER_BAND, priceBands, splitDepth } from './bands.ts';
export type { BandRole, BandSearch, BandSettings, PriceBand, SearchDepth, SearchSize } from './bands.ts';
export { evaluateItem } from './evaluate.ts';
export type { EvaluatedItem } from './evaluate.ts';
export { buildFloors, DEFAULT_FLOORS, floorChecks, readFloorSettings, stripNeeds, stripNeedsSource } from './floors.ts';
export type { FloorSettings } from './floors.ts';
export { checkBlend, DEFAULT_BLEND, gainOf, generatorWeights, percentChange } from './gain.ts';
export type { Gain, GainStats } from './gain.ts';
export { DEFAULT_MIN_GAIN_PCT, junkFilter } from './junk.ts';
export type { FilteredItem, JunkReason } from './junk.ts';
export {
    compileQuery,
    COMPLEXITY_LIMIT,
    DEFENCE_FILTERS,
    INFLUENCE_FILTERS,
    predictComplexity,
    QueryCompileError,
    requirementFilters,
} from './query-compiler.ts';
export type { CompiledQuery, PlanCost } from './query-compiler.ts';
export {
    checkPlan,
    DEFENCE_NAMES,
    emptyPlan,
    isEmptyPlan,
    MAX_INFLUENCES,
    MAX_PREFIXES,
    MAX_SUFFIXES,
    localDefences,
    MAX_TOTALS,
    planTotals,
    planDefences,
    PlanSlotData,
    pruneWeights,
} from './plan.ts';
export { PSEUDO_TOTALS, pseudoSourceStats, pseudoTotalFor } from './pseudo-totals.ts';
export type { PseudoSource, PseudoTotal } from './pseudo-totals.ts';
export type {
    DefenceRange,
    ModPick,
    ModPosition,
    ModRule,
    PickSource,
    PickStat,
    PickStatInfo,
    PlanCheck,
    PlanDefences,
    PlanIssue,
    PlanNoteCode,
    PlanProblemCode,
    PlanTotal,
    SlotPlan,
} from './plan.ts';
export { comparedDefence, lineNumber, lineValue, matchPlan, NO_PLAN_MATCH } from './plan-match.ts';
export type {
    DefenceMatch,
    ExclusionMatch,
    MatchedLine,
    MatchItem,
    MatchSpec,
    MatchStatus,
    PlanMatch,
    RequirementMatch,
} from './plan-match.ts';
export { buildSlotSpec, PlanRequirements, siteRange } from './slot-spec.ts';
export type { PlanBuildData, SlotSpecResult } from './slot-spec.ts';
export { applyWeightEdits, DEFAULT_LEVEL_FILTER, maxLevelRequirement, pobWeightList, pobWeights, saveSpec, SpecBuilder } from './spec.ts';
export type {
    CheckKind,
    CheckResult,
    CheckSource,
    CheckStatus,
    ItemCheck,
    ItemNote,
    ItemNoter,
    LevelFilter,
    ListedItem,
    NoterSource,
    PobTradeQuery,
    PrunedWeight,
    PruneReason,
    RequirementSource,
    RunContext,
    SavedSpec,
    ScoredStats,
    SearchDefence,
    SearchExclusion,
    SearchRequirement,
    SlotId,
    SlotSearchSpec,
    SpecSources,
    WeightedStat,
    WeightSource,
} from './spec.ts';
export { ATTRIBUTES, ELEMENTS, maxRes, stat } from './stats.ts';
export type { Attribute, Element, PobStats } from './stats.ts';
export { v1SpecBuilder } from './v1.ts';
export { DEFAULT_VALUE_SHARE, valuePick } from './value-rule.ts';
export type { ValueSettings, Verdict } from './value-rule.ts';
export { deepenSlotSearch, interleave, runSlotSearch } from './run.ts';
export type {
    EngineScore,
    PriorRun,
    RunCounts,
    RunEngine,
    RunEvent,
    RunResult,
    RunTrade,
    SearchRecord,
    SkipReason,
    SlotRunInput,
} from './run.ts';
export { buyLink, isTradeSiteUrl, TRADE_SITE } from './buy-link.ts';
export type { LinkableItem } from './buy-link.ts';
export { ModCatalog } from './catalog.ts';
export { categoryOf, DEFENCE_ITEM_TYPES, hasDefences, ITEM_TYPE_CATEGORY, SLOT_ITEM_TYPES, slotTakes } from './item-types.ts';
export type { SlotModChoice, SlotTier } from './catalog.ts';
