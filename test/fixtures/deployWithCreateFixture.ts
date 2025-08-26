import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deployWithCreate } from "../../scripts/deployWithCreate";

/**
 * Shared fixture that uses the deployWithCreate script
 * This fixture provides all deployed contracts and mock contracts for testing
 */
export function useDeployWithCreateFixture() {
  return loadFixture(deployWithCreate);
}
