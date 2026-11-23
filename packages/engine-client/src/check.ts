// The engine's JSON checks live in packages/validate (shared with the trade client). ProtocolError is the
// name the engine client has always used for them.

export {
    array,
    boolean,
    isRecord,
    number,
    oneOf,
    optional,
    record,
    string,
    ValidationError as ProtocolError,
} from '@poe-upgrade-finder/validate';
export type { JsonRecord } from '@poe-upgrade-finder/validate';
