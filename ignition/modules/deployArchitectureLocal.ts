import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

export default buildModule('ArchitectureLocal', (m) => {
  const reusdImpl = m.contract('contracts/Reusdv2.sol:REUSD', [], { id: 'reusd_implementation' });

  const currency = 'USD';
  const initializeCall = m.encodeFunctionCall(reusdImpl, 'initialize', [currency]);

  const proxy = m.contract('ERC1967Proxy', [reusdImpl, initializeCall], { id: 'reusd_proxy_contract' });

  const reusd = m.contractAt('contracts/Reusdv2.sol:REUSD', proxy, { id: 'reusd_proxy' });

  return {
    reusd,
    proxy,
    reusdImpl
  };
});
