/** Generate the small, versioned client ABI without replacing unrelated frontend ABIs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  rouletteDiagnosticsAbi: ['RouletteEngine', ['roundDiagnostics', 'RoulettePayment', 'JackpotPayment']],
  withdrawalReceiptsAbi: ['BankVault4626', ['withdrawalReceipt', 'pendingWithdrawalStatus', 'WithdrawalIdentified', 'WithdrawalPaid']],
  fundingDiagnosticsAbi: ['BRBJackpotFunder', ['pendingFundingBalances', 'fundingAttemptCount', 'FundingAttemptStarted', 'FundingAttemptCompleted']],
};
let output = '// Generated from BiribiNet/contracts; run scripts/export-protocol-observability.mjs.\n';
for (const [name, [contract, names]] of Object.entries(targets)) {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/contracts', `${contract}.sol`, `${contract}.json`), 'utf8'));
  const abi = artifact.abi.filter(item => names.includes(item.name));
  if (abi.length !== names.length) throw new Error(`Compile ${contract} before export`);
  output += `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
}
const destination = path.resolve(root, process.env.FRONTEND_DIR ?? '../frontend', 'lib/abi/protocol-observability.ts');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, output);
console.log(`Exported ${destination}`);
