// withTempFs — create a temp app-data layout (root + worktrees + chunks), remove on exit.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AppDataLayout {
  readonly root: string;
  readonly worktrees: string;
  readonly chunks: string;
}

export const withTempFs = async <T>(cb: (layout: AppDataLayout) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "af-fs-"));
  const worktrees = join(root, "worktrees");
  const chunks = join(root, "chunks");
  await mkdir(worktrees);
  await mkdir(chunks);
  try {
    return await cb({ root, worktrees, chunks });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
