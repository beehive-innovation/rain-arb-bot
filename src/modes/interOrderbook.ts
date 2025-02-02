import { orderbookAbi } from "../abis";
import { estimateGasCost } from "../gas";
import { BaseError, PublicClient } from "viem";
import { BigNumber, Contract, ethers } from "ethers";
import { containsNodeError, errorSnapshot } from "../error";
import { getBountyEnsureRainlang, parseRainlang } from "../config";
import { BotConfig, BundledOrders, ViemClient, DryrunResult, SpanAttrs } from "../types";
import {
    ONE18,
    scale18To,
    estimateProfit,
    withBigintSerializer,
    // extendSpanAttributes,
} from "../utils";

/**
 * Executes a extimateGas call for an inter-orderbook arb() tx, to determine if the tx is successfull ot not
 */
export async function dryrun({
    orderPairObject,
    opposingOrders,
    signer,
    maximumInput: maximumInputFixed,
    gasPrice,
    arb,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    l1GasPrice,
}: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    signer: ViemClient;
    arb: Contract;
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    opposingOrders: BundledOrders;
    maximumInput: BigNumber;
    l1GasPrice?: bigint;
}): Promise<DryrunResult> {
    const spanAttributes: SpanAttrs = {};
    const result: DryrunResult = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };

    const maximumInput = scale18To(maximumInputFixed, orderPairObject.sellTokenDecimals);
    spanAttributes["maxInput"] = maximumInput.toString();

    const opposingMaxInput = orderPairObject.takeOrders[0].quote!.ratio.isZero()
        ? ethers.constants.MaxUint256
        : scale18To(
              maximumInputFixed.mul(orderPairObject.takeOrders[0].quote!.ratio).div(ONE18),
              orderPairObject.buyTokenDecimals,
          );

    const opposingMaxIORatio = orderPairObject.takeOrders[0].quote!.ratio.isZero()
        ? ethers.constants.MaxUint256
        : ethers.BigNumber.from(`1${"0".repeat(36)}`).div(
              orderPairObject.takeOrders[0].quote!.ratio,
          );

    // encode takeOrders2()
    const obInterface = new ethers.utils.Interface(orderbookAbi);
    const encodedFN = obInterface.encodeFunctionData("takeOrders2", [
        {
            minimumInput: ethers.constants.One,
            maximumInput: opposingMaxInput, // main maxout * main ratio
            maximumIORatio: opposingMaxIORatio, // inverse of main ratio (1 / ratio)
            orders: opposingOrders.takeOrders.map((v) => v.takeOrder), // opposing orders
            data: "0x",
        },
    ]);
    const takeOrdersConfigStruct = {
        minimumInput: ethers.constants.One,
        maximumInput: ethers.constants.MaxUint256,
        maximumIORatio: ethers.constants.MaxUint256,
        orders: [orderPairObject.takeOrders[0].takeOrder],
        data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "bytes"],
            [opposingOrders.orderbook, opposingOrders.orderbook, encodedFN],
        ),
    };

    const task = {
        evaluable: {
            interpreter: config.dispair.interpreter,
            store: config.dispair.store,
            bytecode:
                config.gasCoveragePercentage === "0"
                    ? "0x"
                    : await parseRainlang(
                          await getBountyEnsureRainlang(
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
    const rawtx: any = {
        data: arb.interface.encodeFunctionData("arb3", [
            orderPairObject.orderbook,
            takeOrdersConfigStruct,
            task,
        ]),
        to: arb.address,
        gasPrice,
    };

    // trying to find opp with doing gas estimation, once to get gas and calculate
    // minimum sender output and second time to check the arb() with headroom
    let gasLimit, blockNumber, l1Cost;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["blockNumber"] = blockNumber;
        const estimation = await estimateGasCost(rawtx, signer, config, l1GasPrice);
        l1Cost = estimation.l1Cost;
        gasLimit = ethers.BigNumber.from(estimation.gas).mul(config.gasLimitMultiplier).div(100);
    } catch (e) {
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
            await getBountyEnsureRainlang(
                ethers.utils.parseUnits(inputToEthPrice),
                ethers.utils.parseUnits(outputToEthPrice),
                gasCost.mul(headroom).div("100"),
                signer.account.address,
            ),
            config.viemClient,
            config.dispair,
        );
        rawtx.data = arb.interface.encodeFunctionData("arb3", [
            orderPairObject.orderbook,
            takeOrdersConfigStruct,
            task,
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
                await getBountyEnsureRainlang(
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    gasCost.mul(config.gasCoveragePercentage).div("100"),
                    signer.account.address,
                ),
                config.viemClient,
                config.dispair,
            );
            rawtx.data = arb.interface.encodeFunctionData("arb3", [
                orderPairObject.orderbook,
                takeOrdersConfigStruct,
                task,
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
        maximumInput,
        oppBlockNumber: blockNumber,
        estimatedProfit: estimateProfit(
            orderPairObject,
            ethers.utils.parseUnits(inputToEthPrice),
            ethers.utils.parseUnits(outputToEthPrice),
            opposingOrders,
            undefined,
            maximumInputFixed,
        )!,
    };
    return result;
}

/**
 * Tries to find an opp by doing a binary search for the maxInput of an inter-orderbook arb tx
 */
export async function findOpp({
    orderPairObject,
    signer,
    gasPrice,
    arb,
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
    arb: Contract;
    orderbooksOrders: BundledOrders[][];
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    l1GasPrice?: bigint;
}): Promise<DryrunResult> {
    if (!arb) throw undefined;
    const spanAttributes: SpanAttrs = {};
    const result: DryrunResult = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };
    const allNoneNodeErrors: (string | undefined)[] = [];

    const opposingOrderbookOrders = orderbooksOrders
        .map((v) => {
            if (v[0].orderbook !== orderPairObject.orderbook) {
                return v.find(
                    (e) =>
                        e.buyToken === orderPairObject.sellToken &&
                        e.sellToken === orderPairObject.buyToken &&
                        e.takeOrders.filter(
                            (c) =>
                                c.takeOrder.order.owner.toLowerCase() !==
                                orderPairObject.takeOrders[0].takeOrder.order.owner.toLowerCase(),
                        ).length > 0,
                );
            } else {
                return undefined;
            }
        })
        .filter((v) => v !== undefined) as BundledOrders[];

    if (!opposingOrderbookOrders || !opposingOrderbookOrders.length) throw undefined;
    const maximumInput = orderPairObject.takeOrders.reduce(
        (a, b) => a.add(b.quote!.maxOutput),
        ethers.constants.Zero,
    );
    try {
        // try full maxoutput for all available orderbooks before trying binary search
        return await Promise.any(
            opposingOrderbookOrders.map((v) => {
                // filter out the same owner orders
                const opposingOrders = {
                    ...v,
                    takeOrders: v.takeOrders
                        .filter(
                            (e) =>
                                e.takeOrder.order.owner.toLowerCase() !==
                                    orderPairObject.takeOrders[0].takeOrder.order.owner.toLowerCase() &&
                                e.quote &&
                                e.quote.maxOutput.gt(0),
                        )
                        .sort((a, b) =>
                            a.quote!.ratio.lt(b.quote!.ratio)
                                ? -1
                                : a.quote!.ratio.gt(b.quote!.ratio)
                                  ? 1
                                  : 0,
                        ),
                };
                if (!opposingOrders.takeOrders.length) throw "";
                return dryrun({
                    orderPairObject,
                    opposingOrders,
                    signer,
                    maximumInput,
                    gasPrice,
                    arb,
                    inputToEthPrice,
                    outputToEthPrice,
                    config,
                    viemClient,
                    l1GasPrice,
                });
            }),
        );
    } catch (e: any) {
        for (const err of (e as AggregateError).errors) {
            allNoneNodeErrors.push(err?.value?.noneNodeError);
        }
        // maximumInput = maximumInput.div(2);
        // try {
        //     // try to find the first resolving binary search
        //     return await Promise.any(
        //         opposingOrderbookOrders.map((v) => {
        //             // filter out the same owner orders
        //             const opposingOrders = {
        //                 ...v,
        //                 takeOrders: v.takeOrders.filter(
        //                     (e) =>
        //                         e.takeOrder.order.owner.toLowerCase() !==
        //                         orderPairObject.takeOrders[0].takeOrder.order.owner.toLowerCase(),
        //                 ),
        //             };
        //             return binarySearch({
        //                 orderPairObject,
        //                 opposingOrders,
        //                 signer,
        //                 maximumInput,
        //                 gasPrice,
        //                 arb,
        //                 inputToEthPrice,
        //                 outputToEthPrice,
        //                 config,
        //                 viemClient,
        //             });
        //         }),
        //     );
        // } catch {
        //     /**/
        // }
        const allOrderbooksAttributes: any = {};
        for (let i = 0; i < e.errors.length; i++) {
            allOrderbooksAttributes[opposingOrderbookOrders[i].orderbook] =
                e.errors[i].spanAttributes;
            // extendSpanAttributes(
            //     spanAttributes,
            //     e.errors[i].spanAttributes,
            //     "againstOrderbooks." + opposingOrderbookOrders[i].orderbook,
            // );
        }
        spanAttributes["againstOrderbooks"] = JSON.stringify(allOrderbooksAttributes);
        const noneNodeErrors = allNoneNodeErrors.filter((v) => !!v);
        if (allNoneNodeErrors.length && noneNodeErrors.length / allNoneNodeErrors.length > 0.5) {
            result.value = {
                noneNodeError: noneNodeErrors[0],
                estimatedProfit: ethers.constants.Zero,
            };
        }
        return Promise.reject(result);
    }
}

/**
 * Finds best maximumInput by doing a binary search
 */
export async function binarySearch({
    orderPairObject,
    opposingOrders,
    signer,
    maximumInput,
    gasPrice,
    arb,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    l1GasPrice,
}: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    signer: ViemClient;
    arb: ethers.Contract;
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    opposingOrders: BundledOrders;
    maximumInput: ethers.BigNumber;
    l1GasPrice?: bigint;
}): Promise<DryrunResult> {
    const spanAttributes = {};
    const result: DryrunResult = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };
    const allSuccessHops: DryrunResult[] = [];
    const initAmount = ethers.BigNumber.from(maximumInput.toString());
    for (let i = 1; i < config.hops; i++) {
        try {
            allSuccessHops.push(
                await dryrun({
                    orderPairObject,
                    opposingOrders,
                    signer,
                    maximumInput,
                    gasPrice,
                    arb,
                    inputToEthPrice,
                    outputToEthPrice,
                    config,
                    viemClient,
                    l1GasPrice,
                }),
            );
            // set the maxInput for next hop by increasing
            maximumInput = maximumInput.add(initAmount.div(2 ** i));
        } catch (e) {
            // set the maxInput for next hop by decreasing
            maximumInput = maximumInput.sub(initAmount.div(2 ** i));
        }
    }
    if (allSuccessHops.length) {
        return allSuccessHops[allSuccessHops.length - 1];
    } else {
        return Promise.reject(result);
    }
}
