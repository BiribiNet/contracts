// Public release metadata only; this module never calls a provider or a signer.
export const validAddress = value => /^0x[\da-f]{40}$/i.test(value ?? '') && !/^0x0{40}$/i.test(value);

export function releaseDefaults(manifest) {
  const mode = manifest.automation?.mode ?? 'cre';
  if (!['cre', 'keeper'].includes(mode)) throw new Error('Unknown automation mode.');
  const key = manifest.defaultMarket ?? 'usdc'; // Preserve existing Sepolia manifests.
  if (typeof key !== 'string' || !Object.hasOwn(manifest.markets ?? {}, key)) throw new Error('Default market is missing.');
  const market = manifest.markets[key];
  if (!validAddress(market?.bank)) throw new Error('Default bank is invalid.');
  const receiver = manifest.addresses?.automationReceiver;
  if (mode === 'cre' && !validAddress(receiver)) throw new Error('CRE requires an AutomationReceiver.');
  if (mode === 'keeper' && receiver != null && receiver !== '') throw new Error('Keeper release must not configure a CRE receiver.');
  if (!validAddress(manifest.addresses?.creExecutionAuthority)) throw new Error('Execution authority is missing.');
  return { mode, market, receiver: mode === 'cre' ? receiver : '' };
}
