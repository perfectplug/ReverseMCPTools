import type { Recipe } from "../core/types.js";
import { x64dbgRecipe } from "./x64dbg.js";
import { ghidraRecipe } from "./ghidra.js";
import { jadxRecipe } from "./jadx.js";
import { jshookRecipe } from "./jshook.js";

/** Ordered catalog of RE tool recipes. Add new recipes here. */
export const RECIPES: Recipe[] = [
  ghidraRecipe,
  jadxRecipe,
  x64dbgRecipe,
  jshookRecipe,
];

export function getRecipe(id: string): Recipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown recipe: ${id}`);
  return r;
}

export function recipesForPlatform(platform: string): Recipe[] {
  return RECIPES.filter((r) => (r.platforms as string[]).includes(platform));
}
