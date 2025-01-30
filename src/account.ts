import { ChainId, RPParams } from "sushi";
import { BigNumber, ethers } from "ethers";
import { erc20Abi, PublicClient } from "viem";
import { estimateGasCost, getTxFee } from "./gas";
import { ErrorSeverity, errorSnapshot } from "./error";
import { Native, Token, WNATIVE } from "sushi/currency";
import { ROUTE_PROCESSOR_4_ADDRESS } from "sushi/config";
import { createViemClient, getDataFetcher } from "./config";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { getRpSwap, PoolBlackList, sleep, addWatchedToken } from "./utils";
import { context, Context, SpanStatusCode, trace, Tracer } from "@opentelemetry/api";
import { MulticallAbi, orderbookAbi, routeProcessor3Abi, VaultBalanceAbi } from "./abis";
import {
    BotConfig,
    CliOptions,
    ViemClient,
    OwnedOrder,
    TokenDetails,
    OperationState,
    BundledOrders,
} from "./types";

/** Standard base path for eth accounts */
export const BasePath = "m/44'/60'/0'/0/" as const;

/** Main account derivation index */
export const MainAccountDerivationIndex = 0 as const;

/**
 * Generates array of accounts from mnemonic phrase and tops them up from main acount
 * @param mnemonicOrPrivateKey - The mnemonic phrase or private key
 * @param config - The config obj
 * @param options - The config obj
 * @returns Array of ethers Wallets derived from the given menomonic phrase and standard derivation path
 */
export async function initAccounts(
    mnemonicOrPrivateKey: string,
    config: BotConfig,
    options: CliOptions,
    tracer?: Tracer,
    ctx?: Context,
) {
    const accounts: ViemClient[] = [];
    const isMnemonic = !/^(0x)?[a-fA-F0-9]{64}$/.test(mnemonicOrPrivateKey);
    const mainAccount = await createViemClient(
        config.chain.id as ChainId,
        config.rpc,
        config.publicRpc,
        isMnemonic
            ? mnemonicToAccount(mnemonicOrPrivateKey, {
                  addressIndex: MainAccountDerivationIndex,
              })
            : privateKeyToAccount(
                  (mnemonicOrPrivateKey.startsWith("0x")
                      ? mnemonicOrPrivateKey
                      : "0x" + mnemonicOrPrivateKey) as `0x${string}`,
              ),
        config.timeout,
        (config as any).testClientViem,
        config,
    );

    // if the provided key is mnemonic, generate new accounts
    if (isMnemonic) {
        const len = options.walletCount ?? 0;
        for (let addressIndex = 1; addressIndex <= len; addressIndex++) {
            accounts.push(
                await createViemClient(
                    config.chain.id as ChainId,
                    config.rpc,
                    config.publicRpc,
                    mnemonicToAccount(mnemonicOrPrivateKey, {
                        addressIndex,
                    }),
                    config.timeout,
                    (config as any).testClientViem,
                    config,
                ),
            );
        }
    }

    // reaed current eth balances of the accounts, this will be
    // tracked on through the bot's process whenever a tx is submitted
    const balances = await getBatchEthBalance(
        [mainAccount.account.address, ...accounts.map((v) => v.account.address)],
        config.viemClient as any as ViemClient,
    );
    mainAccount.BALANCE = balances[0];
    await setWatchedTokens(mainAccount, config.watchedTokens ?? []);

    // incase of excess accounts, top them up from main account
    if (accounts.length) {
        const topupAmountBn = ethers.utils.parseUnits(options.topupAmount!);
        let cumulativeTopupAmount = ethers.constants.Zero;
        for (let i = 1; i < balances.length; i++) {
            if (topupAmountBn.gt(balances[i])) {
                cumulativeTopupAmount = cumulativeTopupAmount.add(topupAmountBn.sub(balances[i]));
            }
        }
        if (cumulativeTopupAmount.gt(balances[0])) {
            throw "low on funds to topup excess wallets with specified initial topup amount";
        } else {
            for (let i = 0; i < accounts.length; i++) {
                await setWatchedTokens(accounts[i], config.watchedTokens ?? []);
                accounts[i].BALANCE = balances[i + 1];

                // only topup those accounts that have lower than expected funds
                const transferAmount = topupAmountBn.sub(balances[i + 1]);
                if (transferAmount.gt(0)) {
                    const span = tracer?.startSpan("fund-wallets", undefined, ctx);
                    span?.setAttribute("details.wallet", accounts[i].account.address);
                    span?.setAttribute("details.amount", ethers.utils.formatUnits(transferAmount));
                    try {
                        const hash = await mainAccount.sendTx({
                            to: accounts[i].account.address,
                            value: transferAmount.toBigInt(),
                        });
                        const receipt = await mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 4,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
                        if (receipt.status === "success") {
                            accounts[i].BALANCE = topupAmountBn;
                            mainAccount.BALANCE =
                                mainAccount.BALANCE.sub(transferAmount).sub(txCost);
                            span?.addEvent("Successfully topped up");
                        } else {
                            span?.addEvent("Failed to topup wallet: tx reverted");
                            mainAccount.BALANCE = mainAccount.BALANCE.sub(txCost);
                        }
                    } catch (error) {
                        span?.addEvent("Failed to topup wallet: " + errorSnapshot("", error));
                    }
                    span?.end();
                }
            }
        }
    }
    return { mainAccount, accounts };
}

/**
 * Manages accounts by removing the ones that are out of gas from circulation
 * and replaces them with new ones while topping them up with x11 of avg gas cost
 * of the arb() transactions, returns the last index used for new wallets.
 * @param config - The config obj
 * @param options - The config obj
 * @param avgGasCost - Avg gas cost of arb txs
 * @param lastIndex - The last index used for wallets
 * @param wgc - wallets garbage collection
 */
export async function manageAccounts(
    config: BotConfig,
    options: CliOptions,
    avgGasCost: BigNumber,
    lastIndex: number,
    wgc: ViemClient[],
    state: OperationState,
    tracer?: Tracer,
    ctx?: Context,
) {
    const removedWallets: ViemClient[] = [];
    let accountsToAdd = 0;
    for (let i = config.accounts.length - 1; i >= 0; i--) {
        if (config.accounts[i].BALANCE.lt(avgGasCost.mul(4))) {
            try {
                await sweepToMainWallet(
                    config.accounts[i],
                    config.mainAccount,
                    state,
                    config,
                    tracer,
                    ctx,
                );
            } catch {
                /**/
            }
            // keep in garbage if there are tokens left to sweep
            if (
                config.accounts[i].BOUNTY.length &&
                !wgc.find(
                    (v) =>
                        v.account.address.toLowerCase() ===
                        config.accounts[i].account.address.toLowerCase(),
                )
            ) {
                wgc.unshift(config.accounts[i]);
            }
            accountsToAdd++;
            removedWallets.push(...config.accounts.splice(i, 1));
        }
    }
    if (accountsToAdd > 0) {
        const rmSpan = tracer?.startSpan("remove-wallets", undefined, ctx);
        rmSpan?.setStatus({
            code: SpanStatusCode.OK,
            message: `Removed ${accountsToAdd} wallets from circulation`,
        });
        rmSpan?.setAttribute(
            "details.removedWallets",
            removedWallets.map((v) => v.account.address),
        );
        rmSpan?.end();

        let counter = 0;
        const size = accountsToAdd * 3; // equates to max of 3 retries if failed to add new wallets
        const topupAmountBN = ethers.utils.parseUnits(options.topupAmount!);
        while (accountsToAdd > 0) {
            // infinite loop controll
            if (counter > size) break;
            counter++;
            const span = tracer?.startSpan("add-new-wallet", undefined, ctx);
            try {
                const acc = await createViemClient(
                    config.chain.id as ChainId,
                    config.rpc,
                    config.publicRpc,
                    mnemonicToAccount(options.mnemonic!, {
                        addressIndex: ++lastIndex,
                    }),
                    config.timeout,
                    (config as any).testClientViem,
                    config,
                );
                span?.setAttribute("details.wallet", acc.account.address);
                const balance = ethers.BigNumber.from(
                    await acc.getBalance({ address: acc.account.address }),
                );
                acc.BALANCE = balance;
                await setWatchedTokens(acc, config.watchedTokens ?? []);

                if (topupAmountBN.gt(balance)) {
                    const transferAmount = topupAmountBN.sub(balance);
                    span?.setAttribute(
                        "details.topupAmount",
                        ethers.utils.formatUnits(transferAmount),
                    );
                    config.mainAccount.BALANCE = ethers.BigNumber.from(
                        await acc.getBalance({ address: config.mainAccount.account.address }),
                    );
                    if (config.mainAccount.BALANCE.lt(transferAmount)) {
                        const message = `main wallet ${config.mainAccount.account.address} lacks suffecient funds to topup new wallets, current balance: ${ethers.utils.formatUnits(
                            config.mainAccount.BALANCE,
                        )}, there are still ${config.accounts.length + 1} wallets in circulation to clear orders, please consider topping up the main wallet soon`;
                        span?.setAttribute(
                            "severity",
                            config.accounts.length ? ErrorSeverity.MEDIUM : ErrorSeverity.HIGH,
                        );
                        span?.setStatus({ code: SpanStatusCode.ERROR, message });
                        accountsToAdd--;
                        span?.end();
                        continue;
                    }
                    try {
                        const hash = await config.mainAccount.sendTx({
                            to: acc.account.address,
                            value: transferAmount.toBigInt(),
                        });
                        const receipt = await config.mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 4,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
                        if (receipt.status === "success") {
                            accountsToAdd--;
                            acc.BALANCE = topupAmountBN;
                            config.mainAccount.BALANCE =
                                config.mainAccount.BALANCE.sub(transferAmount).sub(txCost);
                            span?.setStatus({
                                code: SpanStatusCode.OK,
                                message: "Successfully added",
                            });
                            if (
                                !config.accounts.find(
                                    (v) =>
                                        v.account.address.toLowerCase() ===
                                        acc.account.address.toLowerCase(),
                                )
                            ) {
                                config.accounts.push(acc);
                            }
                        } else {
                            span?.setAttribute("severity", ErrorSeverity.LOW);
                            span?.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: `Failed to add and top up new wallet ${acc.account.address}: tx reverted`,
                            });
                            config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(txCost);
                        }
                    } catch (error) {
                        span?.setAttribute("severity", ErrorSeverity.LOW);
                        span?.setStatus({
                            code: SpanStatusCode.ERROR,
                            message:
                                `Failed to add and top up new wallet ${acc.account.address}: ` +
                                errorSnapshot("", error),
                        });
                    }
                } else {
                    accountsToAdd--;
                    span?.setStatus({
                        code: SpanStatusCode.OK,
                        message: "Successfully added",
                    });
                    if (
                        !config.accounts.find(
                            (v) =>
                                v.account.address.toLowerCase() ===
                                acc.account.address.toLowerCase(),
                        )
                    ) {
                        config.accounts.push(acc);
                    }
                }
            } catch (e) {
                span?.setAttribute("severity", ErrorSeverity.LOW);
                span?.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: "Failed to add and top up new wallet: " + errorSnapshot("", e),
                });
            }
            span?.end();
            await sleep(7500);
        }
    }
    return lastIndex;
}

/**
 * Rotates the providers rpcs for viem and ethers clients
 * @param config - The config object
 * @param resetDataFetcher
 */
export async function rotateProviders(config: BotConfig, resetDataFetcher = true) {
    if (config.rpc?.length > 1) {
        config.rpc.push(config.rpc.shift()!);
        const viemClient = await createViemClient(
            config.chain.id as ChainId,
            config.rpc,
            config.publicRpc,
            undefined,
            config.timeout,
            undefined,
            config,
        );

        if (resetDataFetcher) {
            config.dataFetcher = await getDataFetcher(
                viemClient as any as PublicClient,
                config.lps,
                config.publicRpc,
            );
        } else {
            config.dataFetcher.web3Client = viemClient as any as PublicClient;
        }
        config.viemClient = viemClient as any as PublicClient;

        // rotate main account's provider
        const mainAccBalance = config.mainAccount.BALANCE;
        const mainAccBounty = config.mainAccount.BOUNTY;
        const mainAcc = await createViemClient(
            config.chain.id as ChainId,
            config.rpc,
            config.publicRpc,
            config.mainAccount.account,
            config.timeout,
            undefined,
            config,
        );
        // config.mainAccount.connect(provider);
        mainAcc.BALANCE = mainAccBalance;
        mainAcc.BOUNTY = mainAccBounty;
        config.mainAccount = mainAcc;

        // rotate other accounts' provider
        for (let i = 0; i < config.accounts.length; i++) {
            const balance = config.accounts[i].BALANCE;
            const bounty = config.accounts[i].BOUNTY;
            const acc = await createViemClient(
                config.chain.id as ChainId,
                config.rpc,
                config.publicRpc,
                config.accounts[i].account,
                config.timeout,
                undefined,
                config,
            );
            acc.BALANCE = balance;
            acc.BOUNTY = bounty;
            config.accounts[i] = acc;
        }
    } else {
        if (resetDataFetcher) {
            config.dataFetcher = await getDataFetcher(
                config.viemClient,
                config.lps,
                config.publicRpc,
            );
        }
    }
}

/**
 * Rotates accounts by putting the first one in last place
 * @param accounts - Array of accounts to rotate
 */
export function rotateAccounts(accounts: ViemClient[]) {
    if (accounts && Array.isArray(accounts) && accounts.length > 1) {
        accounts.push(accounts.shift()!);
    }
}

/**
 * Get eth balance of multiple accounts using multicall
 * @param addresses - The addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchEthBalance(
    addresses: string[],
    viemClient: ViemClient,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: addresses.map((v) => ({
                address: (multicallAddressOverride ??
                    viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain.id,
                abi: MulticallAbi,
                functionName: "getEthBalance",
                args: [v],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Get balance of multiple erc20 tokens for an account using multicall3
 * @param address - The address to get its token balances
 * @param tokens - The token addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchTokenBalanceForAccount(
    address: string,
    tokens: TokenDetails[],
    viemClient: ViemClient,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: tokens.map((v) => ({
                address: v.address as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain.id,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Sweep bot's bounties
 * @param fromWallet - The from wallet
 * @param toWallet - The to wallet
 * @param gasPrice - Gas price
 */
export async function sweepToMainWallet(
    fromWallet: ViemClient,
    toWallet: ViemClient,
    state: OperationState,
    config: BotConfig,
    tracer?: Tracer,
    ctx?: Context,
) {
    const gasPrice = state.gasPrice;
    const mainSpan = tracer?.startSpan("sweep-wallet-funds", undefined, ctx);
    const mainCtx = mainSpan ? trace.setSpan(context.active(), mainSpan) : undefined;
    mainSpan?.setAttribute("details.wallet", fromWallet.account.address);
    mainSpan?.setAttribute(
        "details.tokens",
        fromWallet.BOUNTY.map((v) => v.symbol),
    );

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
    let cumulativeGas = ethers.constants.Zero;
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
                gasPrice,
                to: bounty.address as `0x${string}`,
                data: erc20.encodeFunctionData("transfer", [
                    toWallet.account.address,
                    balance,
                ]) as `0x${string}`,
            };
            // const gas = await fromWallet.estimateGas(tx);
            const gas = (await estimateGasCost(tx, fromWallet, config, state.l1GasPrice))
                .totalGasCost;
            txs.push({ tx, bounty, balance: ethers.utils.formatUnits(balance, bounty.decimals) });
            cumulativeGas = cumulativeGas.add(gas);
        } catch {
            addWatchedToken(bounty, failedBounties);
        }
    }

    if (cumulativeGas.mul(125).div(100).gt(fromWallet.BALANCE)) {
        const span = tracer?.startSpan("fund-wallet-to-sweep", undefined, mainCtx);
        span?.setAttribute("details.wallet", fromWallet.account.address);
        try {
            const transferAmount = cumulativeGas.mul(125).div(100).sub(fromWallet.BALANCE);
            span?.setAttribute("details.amount", ethers.utils.formatUnits(transferAmount));
            const hash = await toWallet.sendTx({
                to: fromWallet.account.address,
                value: transferAmount.toBigInt(),
            });
            const receipt = await toWallet.waitForTransactionReceipt({
                hash,
                confirmations: 4,
                timeout: 100_000,
            });
            const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
            if (receipt.status === "success") {
                span?.setStatus({
                    code: SpanStatusCode.OK,
                    message: "Successfully topped up",
                });
                fromWallet.BALANCE = fromWallet.BALANCE.add(transferAmount);
                toWallet.BALANCE = toWallet.BALANCE.sub(transferAmount).sub(txCost);
            } else {
                toWallet.BALANCE = toWallet.BALANCE.sub(txCost);
                span?.setAttribute("severity", ErrorSeverity.LOW);
                span?.setStatus({
                    code: SpanStatusCode.ERROR,
                    message:
                        "Failed topping up wallet for sweeping tokens back to main wallet: tx reverted",
                });
            }
        } catch (error) {
            span?.setAttribute("severity", ErrorSeverity.LOW);
            span?.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                    "Failed topping up wallet for sweeping tokens back to main wallet: " +
                    errorSnapshot("", error),
            });
        }
        span?.end();
    }

    for (let i = 0; i < txs.length; i++) {
        const span = tracer?.startSpan("sweep-token-to-main-wallet", undefined, mainCtx);
        span?.setAttribute("details.wallet", fromWallet.account.address);
        span?.setAttribute("details.token", txs[i].bounty.symbol);
        span?.setAttribute("details.tokenAddress", txs[i].bounty.address);
        span?.setAttribute("details.balance", txs[i].balance);
        try {
            const hash = await fromWallet.sendTx(txs[i].tx);
            const receipt = await fromWallet.waitForTransactionReceipt({
                hash,
                confirmations: 4,
                timeout: 100_000,
            });
            const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
            if (receipt.status === "success") {
                if (!toWallet.BOUNTY.find((v) => v.address === txs[i].bounty.address)) {
                    toWallet.BOUNTY.push(txs[i].bounty);
                }
                span?.setStatus({
                    code: SpanStatusCode.OK,
                    message: "Successfully swept back to main wallet",
                });
            } else {
                span?.setAttribute("severity", ErrorSeverity.LOW);
                span?.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: "Failed to sweep back to main wallet: tx reverted",
                });
                addWatchedToken(txs[i].bounty, failedBounties);
            }
            fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost);
        } catch (error) {
            span?.setAttribute("severity", ErrorSeverity.LOW);
            span?.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Failed to sweep back to main wallet: " + errorSnapshot("", error),
            });
            addWatchedToken(txs[i].bounty, failedBounties);
        }
        span?.end();
    }

    // empty gas if all tokens are swept
    if (!failedBounties.length) {
        const span = tracer?.startSpan("sweep-remaining-gas-to-main-wallet", undefined, mainCtx);
        span?.setAttribute("details.wallet", fromWallet.account.address);
        try {
            const estimation = await estimateGasCost(
                { to: toWallet.account.address, value: 0n, gasPrice } as any,
                fromWallet,
                config,
                state.l1GasPrice,
            );

            const remainingGas = ethers.BigNumber.from(
                await fromWallet.getBalance({ address: fromWallet.account.address }),
            );
            const transferAmount = remainingGas.sub(estimation.totalGasCost);
            if (transferAmount.gt(0)) {
                span?.setAttribute("details.amount", ethers.utils.formatUnits(transferAmount));
                const hash = await fromWallet.sendTx({
                    gasPrice,
                    to: toWallet.account.address,
                    value: transferAmount.toBigInt(),
                    gas: estimation.gas,
                });
                const receipt = await fromWallet.waitForTransactionReceipt({
                    hash,
                    confirmations: 4,
                    timeout: 100_000,
                });
                const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
                if (receipt.status === "success") {
                    toWallet.BALANCE = toWallet.BALANCE.add(transferAmount);
                    fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost).sub(transferAmount);
                    span?.setStatus({
                        code: SpanStatusCode.OK,
                        message: "Successfully swept gas tokens back to main wallet",
                    });
                } else {
                    fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost);
                    span?.setAttribute("severity", ErrorSeverity.LOW);
                    span?.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: "Failed to sweep gas tokens back to main wallet: tx reverted",
                    });
                }
            } else {
                span?.setStatus({
                    code: SpanStatusCode.OK,
                    message: "Transfer amount lower than gas cost",
                });
            }
        } catch (error) {
            span?.setAttribute("severity", ErrorSeverity.LOW);
            span?.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                    "Failed to sweep gas tokens back to main wallet: " + errorSnapshot("", error),
            });
        }
        span?.end();
    }
    fromWallet.BOUNTY = failedBounties;
    mainSpan?.end();
}

/**
 * Sweep bot's bounties to eth
 * @param config - The config obj
 */
export async function sweepToEth(
    config: BotConfig,
    state: OperationState,
    tracer?: Tracer,
    ctx?: Context,
) {
    const skipped: TokenDetails[] = [];
    const rp4Address = ROUTE_PROCESSOR_4_ADDRESS[
        config.chain.id as keyof typeof ROUTE_PROCESSOR_4_ADDRESS
    ] as `0x${string}`;
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const gasPrice = ethers.BigNumber.from(state.gasPrice);
    for (let i = 0; i < config.mainAccount.BOUNTY.length; i++) {
        const bounty = config.mainAccount.BOUNTY[i];
        const span = tracer?.startSpan("sweep-to-gas", undefined, ctx);
        span?.setAttribute("details.token", bounty.symbol);
        span?.setAttribute("details.tokenAddress", bounty.address);
        try {
            const balance = ethers.BigNumber.from(
                (
                    await config.viemClient.call({
                        to: bounty.address as `0x${string}`,
                        data: erc20.encodeFunctionData("balanceOf", [
                            config.mainAccount.account.address,
                        ]) as `0x${string}`,
                    })
                ).data,
            );
            span?.setAttribute(
                "details.balance",
                ethers.utils.formatUnits(balance, bounty.decimals),
            );
            if (balance.isZero()) {
                span?.end();
                continue;
            }
            const token = new Token({
                chainId: config.chain.id,
                decimals: bounty.decimals,
                address: bounty.address,
                symbol: bounty.symbol,
            });
            await config.dataFetcher.fetchPoolsForToken(
                token,
                WNATIVE[config.chain.id as keyof typeof WNATIVE],
                PoolBlackList,
            );
            const { rpParams, route } = await getRpSwap(
                config.chain.id,
                balance,
                token,
                Native.onChain(config.chain.id),
                config.mainAccount.account.address,
                rp4Address,
                config.dataFetcher,
                gasPrice,
                config.lps,
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
            span?.setAttribute("details.route", routeText);
            const allowance = (
                await config.viemClient.call({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("allowance", [
                        config.mainAccount.account.address,
                        rp4Address,
                    ]) as `0x${string}`,
                })
            ).data;
            if (allowance && balance.gt(allowance)) {
                span?.addEvent("Approving spend limit");
                const hash = await config.mainAccount.sendTx({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("approve", [
                        rp4Address,
                        balance.mul(100),
                    ]) as `0x${string}`,
                });
                await config.mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 4,
                    timeout: 100_000,
                });
            }
            const rawtx = { to: rp4Address, data: "0x" as `0x${string}` };
            let gas = 0n;
            let amountOutMin = ethers.constants.Zero;
            for (let j = 50; j > 39; j--) {
                amountOutMin = ethers.BigNumber.from(rpParams.amountOutMin)
                    .mul(2 * j)
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
                    gas = await config.mainAccount.estimateGas(rawtx);
                    break;
                } catch (error) {
                    if (j === 40) throw error;
                }
            }
            const gasCost = gasPrice.mul(gas).mul(15).div(10);
            span?.setAttribute("details.gasCost", ethers.utils.formatUnits(gasCost));
            if (gasCost.mul(25).gte(amountOutMin)) {
                span?.setStatus({
                    code: SpanStatusCode.OK,
                    message: "Skipped, balance not large enough to justify sweeping to gas token",
                });
                skipped.push(bounty);
                span?.end();
                continue;
            } else {
                const hash = await config.mainAccount.sendTx(rawtx);
                span?.setAttribute("txHash", hash);
                const receipt = await config.mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 4,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    span?.setStatus({
                        code: SpanStatusCode.OK,
                        message: "Successfully swept to gas token",
                    });
                } else {
                    skipped.push(bounty);
                    span?.setAttribute("severity", ErrorSeverity.LOW);
                    span?.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: `Failed to sweep ${bounty.symbol} to gas token: tx reverted`,
                    });
                }
            }
        } catch (e) {
            skipped.push(bounty);
            span?.setAttribute("severity", ErrorSeverity.LOW);
            span?.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                    `Failed to sweep ${bounty.symbol} to to gas token: ` + errorSnapshot("", e),
            });
        }
        span?.end();
        await sleep(10000);
    }
    config.mainAccount.BOUNTY = skipped;
    for (let i = 0; i < 20; i++) {
        try {
            config.mainAccount.BALANCE = ethers.BigNumber.from(
                await config.mainAccount.getBalance({
                    address: config.mainAccount.account.address,
                }),
            );
            return;
        } catch {
            if (i != 19) await sleep(10000 * (i + 1));
        }
    }
}

export function setWatchedTokens(account: ViemClient, watchedTokens: TokenDetails[]) {
    account.BOUNTY = [...watchedTokens];
}

/**
 * Funds the sepcified bot owned orders from the gas token
 * @param ownedOrders
 * @param config
 */
export async function fundOwnedOrders(
    ownedOrders: OwnedOrder[],
    config: BotConfig,
    state: OperationState,
): Promise<{ ownedOrder?: OwnedOrder; error: string }[]> {
    const failedFundings: { ownedOrder?: OwnedOrder; error: string }[] = [];
    const ob = new ethers.utils.Interface(orderbookAbi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const rp4Address =
        ROUTE_PROCESSOR_4_ADDRESS[config.chain.id as keyof typeof ROUTE_PROCESSOR_4_ADDRESS];
    const gasPrice = ethers.BigNumber.from(state.gasPrice);
    if (config.selfFundOrders) {
        for (let i = 0; i < ownedOrders.length; i++) {
            const ownedOrder = ownedOrders[i];
            const vaultId = ethers.BigNumber.from(ownedOrder.vaultId);
            const fundingOrder = config.selfFundOrders.find(
                (e) =>
                    e.token.toLowerCase() === ownedOrder.token.toLowerCase() &&
                    vaultId.eq(e.vaultId),
            );
            if (fundingOrder) {
                if (
                    ownedOrder.vaultBalance.lt(
                        ethers.utils.parseUnits(fundingOrder.threshold, ownedOrder.decimals),
                    )
                ) {
                    const topupAmount = ethers.utils.parseUnits(
                        fundingOrder.topupAmount,
                        ownedOrder.decimals,
                    );
                    try {
                        const balance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("balanceOf", [
                                    config.mainAccount.account.address,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (balance && topupAmount.gt(balance)) {
                            const token = new Token({
                                chainId: config.chain.id,
                                decimals: ownedOrder.decimals,
                                address: ownedOrder.token,
                                symbol: ownedOrder.symbol,
                            });
                            const { route } = await getRpSwap(
                                config.chain.id,
                                topupAmount,
                                token,
                                Native.onChain(config.chain.id),
                                config.mainAccount.account.address,
                                rp4Address,
                                config.dataFetcher,
                                gasPrice,
                            );
                            const initSellAmount = ethers.BigNumber.from(route.amountOutBI);
                            let sellAmount: BigNumber;
                            let finalRpParams: RPParams;
                            for (let j = 0; j < 25; j++) {
                                sellAmount = initSellAmount.mul(100 + j).div(100);
                                const { rpParams, route } = await getRpSwap(
                                    config.chain.id,
                                    sellAmount,
                                    Native.onChain(config.chain.id),
                                    token,
                                    config.mainAccount.account.address,
                                    rp4Address,
                                    config.dataFetcher,
                                    gasPrice,
                                );
                                if (topupAmount.lte(route.amountOutBI)) {
                                    finalRpParams = rpParams;
                                    break;
                                }
                            }
                            const data = rp.encodeFunctionData("processRoute", [
                                finalRpParams!.tokenIn,
                                finalRpParams!.amountIn,
                                finalRpParams!.tokenOut,
                                finalRpParams!.amountOutMin,
                                finalRpParams!.to,
                                finalRpParams!.routeCode,
                            ]) as `0x${string}`;
                            const swapHash = await config.mainAccount.sendTx({
                                to: rp4Address,
                                value: sellAmount!.toBigInt(),
                                data,
                            });
                            const swapReceipt = await config.mainAccount.waitForTransactionReceipt({
                                hash: swapHash,
                                confirmations: 4,
                                timeout: 100_000,
                            });
                            const swapTxCost = ethers.BigNumber.from(getTxFee(swapReceipt, config));
                            config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(swapTxCost);
                            if (swapReceipt.status === "success") {
                                config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(
                                    sellAmount!,
                                );
                            } else {
                                throw "failed to swap eth to vault token";
                            }
                        }

                        const allowance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("allowance", [
                                    config.mainAccount.account.address,
                                    ownedOrder.orderbook,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (allowance && topupAmount.gt(allowance)) {
                            const approveHash = await config.mainAccount.sendTx({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("approve", [
                                    ownedOrder.orderbook,
                                    topupAmount.mul(20),
                                ]) as `0x${string}`,
                            });
                            const approveReceipt =
                                await config.mainAccount.waitForTransactionReceipt({
                                    hash: approveHash,
                                    confirmations: 4,
                                    timeout: 100_000,
                                });
                            const approveTxCost = ethers.BigNumber.from(
                                getTxFee(approveReceipt, config),
                            );
                            config.mainAccount.BALANCE =
                                config.mainAccount.BALANCE.sub(approveTxCost);
                            if (approveReceipt.status === "reverted") {
                                throw "failed to approve token spend";
                            }
                        }

                        const hash = await config.mainAccount.sendTx({
                            to: ownedOrder.orderbook as `0x${string}`,
                            data: ob.encodeFunctionData("deposit2", [
                                ownedOrder.token,
                                vaultId,
                                topupAmount,
                                [],
                            ]) as `0x${string}`,
                        });
                        const receipt = await config.mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 4,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
                        config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(txCost);
                        if (receipt.status === "success") {
                            ownedOrder.vaultBalance = ownedOrder.vaultBalance.add(topupAmount);
                        }
                    } catch (error) {
                        failedFundings.push({
                            ownedOrder,
                            error: errorSnapshot("Failed to fund owned vault", error),
                        });
                    }
                }
            }
        }
    }
    return failedFundings;
}

/**
 * Quotes order details that are already fetched and bundled by bundleOrder()
 * @param config - Config obj
 * @param orderDetails - Order details to quote
 * @param multicallAddressOverride - Optional multicall address
 */
export async function checkOwnedOrders(
    config: BotConfig,
    orderDetails: BundledOrders[][],
    multicallAddressOverride?: string,
): Promise<OwnedOrder[]> {
    const ownedOrders: any[] = [];
    const result: OwnedOrder[] = [];
    orderDetails.flat().forEach((v) => {
        v.takeOrders.forEach((order) => {
            if (
                order.takeOrder.order.owner.toLowerCase() ===
                    config.mainAccount.account.address.toLowerCase() &&
                !ownedOrders.find(
                    (e) =>
                        e.orderbook.toLowerCase() === v.orderbook.toLowerCase() &&
                        e.outputToken.toLowerCase() === v.sellToken.toLowerCase() &&
                        e.order.takeOrder.order.validOutputs[
                            e.order.takeOrder.outputIOIndex
                        ].token.toLowerCase() ==
                            order.takeOrder.order.validOutputs[
                                order.takeOrder.outputIOIndex
                            ].token.toLowerCase() &&
                        ethers.BigNumber.from(
                            e.order.takeOrder.order.validOutputs[e.order.takeOrder.outputIOIndex]
                                .vaultId,
                        ).eq(
                            order.takeOrder.order.validOutputs[order.takeOrder.outputIOIndex]
                                .vaultId,
                        ),
                )
            ) {
                ownedOrders.push({
                    order,
                    orderbook: v.orderbook,
                    outputSymbol: v.sellTokenSymbol,
                    outputToken: v.sellToken,
                    outputDecimals: v.sellTokenDecimals,
                });
            }
        });
    });
    if (!ownedOrders.length) return result;
    try {
        const multicallResult = await config.viemClient.multicall({
            multicallAddress:
                (multicallAddressOverride as `0x${string}` | undefined) ??
                config.viemClient.chain?.contracts?.multicall3?.address,
            allowFailure: false,
            contracts: ownedOrders.map((v) => ({
                address: v.orderbook,
                allowFailure: false,
                chainId: config.chain.id,
                abi: VaultBalanceAbi,
                functionName: "vaultBalance",
                args: [
                    // owner
                    v.order.takeOrder.order.owner,
                    // token
                    v.order.takeOrder.order.validOutputs[v.order.takeOrder.outputIOIndex].token,
                    // valut id
                    v.order.takeOrder.order.validOutputs[v.order.takeOrder.outputIOIndex].vaultId,
                ],
            })),
        });
        for (let i = 0; i < multicallResult.length; i++) {
            let vaultId =
                ownedOrders[i].order.takeOrder.order.validOutputs[
                    ownedOrders[i].order.takeOrder.outputIOIndex
                ].vaultId;
            if (vaultId instanceof BigNumber) vaultId = vaultId.toHexString();
            result.push({
                vaultId,
                id: ownedOrders[i].order.id,
                token: ownedOrders[i].outputToken,
                symbol: ownedOrders[i].outputSymbol,
                decimals: ownedOrders[i].outputDecimals,
                orderbook: ownedOrders[i].orderbook,
                vaultBalance: ethers.BigNumber.from(multicallResult[i]),
            });
        }
    } catch (e) {
        /**/
    }
    return result;
}
