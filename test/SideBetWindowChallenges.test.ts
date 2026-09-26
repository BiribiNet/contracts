import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, getAddress, parseUnits } from "viem";

import { predictSideBetProxyAddress } from "../scripts/utils/predictDeployAddresses";

import { customErrorPattern } from "./helpers/customErrorPattern";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";

const MIN_MULTIPLIER_BPS = 50_000; // 5x
const MAX_MULTIPLIER_BPS = 5_000_000; // 500x
const INFRA_BPS = 200n;
const SW_BPS_DENOM = 10_000n;
const ROUTER_BRB_LIQUIDITY = parseUnits("2000000", 18);

const USDC = (value: string): bigint => parseUnits(value, 6);

const BetType = {
    COLOR_COUNT: 0,
    NUMBER_HIT: 1,
    CONSECUTIVE_STREAK: 2,
    RED_RATIO: 3,
    LIGHTNING_DOUBLE: 4,
    PERFECT_ALTERNATION: 5,
    DOZEN_HIT: 6,
    COLUMN_HIT: 7,
    JACKPOT_IN_WINDOW: 8,
} as const;
const ANY_NUMBER = 37;
const Color = { RED: 0, BLACK: 1 } as const;
const Status = { ACTIVE: 0, WON: 1, LOST: 2, EXPIRED: 3, CANCELLED: 4 } as const;

const MARKET_ID = 1;

type ConfigInput = {
    marketId: number;
    betType: number;
    color: number;
    targetNumber: number;
    targetCount: number;
    redRatioBps: number;
    windowSpins: number;
    multiplierBps: number;
    minStake: bigint;
    maxStake: bigint;
};

function config(overrides: Partial<ConfigInput> = {}): ConfigInput {
    return {
        marketId: MARKET_ID,
        betType: BetType.NUMBER_HIT,
        color: Color.RED,
        targetNumber: 0,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000, // 10x
        minStake: USDC("1"),
        maxStake: USDC("1000"),
        ...overrides,
    };
}

/** Registers a config template and activates stake limits (split roles on-chain). */
async function registerConfig(
    sideBet: Awaited<ReturnType<typeof deployFixture>>["sideBet"],
    cfg: ConfigInput,
    account: { address: `0x${string}` },
) {
    const { minStake, maxStake, ...template } = cfg;
    await sideBet.write.addConfig([{ ...template, minStake: 0n, maxStake: 0n }], { account });
    const configId = (await sideBet.read.configCount()) - 1n;
    await sideBet.write.setConfigStakeLimits([configId, minStake, maxStake], { account });
    return configId;
}

type SchedulerContract = Awaited<ReturnType<typeof viem.deployContract<"UpkeepScheduler">>>;

async function settleViaScheduler(scheduler: SchedulerContract) {
    const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
    expect(performData).to.not.equal("0x");
    await scheduler.write.performUpkeep([performData]);
}

async function deployFixture() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
    const roundEngine = await viem.deployContract("MockRoundEngine");

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);

    const { registry } = await deploySideBetRegistryStack({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
    });
    const { sideBet } = await deploySideBetProxy({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
        registry: registry.address,
        minMultiplierBps: MIN_MULTIPLIER_BPS,
        maxMultiplierBps: MAX_MULTIPLIER_BPS,
    });
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    const scheduler = await viem.deployContract("UpkeepScheduler", [
        roundEngine.address,
        sideBet.address,
        admin.account.address,
        32,
        32,
    ]);
    const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
    await sideBet.write.grantRole([settlementRole, scheduler.address], { account: admin.account });
    await wireTestSchedulerForwarder(scheduler, admin.account);

    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
        { account: admin.account },
    );
    const market = await registry.read.getMarket([MARKET_ID]);
    const vault = await viem.getContractAt("BankVault4626", market.bank);
    expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(sideBet.address));

    // LP liquidity in the vault.
    await usdc.write.mint([admin.account.address, USDC("10000")]);
    await usdc.write.approve([vault.address, USDC("10000")], { account: admin.account });
    await vault.write.deposit([USDC("10000"), admin.account.address], { account: admin.account });

    await usdc.write.mint([alice.account.address, USDC("1000")]);
    await usdc.write.approve([vault.address, USDC("1000")], { account: alice.account });

    return { sideBet, scheduler, vault, usdc, registry, roundEngine, admin, alice, bob, publicClient };
}

async function fulfillRounds(
    roundEngine: { write: { fulfillRounds: (a: [number[]]) => Promise<unknown> } },
    numbers: number[],
) {
    await roundEngine.write.fulfillRounds([numbers]);
}

async function fulfillRoundsWithJackpot(
    roundEngine: {
        write: { fulfillRoundsWithJackpot: (a: [number[], boolean[]]) => Promise<unknown> };
    },
    numbers: number[],
    jackpots: boolean[],
) {
    await roundEngine.write.fulfillRoundsWithJackpot([numbers, jackpots]);
}


const variants = [
  {
    "targetCount": 3,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "Tour des douzaines",
    "betType": 9,
    "windowSpins": 5,
    "yes": [
      1,
      13,
      25,
      0,
      2
    ],
    "no": [
      0,
      1,
      12,
      0,
      13
    ]
  },
  {
    "targetCount": 5,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "Sans doublon",
    "betType": 13,
    "windowSpins": 5,
    "yes": [
      0,
      1,
      2,
      3,
      4
    ],
    "no": [
      0,
      1,
      2,
      3,
      3
    ]
  },
  {
    "targetCount": 0,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "Le Retour",
    "betType": 15,
    "windowSpins": 5,
    "yes": [
      0,
      2,
      3,
      0,
      5
    ],
    "no": [
      0,
      1,
      2,
      3,
      4
    ]
  },
  {
    "targetCount": 0,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "Le Miroir",
    "betType": 16,
    "windowSpins": 4,
    "yes": [
      1,
      2,
      4,
      3
    ],
    "no": [
      1,
      2,
      0,
      3
    ]
  },
  {
    "targetCount": 0,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "La Montee",
    "betType": 17,
    "windowSpins": 3,
    "yes": [
      0,
      1,
      36
    ],
    "no": [
      1,
      1,
      36
    ]
  },
  {
    "targetCount": 0,
    "targetNumber": 40,
    "redRatioBps": 60,
    "name": "La Somme",
    "betType": 18,
    "windowSpins": 3,
    "yes": [
      10,
      20,
      30
    ],
    "no": [
      0,
      1,
      2
    ]
  },
  {
    "targetCount": 0,
    "targetNumber": 0,
    "redRatioBps": 0,
    "name": "Le Duel final",
    "betType": 19,
    "windowSpins": 5,
    "yes": [
      1,
      3,
      5,
      2,
      0
    ],
    "no": [
      1,
      3,
      2,
      4,
      0
    ]
  },
  {
    "targetCount": 2,
    "targetNumber": 1,
    "redRatioBps": 0,
    "name": "Le Compte exact",
    "betType": 20,
    "windowSpins": 5,
    "yes": [
      1,
      12,
      0,
      13,
      36
    ],
    "no": [
      1,
      2,
      3,
      0,
      36
    ]
  }
];
describe('Window challenge settlement',()=>{
 for(const v of variants) for(const win of [true,false]) it(v.name+(win?' wins':' loses')+' exactly once and releases reserves',async()=>{
  const {sideBet,vault,usdc,admin,alice,roundEngine}=await deployFixture();
  await sideBet.write.setMultiplierBand([10001,5000000],{account:admin.account});
  await registerConfig(sideBet,config({...v,multiplierBps:20000}),admin.account);
  const before=await usdc.read.balanceOf([alice.account.address]);
  await sideBet.write.placeBet([0n,USDC('10')],{account:alice.account});
  await roundEngine.write.fulfillRounds([win?v.yes:v.no]);
  await sideBet.write.grantRole([await sideBet.read.SETTLEMENT_ROLE(),admin.account.address],{account:admin.account});
  const [rows,,bundles]=await sideBet.read.previewSettleBundleV2([0n,10,0,1]);
  expect(rows.length).eq(1);expect(rows[0].won).eq(win);
  await sideBet.write.settleBatchV2([rows,bundles],{account:admin.account});
  const after=await usdc.read.balanceOf([alice.account.address]);
  expect(after-before).eq(win?USDC('10'):-USDC('10'));
  await sideBet.write.settleBatchV2([rows,bundles],{account:admin.account});
  expect(await usdc.read.balanceOf([alice.account.address])).eq(after);
  expect(await sideBet.read.reservedOf([1])).eq(0n);expect(await vault.read.lockedBetLiquidity()).eq(0n);
 });
 it('rejects invalid parameter encodings at the public config entrypoint',async()=>{
  const {sideBet,admin}=await deployFixture();
  for(const bad of [{betType:15,windowSpins:1},{betType:16,windowSpins:3},{betType:17,windowSpins:4},{betType:18,windowSpins:3,targetNumber:61,redRatioBps:60},{betType:18,windowSpins:3,targetNumber:0,redRatioBps:108},{betType:18,windowSpins:3,targetNumber:40,redRatioBps:109},{betType:19,targetCount:1},{betType:20,targetNumber:0},{betType:20,targetNumber:4},{betType:20,targetNumber:1,targetCount:4,windowSpins:3}]) await expect(registerConfig(sideBet,config({targetCount:0,...bad}),admin.account)).to.be.rejected;
 });
 it('never settles an exact count before its last result',async()=>{
  const {sideBet,admin,alice,roundEngine}=await deployFixture();
  await registerConfig(sideBet,config({betType:20,targetNumber:1,targetCount:2,windowSpins:5}),admin.account);
  await sideBet.write.placeBet([0n,USDC('10')],{account:alice.account});
  await roundEngine.write.fulfillRounds([[1,2]]);
  const [rows]=await sideBet.read.previewSettleBundleV2([0n,10,0,1]);expect(rows.length).eq(0);
 });
});
