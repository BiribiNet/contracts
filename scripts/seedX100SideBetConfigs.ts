// Reuse the existing chain, role, settlement-health, liquidity and idempotency guards.
// The default is still a dry run; SEED_APPLY=true is required to broadcast on Sepolia.
process.env.SEED_CATALOGUE = 'x100';
import './seedSideBetConfigs';
