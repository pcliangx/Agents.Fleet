// RT-DIST-08 — SupportedPlatformMatrix TYPE ONLY. Values frozen in #15.
// Transcribed from runtime-contracts-v1.md §11.

export interface MinimumHardware {
  readonly machineModel: string;
  readonly cpuClass: string;
  readonly gpuClass: string;
  readonly memoryBytes: number;
}

export type RendererPath = "WebGL2" | "DOM";

export interface SupportedPlatformMatrix {
  readonly matrixVersion: number;
  readonly architecture: "arm64";
  readonly minimumMacOSVersion: string;
  readonly minimumHardware: MinimumHardware;
  readonly electronVersion: string;
  readonly nodeRuntimeVersion: string;
  readonly nodePtyArtifactIdentity: string;
  readonly terminalPackageSetIdentity: string;
  readonly runtimeLimitProfileVersion: number;
  readonly rendererPaths: readonly RendererPath[];
  readonly keychainPolicyVersion: number;
  readonly signingAndNotarizationPolicyVersion: number;
  readonly evidenceRefs: readonly string[];
}
