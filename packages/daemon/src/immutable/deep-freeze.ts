// Iterative deep freeze for immutable Daemon facts.
//
// The iterative walk also handles deeply nested, attacker-controlled JSON
// Observations without risking a recursive call-stack overflow.

export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    if (!Object.isFrozen(current)) Object.freeze(current);
  }
  return value;
};
