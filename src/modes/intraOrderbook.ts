import { orderbookAbi } from "../abis";
import { estimateGasCost } from "../gas";
import { BigNumber, ethers } from "ethers";
import { BaseError, erc20Abi, PublicClient } from "viem";
import { containsNodeError, errorSnapshot } from "../error";
import { getWithdrawEnsureRainlang, parseRainlang } from "../config";
import { estimateProfit, scale18, withBigintSerializer } from "../utils";
import {
    SpanAttrs,
    BotConfig,
    ViemClient,
    DryrunResult,
    BundledOrders,
    TakeOrderDetails,
} from "../types";

/**
 * Executes a extimateGas call for an intra-orderbook tx (clear2()), to determine if the tx is successfull ot not
 */
export async function dryrun({
    orderPairObject,
    opposingOrder,
    signer,
    gasPrice,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    inputBalance,
    outputBalance,
    l1GasPrice,
}: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    signer: ViemClient;
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    inputBalance: BigNumber;
    outputBalance: BigNumber;
    opposingOrder: TakeOrderDetails;
    l1GasPrice?: bigint;
}): Promise<DryrunResult> {
    const spanAttributes: SpanAttrs = {};
    const result: DryrunResult = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };

    const inputBountyVaultId = "1";
    const outputBountyVaultId = "1";
    const obInterface = new ethers.utils.Interface(orderbookAbi);
    const task = {
        evaluable: {
            interpreter: config.dispair.interpreter,
            store: config.dispair.store,
            bytecode: await parseRainlang(
                await getWithdrawEnsureRainlang(
                    signer.account.address,
                    orderPairObject.buyToken,
                    orderPairObject.sellToken,
                    inputBalance,
                    outputBalance,
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    ethers.constants.Zero,
                    signer.account.address,
                ),
                config.viemClient,
                config.dispair,
            ),
        },
        signedContext: [],
    };
    const withdrawInputCalldata = obInterface.encodeFunctionData("withdraw2", [
        orderPairObject.buyToken,
        inputBountyVaultId,
        ethers.constants.MaxUint256,
        [],
    ]);
    let withdrawOutputCalldata = obInterface.encodeFunctionData("withdraw2", [
        orderPairObject.sellToken,
        outputBountyVaultId,
        ethers.constants.MaxUint256,
        config.gasCoveragePercentage === "0" ? [] : [task],
    ]);
    const clear2Calldata = obInterface.encodeFunctionData("clear2", [
        orderPairObject.takeOrders[0].takeOrder.order,
        opposingOrder.takeOrder.order,
        {
            aliceInputIOIndex: orderPairObject.takeOrders[0].takeOrder.inputIOIndex,
            aliceOutputIOIndex: orderPairObject.takeOrders[0].takeOrder.outputIOIndex,
            bobInputIOIndex: opposingOrder.takeOrder.inputIOIndex,
            bobOutputIOIndex: opposingOrder.takeOrder.outputIOIndex,
            aliceBountyVaultId: inputBountyVaultId,
            bobBountyVaultId: outputBountyVaultId,
        },
        [],
        [],
    ]);
    const rawtx: any = {
        data: obInterface.encodeFunctionData("multicall", [
            [clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata],
        ]),
        to: orderPairObject.orderbook,
        gasPrice,
    };

    // trying to find opp with doing gas estimation, once to get gas and calculate
    // minimum sender output and second time to check the clear2() with withdraw2() and headroom
    let gasLimit, blockNumber, l1Cost;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["blockNumber"] = blockNumber;
        const estimation = await estimateGasCost(rawtx, signer, config, l1GasPrice);
        l1Cost = estimation.l1Cost;
        gasLimit = ethers.BigNumber.from(estimation.gas).mul(config.gasLimitMultiplier).div(100);
    } catch (e) {
        // reason, code, method, transaction, error, stack, message
        const isNodeError = containsNodeError(e as BaseError);
        const errMsg = errorSnapshot("", e);
        spanAttributes["stage"] = 1;
        spanAttributes["isNodeError"] = isNodeError;
        spanAttributes["error"] = errMsg;
        spanAttributes["rawtx"] = JSON.stringify(
            {
                ...rawtx,
                from: signer.account.address,
            },
            withBigintSerializer,
        );
        if (!isNodeError) {
            result.value = {
                noneNodeError: errMsg,
                estimatedProfit: ethers.constants.Zero,
            };
        }
        return Promise.reject(result);
    }
    let gasCost = gasLimit.mul(gasPrice).add(l1Cost);

    // repeat the same process with heaedroom if gas
    // coverage is not 0, 0 gas coverage means 0 minimum
    // sender output which is already called above
    if (config.gasCoveragePercentage !== "0") {
        const headroom = (Number(config.gasCoveragePercentage) * 1.03).toFixed();
        task.evaluable.bytecode = await parseRainlang(
            await getWithdrawEnsureRainlang(
                signer.account.address,
                orderPairObject.buyToken,
                orderPairObject.sellToken,
                inputBalance,
                outputBalance,
                ethers.utils.parseUnits(inputToEthPrice),
                ethers.utils.parseUnits(outputToEthPrice),
                gasCost.mul(headroom).div("100"),
                signer.account.address,
            ),
            config.viemClient,
            config.dispair,
        );
        withdrawOutputCalldata = obInterface.encodeFunctionData("withdraw2", [
            orderPairObject.sellToken,
            outputBountyVaultId,
            ethers.constants.MaxUint256,
            [task],
        ]);
        rawtx.data = obInterface.encodeFunctionData("multicall", [
            [clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata],
        ]);

        try {
            spanAttributes["blockNumber"] = blockNumber;
            const estimation = await estimateGasCost(rawtx, signer, config, l1GasPrice);
            gasLimit = ethers.BigNumber.from(estimation.gas)
                .mul(config.gasLimitMultiplier)
                .div(100);
            rawtx.gas = gasLimit.toBigInt();
            gasCost = gasLimit.mul(gasPrice).add(estimation.l1Cost);
            task.evaluable.bytecode = await parseRainlang(
                await getWithdrawEnsureRainlang(
                    signer.account.address,
                    orderPairObject.buyToken,
                    orderPairObject.sellToken,
                    inputBalance,
                    outputBalance,
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    gasCost.mul(config.gasCoveragePercentage).div("100"),
                    signer.account.address,
                ),
                config.viemClient,
                config.dispair,
            );
            withdrawOutputCalldata = obInterface.encodeFunctionData("withdraw2", [
                orderPairObject.sellToken,
                outputBountyVaultId,
                ethers.constants.MaxUint256,
                [task],
            ]);
            rawtx.data = obInterface.encodeFunctionData("multicall", [
                [clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata],
            ]);
        } catch (e) {
            const isNodeError = containsNodeError(e as BaseError);
            const errMsg = errorSnapshot("", e);
            spanAttributes["stage"] = 2;
            spanAttributes["isNodeError"] = isNodeError;
            spanAttributes["error"] = errMsg;
            spanAttributes["rawtx"] = JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            if (!isNodeError) {
                result.value = {
                    noneNodeError: errMsg,
                    estimatedProfit: ethers.constants.Zero,
                };
            }
            return Promise.reject(result);
        }
    }
    rawtx.gas = gasLimit.toBigInt();

    // if reached here, it means there was a success and found opp
    spanAttributes["oppBlockNumber"] = blockNumber;
    spanAttributes["foundOpp"] = true;
    delete spanAttributes["blockNumber"];
    result.value = {
        rawtx,
        oppBlockNumber: blockNumber,
        estimatedProfit: estimateProfit(
            orderPairObject,
            ethers.utils.parseUnits(inputToEthPrice),
            ethers.utils.parseUnits(outputToEthPrice),
            opposingOrder,
        )!,
    };
    return result;
}

/**
 * Tries to find an opp from the same orderbook's opposing orders
 */
export async function findOpp({
    orderPairObject,
    signer,
    gasPrice,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    orderbooksOrders,
    l1GasPrice,
}: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    signer: ViemClient;
    orderbooksOrders: BundledOrders[][];
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    l1GasPrice?: bigint;
}): Promise<DryrunResult> {
    const spanAttributes: SpanAttrs = {};
    const result: DryrunResult = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };

    const ONE = ethers.utils.parseUnits("1");
    const opposingOrders = orderbooksOrders
        .map((v) => {
            if (v[0].orderbook === orderPairObject.orderbook) {
                return v.find(
                    (e) =>
                        e.buyToken === orderPairObject.sellToken &&
                        e.sellToken === orderPairObject.buyToken,
                );
            } else {
                return undefined;
            }
        })
        .find((v) => v !== undefined)
        ?.takeOrders.filter(
            (v) =>
                // not same order
                v.id !== orderPairObject.takeOrders[0].id &&
                // not same owner
                v.takeOrder.order.owner.toLowerCase() !==
                    orderPairObject.takeOrders[0].takeOrder.order.owner.toLowerCase() &&
                // only orders that (priceA x priceB < 1) can be profitbale
                v.quote!.ratio.mul(orderPairObject.takeOrders[0].quote!.ratio).div(ONE).lt(ONE),
        )
        .sort((a, b) =>
            a.quote!.ratio.lt(b.quote!.ratio) ? -1 : a.quote!.ratio.gt(b.quote!.ratio) ? 1 : 0,
        );
    if (!opposingOrders || !opposingOrders.length) throw undefined;

    const allErrorAttributes: string[] = [];
    const allNoneNodeErrors: (string | undefined)[] = [];
    const inputBalance = scale18(
        await viemClient.readContract({
            address: orderPairObject.buyToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        }),
        orderPairObject.buyTokenDecimals,
    );
    const outputBalance = scale18(
        await viemClient.readContract({
            address: orderPairObject.sellToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        }),
        orderPairObject.sellTokenDecimals,
    );
    for (let i = 0; i < opposingOrders.length; i++) {
        try {
            return await dryrun({
                orderPairObject,
                opposingOrder: opposingOrders[i],
                signer,
                gasPrice,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                inputBalance,
                outputBalance,
                l1GasPrice,
            });
        } catch (e: any) {
            allNoneNodeErrors.push(e?.value?.noneNodeError);
            allErrorAttributes.push(JSON.stringify(e.spanAttributes));
            // extendSpanAttributes(spanAttributes, e.spanAttributes, "intraOrderbook." + i);
        }
    }
    spanAttributes["intraOrderbook"] = allErrorAttributes;
    const noneNodeErrors = allNoneNodeErrors.filter((v) => !!v);
    if (allNoneNodeErrors.length && noneNodeErrors.length / allNoneNodeErrors.length > 0.5) {
        result.value = {
            noneNodeError: noneNodeErrors[0],
            estimatedProfit: ethers.constants.Zero,
        };
    }
    return Promise.reject(result);
}
