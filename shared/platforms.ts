// Platform identity is public product metadata. Never derive it from a saved
// connection label, which may contain the upstream login account.
export const platformNames = {gatelink:'Gatelink',ai008:'AI008',minicc:'Mini CC Gateway'} as const;
export function platformName(provider:string):string {
  return platformNames[provider as keyof typeof platformNames]??'—';
}
