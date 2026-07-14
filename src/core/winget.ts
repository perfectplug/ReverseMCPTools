import { exec, which } from "./exec.js";

/** Whether winget is available (Windows 10 1809+ / Windows 11 by default). */
export async function hasWinget(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return (await which("winget")) !== undefined;
}

/**
 * Install (or upgrade to) a package via winget by its package id.
 * Runs non-interactively and accepts agreements so it can be scripted.
 */
export async function wingetInstall(
  id: string,
  opts: { inherit?: boolean; override?: string[] } = {},
): Promise<void> {
  const args = [
    "install",
    "--exact",
    "--id",
    id,
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
    "--silent",
    ...(opts.override ?? []),
  ];
  const res = await exec("winget", args, {
    inherit: opts.inherit ?? true,
    allowFailure: true,
    timeoutMs: 15 * 60 * 1000,
  });
  // winget returns 0x8A15002B when the package is already installed / no upgrade.
  const alreadyInstalled = res.code === -1978335189 || res.code === -1978335212;
  if (!res.ok && !alreadyInstalled) {
    throw new Error(`winget install ${id} failed (exit ${res.code})`);
  }
}
