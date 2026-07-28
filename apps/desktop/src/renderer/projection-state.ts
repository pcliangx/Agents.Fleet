import type { FleetProjectionView } from "@agents-fleet/contracts";

export const markProjectionStale = (projection: FleetProjectionView): FleetProjectionView => ({
  ...projection,
  tasks: projection.tasks.map((task) => ({ ...task, freshness: "Stale" })),
  freshness: "Stale",
});
