// Elements, attributes and the per-build floor settings (PLAN.md, Scoring & ranking, step 2).

const ELEMENT_LIST = ['Fire', 'Cold', 'Lightning'] as const;
export type Element = (typeof ELEMENT_LIST)[number];
export const ELEMENTS: readonly Element[] = ELEMENT_LIST;

const ATTRIBUTE_LIST = ['Str', 'Dex', 'Int'] as const;
export type Attribute = (typeof ATTRIBUTE_LIST)[number];
export const ATTRIBUTES: readonly Attribute[] = ATTRIBUTE_LIST;

/** Per build (Settings). Omitted entries are off. */
export interface FloorSettings {
    readonly chaosResMin?: number;
    readonly maxResMin?: Readonly<Partial<Record<Element, number>>>;
    readonly elementalResCapped?: boolean;
    readonly spellBlockMin?: number;
    readonly attributesMet?: boolean;
    readonly targets?: {
        readonly chaosRes?: number;
        readonly maxRes?: Readonly<Partial<Record<Element, number>>>;
        /** Overcap wanted per element. */
        readonly overcapMin?: number;
    };
    /** Life loss is flagged on every slot except the weapons. */
    readonly flagLifeLoss?: boolean;
    /** Net life regen turning negative, on builds with a degen (NetLifeRegen present). */
    readonly flagNetRegen?: boolean;
}
