// v1's sources: PoB's generator for the weights, the strip step for the requirements, the build's floors
// for the checks, and no noters (v2 adds user requirements, our own weights, per-slot floors and the
// eldritch-implicit noter as further sources).

import { buildFloors, stripNeedsSource } from './floors.ts';
import { pobWeights, SpecBuilder } from './spec.ts';

export function v1SpecBuilder(): SpecBuilder {
    return new SpecBuilder({ requirements: [stripNeedsSource], weights: [pobWeights], checks: [buildFloors], noters: [] });
}
