// Shared transition-table machinery. Each state machine declares
// `as const satisfies TransitionTable<State>` so the union and the table
// cannot drift at compile time (a missing row or a bogus target is a type error).

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

// `noUncheckedIndexedAccess` makes index-by-variable return `T | undefined`;
// fall back to an empty list so callers stay clean.
export const canTransition = <S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean => (table[from] ?? []).includes(to);

export const allowedNext = <S extends string>(table: TransitionTable<S>, from: S): readonly S[] =>
  table[from] ?? [];

// A state is terminal iff it has no outgoing edges. Each machine also exports an
// explicit terminal list matching the spec; tests assert the two agree.
export const hasNoOutgoing = <S extends string>(table: TransitionTable<S>, s: S): boolean =>
  (table[s] ?? []).length === 0;
