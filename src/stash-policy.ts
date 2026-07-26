type StashPolicyConfig = { readonly requireEmptyStashInventory?: unknown };
type StashInventory = { readonly length: number };

export function hasBlockingStashInventory(config: StashPolicyConfig, stashes: StashInventory): boolean {
  return config.requireEmptyStashInventory === true && stashes.length > 0;
}
