// Dry run by default. Staging never retires a configuration.
process.env.SEED_CATALOGUE = 'legacy';
process.env.SEED_RETIRE_LEGACY = 'true';
import './seedSideBetConfigs';
