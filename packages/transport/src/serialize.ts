// Thin JSON (de)serialization helpers used by the codecs. Kept minimal for #1.

export const stringifyMessage = (obj: unknown): string => JSON.stringify(obj);

export const parseMessage = <T>(text: string): T => JSON.parse(text) as T;
