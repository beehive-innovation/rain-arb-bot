import { ChainId } from "sushi";
import { BigNumber } from "ethers";
import { getQuoteConfig } from "./utils";
import { publicActionsL2 } from "viem/op-stack";
import { encodeFunctionData, multicall3Abi } from "viem";
import { BotConfig, BundledOrders, OperationState, RawTx, ViemClient } from "./types";
import { ArbitrumNodeInterfaceAbi, ArbitrumNodeInterfaceAddress, OrderbookQuoteAbi } from "./abis";

// default gas price for bsc chain, 1 gwei
export const BSC_DEFAULT_GAS_PRICE = 1_000_000_000n as const;

/**
 * Estimates gas cost of the given tx, also takes into account L1 gas cost if the chain is a special L2.
 */
export async function estimateGasCost(
    tx: RawTx,
    signer: ViemClient,
    config: BotConfig,
    l1GasPrice?: bigint,
    l1Signer?: any,
) {
    const gasPrice =
        tx.gasPrice ?? ((await signer.getGasPrice()) * BigInt(config.gasPriceMultiplier)) / 100n;
    const gas = await signer.estimateGas(tx);
    const result = {
        gas,
        gasPrice,
        l1GasPrice: 0n,
        l1Cost: 0n,
        totalGasCost: gasPrice * gas,
    };
    if (config.isSpecialL2) {
        try {
            const l1Signer_ = l1Signer ? l1Signer : signer.extend(publicActionsL2());
            if (typeof l1GasPrice !== "bigint") {
                l1GasPrice = (await l1Signer_.getL1BaseFee()) as bigint;
            }
            const l1Cost = await l1Signer_.estimateL1Fee({
                to: tx.to,
                data: tx.data,
            });
            result.l1GasPrice = l1GasPrice;
            result.l1Cost = l1Cost;
            result.totalGasCost += l1Cost;
        } catch {}
    }
    return result;
}

/**
 * Retruns the L1 gas cost of a transaction if operating chain is special L2 else returns 0.
 */
export function getL1Fee(receipt: any, config: BotConfig): bigint {
    if (!config.isSpecialL2) return 0n;

    if (typeof receipt.l1Fee === "bigint") {
        return receipt.l1Fee;
    } else if (typeof receipt.l1GasPrice === "bigint" && typeof receipt.l1GasUsed === "bigint") {
        return (receipt.l1GasPrice as bigint) * (receipt.l1GasUsed as bigint);
    } else {
        return 0n;
    }
}

/**
 * Get Transaction total gas cost from receipt (includes L1 fee)
 */
export function getTxFee(receipt: any, config: BotConfig): bigint {
    const gasUsed = BigNumber.from(receipt.gasUsed).toBigInt();
    const effectiveGasPrice = BigNumber.from(receipt.effectiveGasPrice).toBigInt();
    return effectiveGasPrice * gasUsed + getL1Fee(receipt, config);
}

/**
 * Fetches the gas price (L1 gas price as well if chain is special L2)
 */
export async function getGasPrice(config: BotConfig, state: OperationState) {
    const promises = [config.viemClient.getGasPrice()];
    if (config.isSpecialL2) {
        const l1Client = config.viemClient.extend(publicActionsL2());
        promises.push(l1Client.getL1BaseFee());
    }
    const [gasPriceResult, l1GasPriceResult = undefined] = await Promise.allSettled(promises);
    if (gasPriceResult.status === "fulfilled") {
        let gasPrice = gasPriceResult.value;
        if (config.chain.id === ChainId.BSC && gasPrice < BSC_DEFAULT_GAS_PRICE) {
            gasPrice = BSC_DEFAULT_GAS_PRICE;
        }
        state.gasPrice = (gasPrice * BigInt(config.gasPriceMultiplier)) / 100n;
    }
    if (l1GasPriceResult?.status === "fulfilled") {
        state.l1GasPrice = l1GasPriceResult.value;
    }
}

/**
 * Calculates the gas limit that used for quoting orders
 */
export async function getQuoteGas(
    config: BotConfig,
    orderDetails: BundledOrders,
    multicallAddressOverride?: string,
): Promise<bigint> {
    if (config.chain.id === ChainId.ARBITRUM) {
        // build the calldata of a quote call
        const quoteConfig = getQuoteConfig(orderDetails.takeOrders[0]);
        const multicallConfig = {
            target: orderDetails.orderbook as `0x${string}`,
            allowFailure: true,
            callData: encodeFunctionData({
                abi: OrderbookQuoteAbi,
                functionName: "quote",
                args: [quoteConfig],
            }),
        };
        const calldata = encodeFunctionData({
            abi: multicall3Abi,
            functionName: "aggregate3",
            args: [[multicallConfig] as const],
        });

        const multicallAddress =
            (multicallAddressOverride as `0x${string}` | undefined) ??
            config.viemClient.chain?.contracts?.multicall3?.address;
        if (!multicallAddress) throw "unknown multicall address";

        // call Arbitrum Node Interface for the calldata to get L1 gas
        const result = await config.viemClient.simulateContract({
            abi: ArbitrumNodeInterfaceAbi,
            address: ArbitrumNodeInterfaceAddress,
            functionName: "gasEstimateL1Component",
            args: [multicallAddress, false, calldata],
        });
        return config.quoteGas + result.result[0];
    } else {
        return config.quoteGas;
    }
}
