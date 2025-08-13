import type { Provider, TransactionResponse } from "ethers";

const delay = (durationMs: number) => {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }

export const waitForTransaction = async (provider: Provider, tx: TransactionResponse) => {
    let finished = false;
    const result = await Promise.race([
        tx.wait(),
        (async () => {
            while (!finished) {
                await delay(3000);
                const mempoolTx = await provider.getTransaction(tx.hash);
                if (!mempoolTx){
                    return null;
                } 
            }
        })()
    ]);
    finished = true;
    if (!result){
        throw `Transaction ${tx.hash} failed`;
    }
    return result;
  }
  