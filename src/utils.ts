import { ChainId } from "sushi/chain";
import { AfterClearAbi } from "./abis";
import { RouteLeg } from "sushi/tines";
import { Token, Type } from "sushi/currency";
import BlackList from "./pool-blacklist.json";
import { isBytes, isHexString } from "ethers/lib/utils";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { erc20Abi, parseEventLogs, TransactionReceipt } from "viem";
import { BotConfig, TakeOrderDetails, TokenDetails, ViemClient } from "./types";
import { DataFetcher, DataFetcherOptions, LiquidityProviders, Router } from "sushi/router";

/**
 * One ether which equals to 1e18
 */
export const ONE18 = 1_000_000_000_000_000_000n as const;

export const PoolBlackList = new Set(BlackList);
export function RPoolFilter(pool: any) {
    return !BlackList.includes(pool.address) && !BlackList.includes(pool.address.toLowerCase());
}

/**
 * Waits for provided miliseconds
 * @param ms - Miliseconds to wait
 */
export async function sleep(ms: number, msg = "") {
    let _timeoutReference: string | number | NodeJS.Timeout | undefined;
    return new Promise(
        (resolve) => (_timeoutReference = setTimeout(() => resolve(msg), ms)),
    ).finally(() => clearTimeout(_timeoutReference));
}

/**
 * Extracts the income (received token value) from transaction receipt
 * @param signerAddress - The signer address
 * @param receipt - The transaction receipt
 * @param token - The token address that was transfered
 * @returns The income value or undefined if cannot find any valid value
 */
export function getIncome(
    signerAddress: string,
    receipt: TransactionReceipt,
    token: string,
): BigNumber | undefined {
    try {
        const logs = parseEventLogs({
            abi: erc20Abi,
            eventName: "Transfer",
            logs: receipt.logs,
        });
        for (const log of logs) {
            if (
                log.eventName === "Transfer" &&
                (log.address && token ? BigNumber.from(log.address).eq(token) : true) &&
                BigNumber.from(log.args.to).eq(signerAddress)
            ) {
                return BigNumber.from(log.args.value);
            }
        }
    } catch {}
    return undefined;
}

/**
 * Extracts the actual clear amount (received token value) from transaction receipt
 * @param toAddress - The to address
 * @param obAddress - The orderbook address
 * @param receipt - The transaction receipt
 * @returns The actual clear amount
 */
export function getActualClearAmount(
    toAddress: string,
    obAddress: string,
    receipt: TransactionReceipt,
): BigNumber | undefined {
    if (toAddress.toLowerCase() !== obAddress.toLowerCase()) {
        try {
            const logs = parseEventLogs({
                abi: erc20Abi,
                eventName: "Transfer",
                logs: receipt.logs,
            });
            for (const log of logs) {
                if (
                    log.eventName === "Transfer" &&
                    BigNumber.from(log.args.to).eq(toAddress) &&
                    BigNumber.from(log.args.from).eq(obAddress)
                ) {
                    return BigNumber.from(log.args.value);
                }
            }
        } catch {}
        return undefined;
    } else {
        try {
            const logs = parseEventLogs({
                abi: AfterClearAbi,
                eventName: "AfterClear",
                logs: receipt.logs,
            });
            for (const log of logs) {
                if (log.eventName === "AfterClear") {
                    return BigNumber.from(log.args.clearStateChange.aliceOutput);
                }
            }
        } catch {}
        return undefined;
    }
}

/**
 * Calculates the actual clear price from transactioin event
 * @param receipt - The transaction receipt
 * @param orderbook - The Orderbook contract address
 * @param arb - The Arb contract address
 * @param clearAmount - The clear amount
 * @param tokenDecimals - The buy token decimals
 * @returns The actual clear price or undefined if necessary info not found in transaction events
 */
export function getActualPrice(
    receipt: TransactionReceipt,
    orderbook: string,
    arb: string,
    clearAmount: string,
    tokenDecimals: number,
): string | undefined {
    try {
        const logs = parseEventLogs({
            abi: erc20Abi,
            eventName: "Transfer",
            logs: receipt.logs,
        });
        for (const log of logs) {
            if (
                log.eventName === "Transfer" &&
                BigNumber.from(log.args.to).eq(arb) &&
                !BigNumber.from(log.args.from).eq(orderbook)
            ) {
                return ethers.utils.formatUnits(
                    scale18(log.args.value, tokenDecimals).mul(ONE18).div(clearAmount),
                );
            }
        }
    } catch {}
    return undefined;
}

/**
 * Gets token price against ETH
 * @param config - The network config data
 * @param targetTokenAddress - The token address
 * @param targetTokenDecimals - The token decimals
 * @param gasPrice - The network gas price
 * @param dataFetcher - (optional) The DataFetcher instance
 * @param options - (optional) The DataFetcher options
 */
export async function getEthPrice(
    config: any,
    targetTokenAddress: string,
    targetTokenDecimals: number,
    gasPrice: BigNumber,
    dataFetcher: DataFetcher,
    options?: DataFetcherOptions,
    fetchPools = true,
): Promise<string | undefined> {
    if (targetTokenAddress.toLowerCase() == config.nativeWrappedToken.address.toLowerCase()) {
        return "1";
    }
    const amountIn = BigNumber.from("1" + "0".repeat(targetTokenDecimals));
    const toToken = new Token({
        chainId: config.chain.id,
        decimals: config.nativeWrappedToken.decimals,
        address: config.nativeWrappedToken.address,
        symbol: config.nativeWrappedToken.symbol,
    });
    const fromToken = new Token({
        chainId: config.chain.id,
        decimals: targetTokenDecimals,
        address: targetTokenAddress,
    });
    if (fetchPools)
        await dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, options);
    const pcMap = dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        config.chain.id,
        fromToken,
        amountIn.toBigInt(),
        toToken,
        gasPrice.toNumber(),
        undefined,
        RPoolFilter,
        // 30e9,
        // providers,
        // poolFilter
    );
    if (route.status == "NoWay") {
        if (!fetchPools)
            return await getEthPrice(
                config,
                targetTokenAddress,
                targetTokenDecimals,
                gasPrice,
                dataFetcher,
                options,
                true,
            );
        else return undefined;
    } else return ethers.utils.formatUnits(route.amountOutBI);
}

/**
 * Method to shorten data fields of items that are logged and optionally hide sensitive data
 * @param scrub - Option to scrub sensitive data
 * @param data - The optinnal data to hide
 */
export function appGlobalLogger(scrub: boolean, ...data: any[]) {
    // const largeDataPattern = /0x[a-fA-F0-9]{128,}/g;
    const consoleMethods = ["log", "warn", "error", "info", "debug"];

    // Stringifies an object
    const objStringify = (obj: any) => {
        const keys = Object.getOwnPropertyNames(obj);
        for (let i = 0; i < keys.length; i++) {
            if (
                typeof obj[keys[i]] === "bigint" ||
                typeof obj[keys[i]] === "number" ||
                typeof obj[keys[i]] === "symbol"
            )
                obj[keys[i]] = obj[keys[i]].toString();
            else if (typeof obj[keys[i]] === "object" && obj[keys[i]] !== null) {
                obj[keys[i]] = objStringify(obj[keys[i]]);
            }
        }
        return obj;
    };

    // Replaces a search value with replace value in an object's properties string content
    const objStrReplacer = (logObj: any, searchee: any, replacer: any) => {
        const objKeys = Object.getOwnPropertyNames(logObj);
        for (let i = 0; i < objKeys.length; i++) {
            if (typeof logObj[objKeys[i]] === "string" && logObj[objKeys[i]]) {
                if (typeof searchee === "string") {
                    // while (logObj[objKeys[i]].includes(searchee)) {
                    logObj[objKeys[i]] = logObj[objKeys[i]].replaceAll(searchee, replacer);
                    // }
                } else logObj[objKeys[i]] = logObj[objKeys[i]].replace(searchee, replacer);
            } else if (typeof logObj[objKeys[i]] === "object" && logObj[objKeys[i]] !== null) {
                logObj[objKeys[i]] = objStrReplacer(logObj[objKeys[i]], searchee, replacer);
            }
        }
        return logObj;
    };

    // filtering unscrubable data
    const _data = data
        .filter((v) => v !== undefined && v !== null)
        .map((v) => {
            try {
                let str;
                if (typeof v !== "string") str = v.toString();
                else str = v;
                if (str) return str;
                else return undefined;
            } catch {
                return undefined;
            }
        })
        .filter((v) => v !== undefined);

    // intercepting the console with custom function to scrub and shorten loggings
    consoleMethods.forEach((methodName) => {
        // eslint-disable-next-line no-console
        const orgConsole = (console as any)[methodName];
        // eslint-disable-next-line no-console
        (console as any)[methodName] = function (...params: any[]) {
            const modifiedParams: any[] = [];
            // const shortenedLogs = [];
            for (let i = 0; i < params.length; i++) {
                let logItem = params[i];
                if (
                    typeof logItem === "number" ||
                    typeof logItem === "bigint" ||
                    typeof logItem === "symbol"
                )
                    logItem = logItem.toString();

                if (typeof logItem === "string") {
                    if (scrub)
                        for (let j = 0; j < _data.length; j++) {
                            // while (logItem.includes(_data[i]))
                            logItem = logItem.replaceAll(_data[j], "**********");
                        }
                    // logItem = logItem.replace(
                    //     largeDataPattern,
                    //     largeData => {
                    //         if (!shortenedLogs.includes(largeData)) {
                    //             shortenedLogs.push(largeData);
                    //             return largeData;
                    //         }
                    //         else return largeData.slice(0, 67) + "...";
                    //     }
                    // );
                } else if (typeof logItem === "object" && logItem !== null) {
                    logItem = objStringify(logItem);
                    if (scrub)
                        for (let j = 0; j < _data.length; j++) {
                            logItem = objStrReplacer(logItem, _data[j], "**********");
                        }
                    // logItem = objStrReplacer(
                    //     logItem,
                    //     largeDataPattern,
                    //     largeData => {
                    //         if (!shortenedLogs.includes(largeData)) {
                    //             shortenedLogs.push(largeData);
                    //             return largeData;
                    //         }
                    //         else return largeData.slice(0, 67) + "...";
                    //     }
                    // );
                }
                modifiedParams.push(logItem);
            }
            orgConsole.apply(console, modifiedParams);
        };
    });
}

/**
 * Method to put a timeout on a promise, throws the exception if promise is not settled within the time
 * @param promise - The Promise to put timeout on
 * @param time - The time in milliseconds
 * @param exception - The exception value to reject with if the promise is not settled within time
 * @returns A new promise that gets settled with initial promise settlement or rejected with exception value
 * if the time runs out before the main promise settlement
 */
export async function promiseTimeout(
    promise: Promise<any>,
    time: number,
    exception: string | number | bigint | symbol | boolean,
) {
    let timer: string | number | NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise((_res, _rej) => (timer = setTimeout(_rej, time, exception))),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Method to visualize the routes, returns array of route strings sorted from highest to lowest percentage
 * @param fromToken - The from token address
 * @param toToken - The to token address
 * @param legs - The legs of the route
 */
export function visualizeRoute(fromToken: Token, toToken: Token, legs: RouteLeg[]): string[] {
    return [
        // direct
        ...legs
            .filter(
                (v) =>
                    v.tokenTo.address.toLowerCase() === toToken.address.toLowerCase() &&
                    v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase(),
            )
            .map((v) => [v]),

        // indirect
        ...legs
            .filter(
                (v) =>
                    v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase() &&
                    v.tokenTo.address.toLowerCase() !== toToken.address.toLowerCase(),
            )
            .map((v) => {
                const portions: RouteLeg[] = [v];
                while (
                    portions.at(-1)?.tokenTo.address.toLowerCase() !== toToken.address.toLowerCase()
                ) {
                    const legPortion = legs.find(
                        (e) =>
                            e.tokenFrom.address.toLowerCase() ===
                                portions.at(-1)?.tokenTo.address.toLowerCase() &&
                            portions.every(
                                (k) => k.poolAddress.toLowerCase() !== e.poolAddress.toLowerCase(),
                            ),
                    );
                    if (legPortion) {
                        portions.push(legPortion);
                    } else {
                        break;
                    }
                }
                return portions;
            }),
    ]
        .sort((a, b) => b[0].absolutePortion - a[0].absolutePortion)
        .map(
            (v) =>
                (v[0].absolutePortion * 100).toFixed(2).padStart(5, "0") +
                "%   --->   " +
                v
                    .map(
                        (e) =>
                            (e.tokenTo.symbol ??
                                (e.tokenTo.address.toLowerCase() === toToken.address.toLowerCase()
                                    ? toToken.symbol
                                    : "unknownSymbol")) +
                            "/" +
                            (e.tokenFrom.symbol ??
                                (e.tokenFrom.address.toLowerCase() ===
                                fromToken.address.toLowerCase()
                                    ? fromToken.symbol
                                    : "unknownSymbol")) +
                            " (" +
                            (e as any).poolName +
                            " " +
                            e.poolAddress +
                            ")",
                    )
                    .join(" >> "),
        );
}

/**
 * Shuffles an array
 * @param array - The array
 */
export function shuffleArray(array: any[]) {
    let currentIndex = array.length;
    let randomIndex = 0;

    // While there remain elements to shuffle.
    while (currentIndex > 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
}

/**
 * Get a TakeOrder type consumable by orderbook Quote lib for quoting orders
 */
export function getQuoteConfig(orderDetails: TakeOrderDetails) {
    return {
        order: {
            owner: orderDetails.takeOrder.order.owner as `0x${string}`,
            nonce: orderDetails.takeOrder.order.nonce as `0x${string}`,
            evaluable: {
                interpreter: orderDetails.takeOrder.order.evaluable.interpreter as `0x${string}`,
                store: orderDetails.takeOrder.order.evaluable.store as `0x${string}`,
                bytecode: orderDetails.takeOrder.order.evaluable.bytecode as `0x${string}`,
            },
            validInputs: orderDetails.takeOrder.order.validInputs.map((input: any) => ({
                token: input.token as `0x${string}`,
                decimals: input.decimals,
                vaultId: BigInt(
                    typeof input.vaultId == "string" ? input.vaultId : input.vaultId.toHexString(),
                ),
            })),
            validOutputs: orderDetails.takeOrder.order.validOutputs.map((output: any) => ({
                token: output.token as `0x${string}`,
                decimals: output.decimals,
                vaultId: BigInt(
                    typeof output.vaultId == "string"
                        ? output.vaultId
                        : output.vaultId.toHexString(),
                ),
            })),
        },
        inputIOIndex: BigInt(orderDetails.takeOrder.inputIOIndex),
        outputIOIndex: BigInt(orderDetails.takeOrder.outputIOIndex),
        signedContext: orderDetails.takeOrder.signedContext,
    };
}

/**
 * Clones the given object
 * @param obj - Object to clone
 * @returns A new copy of the object
 */
export function clone<T>(obj: any): T {
    if (obj instanceof BigNumber) {
        return BigNumber.from(obj.toString()) as T;
    } else if (Array.isArray(obj)) {
        return obj.map((item) => clone(item)) as T;
    } else if (typeof obj === "object") {
        const result: any = {};
        for (const key in obj) {
            const value = obj[key];
            result[key] = clone(value);
        }
        return result;
    } else {
        return obj;
    }
}

/**
 * Get total income in native chain's token units
 * @param inputTokenIncome
 * @param outputTokenIncome
 * @param inputTokenPrice
 * @param outputTokenPrice
 * @param inputTokenDecimals
 * @param outputTokenDecimals
 */
export function getTotalIncome(
    inputTokenIncome: BigNumber | undefined,
    outputTokenIncome: BigNumber | undefined,
    inputTokenPrice: string,
    outputTokenPrice: string,
    inputTokenDecimals: number,
    outputTokenDecimals: number,
): BigNumber | undefined {
    if (!inputTokenIncome && !outputTokenIncome) return undefined;
    const inputTokenIncomeInEth = (() => {
        if (inputTokenIncome) {
            return ethers.utils
                .parseUnits(inputTokenPrice)
                .mul(scale18(inputTokenIncome, inputTokenDecimals))
                .div(ONE18);
        } else {
            return ethers.constants.Zero;
        }
    })();
    const outputTokenIncomeInEth = (() => {
        if (outputTokenIncome) {
            return ethers.utils
                .parseUnits(outputTokenPrice)
                .mul(scale18(outputTokenIncome, outputTokenDecimals))
                .div(ONE18);
        } else {
            return ethers.constants.Zero;
        }
    })();
    return inputTokenIncomeInEth.add(outputTokenIncomeInEth);
}

/**
 * Estimates profit for a arb/clear2 tx
 * @param orderPairObject
 * @param inputToEthPrice
 * @param outputToEthPrice
 * @param opposingOrders
 * @param marketPrice
 * @param maxInput
 */
export function estimateProfit(
    orderPairObject: any,
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber | undefined,
    opposingOrders: any | undefined,
    marketPrice?: BigNumber,
    maxInput?: BigNumber,
): BigNumber | undefined {
    const One = ethers.utils.parseUnits("1");
    if (marketPrice) {
        const marketAmountOut = maxInput!.mul(marketPrice).div(One);
        const orderInput = maxInput!.mul(orderPairObject.takeOrders[0].quote.ratio).div(One);
        const estimatedProfit = marketAmountOut.sub(orderInput);
        return estimatedProfit.mul(inputToEthPrice).div(One);
    }
    if (opposingOrders) {
        // inter-orderbook
        if ("orderbook" in opposingOrders) {
            const orderOutput = maxInput;
            const orderInput = maxInput!.mul(orderPairObject.takeOrders[0].quote.ratio).div(One);

            let opposingMaxInput = orderPairObject.takeOrders[0].quote.ratio.isZero()
                ? ethers.constants.MaxUint256
                : maxInput!.mul(orderPairObject.takeOrders[0].quote.ratio).div(One);
            const opposingMaxIORatio = orderPairObject.takeOrders[0].quote.ratio.isZero()
                ? ethers.constants.MaxUint256
                : One.mul(One).div(orderPairObject.takeOrders[0].quote.ratio);

            let opposingInput = ethers.constants.Zero;
            let opposingOutput = ethers.constants.Zero;
            for (let i = 0; i < opposingOrders.takeOrders.length; i++) {
                const order = opposingOrders.takeOrders[i].quote;
                if (opposingMaxInput.lte(0)) break;
                if (opposingMaxIORatio.gte(order.ratio)) {
                    const maxOut = opposingMaxInput.lt(order.maxOutput)
                        ? opposingMaxInput
                        : order.maxOutput;
                    opposingOutput = opposingOutput.add(maxOut);
                    opposingInput = opposingInput.add(maxOut.mul(order.ratio).div(One));
                    opposingMaxInput = opposingMaxInput.sub(maxOut);
                }
            }
            const outputProfit = orderOutput!.sub(opposingInput).mul(outputToEthPrice!).div(One);
            const inputProfit = opposingOutput.sub(orderInput).mul(inputToEthPrice).div(One);
            return outputProfit.add(inputProfit);
        }
        // intra orderbook
        else {
            const orderMaxInput = orderPairObject.takeOrders[0].quote.maxOutput
                .mul(orderPairObject.takeOrders[0].quote.ratio)
                .div(One);
            const opposingMaxInput = opposingOrders.quote.maxOutput
                .mul(opposingOrders.quote.ratio)
                .div(One);

            const orderOutput = opposingOrders.quote.ratio.isZero()
                ? orderPairObject.takeOrders[0].quote.maxOutput
                : orderPairObject.takeOrders[0].quote.maxOutput.lte(opposingMaxInput)
                  ? orderPairObject.takeOrders[0].quote.maxOutput
                  : opposingMaxInput;
            const orderInput = orderOutput.mul(orderPairObject.takeOrders[0].quote.ratio).div(One);

            const opposingOutput = opposingOrders.quote.ratio.isZero()
                ? opposingOrders.quote.maxOutput
                : orderMaxInput.lte(opposingOrders.quote.maxOutput)
                  ? orderMaxInput
                  : opposingOrders.quote.maxOutput;
            const opposingInput = opposingOutput.mul(opposingOrders.quote.ratio).div(One);

            let outputProfit = orderOutput.sub(opposingInput);
            if (outputProfit.lt(0)) outputProfit = ethers.constants.Zero;
            outputProfit = outputProfit.mul(outputToEthPrice).div(One);

            let inputProfit = opposingOutput.sub(orderInput);
            if (inputProfit.lt(0)) inputProfit = ethers.constants.Zero;
            inputProfit = inputProfit.mul(inputToEthPrice).div(One);

            return outputProfit.add(inputProfit);
        }
    }
}

/**
 * Gets values for an RP swap transaction
 * @param chainId - The network chain id
 * @param sellAmount - The sell amount, should be in onchain token value
 * @param fromToken - The from token address
 * @param toToken - The to token address
 * @param receiverAddress - The address of the receiver
 * @param routeProcessorAddress - The address of the RouteProcessor contract
 * @param dataFetcher - The DataFetcher instance
 * @param gasPrice - Gas price
 */
export async function getRpSwap(
    chainId: number,
    sellAmount: BigNumber,
    fromToken: Type,
    toToken: Type,
    receiverAddress: string,
    routeProcessorAddress: string,
    dataFetcher: DataFetcher,
    gasPrice: BigNumber,
    lps?: LiquidityProviders[],
) {
    const amountIn = sellAmount.toBigInt();
    const pcMap = dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        chainId as ChainId,
        fromToken,
        amountIn,
        toToken,
        gasPrice.toNumber(),
        lps,
        RPoolFilter,
    );
    if (route.status == "NoWay") {
        throw "NoWay";
    } else {
        const rpParams = Router.routeProcessor4Params(
            pcMap,
            route,
            fromToken,
            toToken,
            receiverAddress as `0x${string}`,
            routeProcessorAddress as `0x${string}`,
        );
        return { rpParams, route };
    }
}

/**
 * Checks if a route exists between 2 tokens using sushi router
 */
export async function routeExists(
    config: BotConfig,
    fromToken: Token,
    toToken: Token,
    gasPrice: BigNumber,
): Promise<boolean> {
    try {
        await getRpSwap(
            config.chain.id,
            BigNumber.from("1" + "0".repeat(fromToken.decimals)),
            fromToken,
            toToken,
            "0x" + "1".repeat(40),
            "0x" + "2".repeat(40),
            config.dataFetcher,
            gasPrice,
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Json serializer function for handling bigint type
 */
export function withBigintSerializer(_k: string, v: any) {
    if (typeof v == "bigint") {
        return v.toString();
    } else {
        return v;
    }
}

/**
 * Converts to a float number
 */
export function toNumber(value: BigNumberish): number {
    return Number.parseFloat(ethers.utils.formatUnits(value));
}

/**
 * Get market quote (price) for a token pair using sushi router
 */
export function getMarketQuote(
    config: BotConfig,
    fromToken: Token,
    toToken: Token,
    gasPrice: BigNumber,
) {
    const amountIn = ethers.utils.parseUnits("1", fromToken.decimals);
    const amountInFixed = ethers.utils.parseUnits("1");
    const pcMap = config.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        config.chain.id as ChainId,
        fromToken,
        amountIn.toBigInt(),
        toToken,
        gasPrice.toNumber(),
        undefined,
        RPoolFilter,
    );
    if (route.status == "NoWay") {
        return undefined;
    } else {
        const rateFixed = scale18(route.amountOutBI, toToken.decimals);
        const price = rateFixed.mul(ONE18).div(amountInFixed);
        return {
            price: ethers.utils.formatUnits(price),
            amountOut: ethers.utils.formatUnits(route.amountOutBI, toToken.decimals),
        };
    }
}

/**
 * Checks if an a value is a big numberish, from ethers
 */
export function isBigNumberish(value: any): value is BigNumberish {
    return (
        value != null &&
        (BigNumber.isBigNumber(value) ||
            (typeof value === "number" && value % 1 === 0) ||
            (typeof value === "string" && !!value.match(/^-?[0-9]+$/)) ||
            isHexString(value) ||
            typeof value === "bigint" ||
            isBytes(value))
    );
}

/**
 * Helper function to log memory usage
 */
export function memory(msg: string) {
    // eslint-disable-next-line no-console
    console.log(msg);
    for (const [key, value] of Object.entries(process.memoryUsage())) {
        // eslint-disable-next-line no-console
        console.log(`Memory usage by ${key}, ${value / 1_000_000}MB `);
    }
    // eslint-disable-next-line no-console
    console.log("\n---\n");
}

/**
 * Scales a given value and its decimals to 18 fixed point decimals
 */
export function scale18(value: BigNumberish, decimals: BigNumberish): BigNumber {
    const d = BigNumber.from(decimals).toNumber();
    if (d > 18) {
        return BigNumber.from(value).div("1" + "0".repeat(d - 18));
    } else {
        return BigNumber.from(value).mul("1" + "0".repeat(18 - d));
    }
}

/**
 * Scales a given 18 fixed point decimals value to the given decimals point value
 */
export function scale18To(value: BigNumberish, targetDecimals: BigNumberish): BigNumber {
    const decimals = BigNumber.from(targetDecimals).toNumber();
    if (decimals > 18) {
        return BigNumber.from(value).mul("1" + "0".repeat(decimals - 18));
    } else {
        return BigNumber.from(value).div("1" + "0".repeat(18 - decimals));
    }
}

/**
 * Adds the given k/v pairs to the spanAttributes by prepending the key with given header
 */
export function extendSpanAttributes(
    spanAttributes: Record<string, any>,
    newAttributes: Record<string, any>,
    header: string,
    excludeHeaderForKeys: string[] = [],
) {
    for (const attrKey in newAttributes) {
        if (!excludeHeaderForKeys.includes(attrKey)) {
            spanAttributes[header + "." + attrKey] = newAttributes[attrKey];
        } else {
            spanAttributes[attrKey] = newAttributes[attrKey];
        }
    }
}

/**
 * Adds the given token details to the given list
 */
export function addWatchedToken(
    token: TokenDetails,
    watchedTokens: TokenDetails[],
    account?: ViemClient,
) {
    if (!watchedTokens.find((v) => v.address.toLowerCase() === token.address.toLowerCase())) {
        watchedTokens.push(token);
    }
    if (account) {
        if (!account.BOUNTY.find((v) => v.address.toLowerCase() === token.address.toLowerCase())) {
            account.BOUNTY.push(token);
        }
    }
}
