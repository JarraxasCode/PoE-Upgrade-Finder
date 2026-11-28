// The gear slots the app searches. Each list here is the source of its type, so the list always holds every
// member of the union.

const GEAR_SLOT_LIST = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Weapon 1', 'Weapon 2'] as const;

/** The rare gear slots the app searches. The engine accepts any PoB item slot; the app only uses these. */
export type GearSlot = (typeof GEAR_SLOT_LIST)[number];
export const GEAR_SLOTS: readonly GearSlot[] = GEAR_SLOT_LIST;

export function isGearSlot(value: string): value is GearSlot {
    return GEAR_SLOTS.some((s: GearSlot) => s === value);
}
