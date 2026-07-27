// Stable identity for a secret reference. This hashes reference metadata only;
// secret material is never accepted by this function.

import type { SecretReference } from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";

export const secretReferenceIdentity = (reference: SecretReference): string =>
  `${reference.kind}:${canonicalSha256(reference)}`;
