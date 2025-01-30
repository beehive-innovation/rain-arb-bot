/* eslint-disable no-console */
import { ChainId } from "sushi";
import { ethers } from "ethers";
import { TokenDetails } from "../src/types";
import { errorSnapshot } from "../src/error";
import { PublicClient, erc20Abi } from "viem";
import { routeProcessor3Abi } from "../src/abis";
import { setWatchedTokens } from "../src/account";
import { Native, Token, WNATIVE } from "sushi/currency";
import { ROUTE_PROCESSOR_4_ADDRESS } from "sushi/config";
import { getRpSwap, PoolBlackList, sleep } from "../src/utils";
import { createViemClient, getDataFetcher, processLps } from "../src/config";
import { HDAccount, mnemonicToAccount, PrivateKeyAccount } from "viem/accounts";

/**
 * Sweep wallet's tokens
 */
export async function sweepWalletTokens(
    mnemonic: string,
    tokens: TokenDetails[],
    chainId: ChainId,
    rpc: string,
    length: number,
) {
    let walletIndex = 1;
    const toWallet = await createViemClient(
        chainId as ChainId,
        [rpc],
        undefined,
        mnemonicToAccount(mnemonic, { addressIndex: 0 }),
        60_000,
    );
    console.log("main wallet ", toWallet.account.address);
    const gasPrice = ethers.BigNumber.from(await toWallet.getGasPrice())
        .mul(107)
        .div(100)
        .toBigInt();
    for (let j = 0; j < length; j++) {
        const fromWallet = await createViemClient(
            chainId as ChainId,
            [rpc],
            undefined,
            mnemonicToAccount(mnemonic, { addressIndex: walletIndex++ }),
            60_000,
        );
        await setWatchedTokens(fromWallet, tokens);
        console.log("wallet index", walletIndex - 1, fromWallet.account.address);

        // from wallet gas balance
        for (let i = 0; i < 5; i++) {
            try {
                fromWallet.BALANCE = ethers.BigNumber.from(
                    await fromWallet.getBalance({ address: fromWallet.account.address }),
                );
                break;
            } catch (error) {
                if (i === 4) throw "Failed to get gas balance";
                else await sleep(i * 10000);
            }
        }

        const erc20 = new ethers.utils.Interface(erc20Abi);
        const txs: {
            bounty: TokenDetails;
            balance: string;
            tx: {
                to: `0x${string}`;
                data: `0x${string}`;
            };
        }[] = [];
        const failedBounties: TokenDetails[] = [];
        let cumulativeGasLimit = ethers.constants.Zero;
        for (let i = 0; i < fromWallet.BOUNTY.length; i++) {
            const bounty = fromWallet.BOUNTY[i];
            try {
                const balance = ethers.BigNumber.from(
                    (
                        await fromWallet.call({
                            to: bounty.address as `0x${string}`,
                            data: erc20.encodeFunctionData("balanceOf", [
                                fromWallet.account.address,
                            ]) as `0x${string}`,
                        })
                    ).data,
                );
                if (balance.isZero()) {
                    continue;
                }
                const tx = {
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("transfer", [
                        toWallet.account.address,
                        balance,
                    ]) as `0x${string}`,
                };
                txs.push({
                    tx,
                    bounty,
                    balance: ethers.utils.formatUnits(balance, bounty.decimals),
                });
                const gas = await fromWallet.estimateGas(tx);
                cumulativeGasLimit = cumulativeGasLimit.add(gas);
            } catch (e) {
                failedBounties.push(bounty);
                console.log("Failed to get balance " + errorSnapshot("", e));
            }
        }

        if (cumulativeGasLimit.mul(gasPrice).gt(fromWallet.BALANCE)) {
            try {
                const transferAmount = cumulativeGasLimit.mul(gasPrice).sub(fromWallet.BALANCE);
                console.log("gas amount ", ethers.utils.formatUnits(transferAmount));
                const hash = await toWallet.sendTransaction({
                    to: fromWallet.account.address,
                    value: transferAmount.toBigInt(),
                });
                const receipt = await toWallet.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    console.log("Successfully topped up");
                } else {
                    console.log(
                        "Failed topping up wallet for sweeping tokens back to main wallet: reverted",
                    );
                }
            } catch (error) {
                console.log(
                    "Failed topping up wallet for sweeping tokens back to main wallet: " +
                        errorSnapshot("", error),
                );
            }
        }

        for (let i = 0; i < txs.length; i++) {
            console.log("token ", txs[i].bounty.symbol);
            console.log("tokenAddress ", txs[i].bounty.address);
            console.log("balance ", txs[i].balance);
            try {
                const hash = await fromWallet.sendTransaction(txs[i].tx);
                const receipt = await fromWallet.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    console.log("Successfully swept back to main wallet");
                } else {
                    failedBounties.push(txs[i].bounty);
                    console.log("Failed to sweep back to main wallet: reverted");
                }
            } catch (error) {
                failedBounties.push(txs[i].bounty);
                console.log("Failed to sweep back to main wallet: " + errorSnapshot("", error));
            }
        }

        // empty gas if all tokens are swept
        if (!failedBounties.length) {
            try {
                const gasLimit = ethers.BigNumber.from(
                    await fromWallet.estimateGas({
                        to: toWallet.account.address,
                        value: 0n,
                    }),
                );
                const remainingGas = ethers.BigNumber.from(
                    await fromWallet.getBalance({ address: fromWallet.account.address }),
                );
                const transferAmount = remainingGas.sub(gasLimit.mul(gasPrice));
                if (transferAmount.gt(0)) {
                    console.log("remaining gas amount ", ethers.utils.formatUnits(transferAmount));
                    const hash = await fromWallet.sendTransaction({
                        to: toWallet.account.address,
                        value: transferAmount.toBigInt(),
                        gas: gasLimit.toBigInt(),
                    });
                    const receipt = await fromWallet.waitForTransactionReceipt({
                        hash,
                        confirmations: 2,
                        timeout: 100_000,
                    });
                    if (receipt.status === "success") {
                        console.log("Successfully swept gas tokens back to main wallet");
                    } else {
                        console.log("Failed to sweep gas tokens back to main wallet: reverted");
                    }
                } else {
                    console.log("Transfer amount lower than gas cost");
                }
            } catch (error) {
                console.log(
                    "Failed to sweep gas tokens back to main wallet: " + errorSnapshot("", error),
                );
            }
        } else {
            console.log("not all tokens were swept, so did not sweep the remaining gas");
        }
        console.log("\n---\n");
    }
}

/**
 * Sweeps the given tokens to the chain's gas token
 */
export async function sweepToGas(
    account: HDAccount | PrivateKeyAccount,
    rpc: string,
    chainId: ChainId,
    tokens: TokenDetails[],
) {
    const rp4Address = ROUTE_PROCESSOR_4_ADDRESS[
        chainId as keyof typeof ROUTE_PROCESSOR_4_ADDRESS
    ] as `0x${string}`;
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const mainAccount = await createViemClient(chainId, [rpc], undefined, account, 60_000);
    setWatchedTokens(mainAccount, tokens);
    const dataFetcher = await getDataFetcher(
        mainAccount as any as PublicClient,
        processLps(),
        false,
    );
    const gasPrice = ethers.BigNumber.from(await mainAccount.getGasPrice())
        .mul(107)
        .div(100);
    for (let i = 0; i < mainAccount.BOUNTY.length; i++) {
        const bounty = mainAccount.BOUNTY[i];
        console.log("token", bounty.symbol);
        console.log("tokenAddress", bounty.address);
        try {
            const balance = ethers.BigNumber.from(
                (
                    await mainAccount.call({
                        to: bounty.address as `0x${string}`,
                        data: erc20.encodeFunctionData("balanceOf", [
                            mainAccount.account.address,
                        ]) as `0x${string}`,
                    })
                ).data,
            );
            console.log("balance", ethers.utils.formatUnits(balance, bounty.decimals));
            if (balance.isZero()) {
                console.log("\n---\n");
                continue;
            }
            const token = new Token({
                chainId: chainId,
                decimals: bounty.decimals,
                address: bounty.address,
                symbol: bounty.symbol,
            });
            await dataFetcher.fetchPoolsForToken(token, WNATIVE[chainId], PoolBlackList);
            const { rpParams, route } = await getRpSwap(
                chainId,
                balance,
                token,
                Native.onChain(chainId),
                mainAccount.account.address,
                rp4Address,
                dataFetcher,
                gasPrice,
            );
            let routeText = "";
            route.legs.forEach((v, i) => {
                if (i === 0)
                    routeText =
                        routeText +
                        (v?.tokenTo?.symbol ?? "") +
                        "/" +
                        (v?.tokenFrom?.symbol ?? "") +
                        "(" +
                        ((v as any)?.poolName ?? "") +
                        " " +
                        (v?.poolAddress ?? "") +
                        ")";
                else
                    routeText =
                        routeText +
                        " + " +
                        (v?.tokenTo?.symbol ?? "") +
                        "/" +
                        (v?.tokenFrom?.symbol ?? "") +
                        "(" +
                        ((v as any)?.poolName ?? "") +
                        " " +
                        (v?.poolAddress ?? "") +
                        ")";
            });
            console.log("Route portions: ", routeText, "\n");
            const allowance = (
                await mainAccount.call({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("allowance", [
                        mainAccount.account.address,
                        rp4Address,
                    ]) as `0x${string}`,
                })
            ).data;
            if (allowance && balance.gt(allowance)) {
                console.log("Approving spend limit");
                const hash = await mainAccount.sendTransaction({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("approve", [
                        rp4Address,
                        balance.mul(100),
                    ]) as `0x${string}`,
                });
                await mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
            }
            console.log("rp4 ", rp4Address);
            const rawtx = { to: rp4Address, data: "0x" as `0x${string}` };
            let gas = 0n;
            let amountOutMin = ethers.constants.Zero;
            for (let j = 20; j > 0; j--) {
                amountOutMin = ethers.BigNumber.from(rpParams.amountOutMin)
                    .mul(5 * j)
                    .div(100);
                rawtx.data = rp.encodeFunctionData("processRoute", [
                    rpParams.tokenIn,
                    rpParams.amountIn,
                    rpParams.tokenOut,
                    amountOutMin,
                    rpParams.to,
                    rpParams.routeCode,
                ]) as `0x${string}`;
                try {
                    gas = await mainAccount.estimateGas(rawtx);
                    break;
                } catch (error) {
                    if (j === 1) throw error;
                }
            }
            const gasCost = gasPrice.mul(gas).mul(15).div(10);
            console.log("gas cost: ", ethers.utils.formatUnits(gasCost));
            if (gasCost.mul(10).gte(amountOutMin)) {
                console.log("Skipped, balance not large enough to justify sweeping");
                console.log("\n---\n");
                continue;
            } else {
                const hash = await mainAccount.sendTransaction(rawtx);
                console.log("tx hash: ", hash);
                const receipt = await mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    console.log("Successfully swept to eth");
                } else {
                    console.log(`Failed to sweep ${bounty.symbol} to eth: tx reverted`);
                }
            }
        } catch (e) {
            console.log(`Failed to sweep ${bounty.symbol} to eth: ` + errorSnapshot("", e));
        }
        await sleep(5000);
        console.log("\n---\n");
    }
}
