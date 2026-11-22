import type { TradeLogger } from '../src/trade-client.ts';

export const silent: TradeLogger = {
    log(): void {
        // nothing
    },
};
