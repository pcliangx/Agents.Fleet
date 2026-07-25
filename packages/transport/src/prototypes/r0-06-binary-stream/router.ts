import type { SessionId } from "@agents-fleet/contracts";
import type { DecodedFrame } from "../../binary-frame.js";
import { type AttachmentFlowState, ingestDurableFrame } from "./model.js";

export interface MultiplexRoute {
  readonly state: AttachmentFlowState;
  readonly expectedPayloadMarker: number;
}

export interface MultiplexRouter {
  readonly routes: ReadonlyMap<SessionId, MultiplexRoute>;
  readonly crossSessionFrames: number;
  readonly unknownSessionFrames: number;
}

export interface RouteBinaryFrameResult {
  readonly router: MultiplexRouter;
  readonly accepted: boolean;
}

export const createMultiplexRouter = (routes: readonly MultiplexRoute[]): MultiplexRouter => ({
  routes: new Map(routes.map((route) => [route.state.sessionId, route])),
  crossSessionFrames: 0,
  unknownSessionFrames: 0,
});

export const replaceRouteState = (
  router: MultiplexRouter,
  state: AttachmentFlowState,
): MultiplexRouter => {
  const route = router.routes.get(state.sessionId);
  if (route === undefined) throw new Error(`missing multiplex route for ${state.sessionId}`);
  const routes = new Map(router.routes);
  routes.set(state.sessionId, { ...route, state });
  return { ...router, routes };
};

export const routeBinaryFrame = (
  router: MultiplexRouter,
  decoded: DecodedFrame,
  wire: Uint8Array,
): RouteBinaryFrameResult => {
  const route = router.routes.get(decoded.header.sessionId);
  if (route === undefined) {
    return {
      accepted: false,
      router: { ...router, unknownSessionFrames: router.unknownSessionFrames + 1 },
    };
  }

  if (decoded.payload[0] !== route.expectedPayloadMarker) {
    return {
      accepted: false,
      router: { ...router, crossSessionFrames: router.crossSessionFrames + 1 },
    };
  }

  const nextState = ingestDurableFrame(route.state, {
    header: decoded.header,
    payloadBytes: decoded.payload.byteLength,
    wireBytes: wire.byteLength,
  });
  const accepted =
    nextState.identityErrors === route.state.identityErrors &&
    nextState.sequenceErrors === route.state.sequenceErrors &&
    nextState.durableSeq === decoded.header.seq;
  const routes = new Map(router.routes);
  routes.set(decoded.header.sessionId, { ...route, state: nextState });
  return { accepted, router: { ...router, routes } };
};
