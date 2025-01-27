import { SgOrder } from "./query";
import { ChainId } from "sushi/chain";
import { RouteLeg } from "sushi/tines";
import { getDataFetcher } from "./config";
import { Token, Type } from "sushi/currency";
import BlackList from "./pool-blacklist.json";
import { isBytes, isHexString } from "ethers/lib/utils";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { erc20Abi, orderbookAbi, OrderV3 } from "./abis";
import { parseAbi, PublicClient, TransactionReceipt } from "viem";
import { doQuoteTargets, QuoteTarget } from "@rainlanguage/orderbook/quote";
import { DataFetcher, DataFetcherOptions, LiquidityProviders, Router } from "sushi/router";
import { BotConfig, BundledOrders, OwnedOrder, TakeOrder, TokenDetails, ViemClient } from "./types";

/**
 * One ether which equals to 1e18
 */
export const ONE18 = 1_000_000_000_000_000_000n as const;

export function RPoolFilter(pool: any) {
    return !BlackList.includes(pool.address) && !BlackList.includes(pool.address.toLowerCase());
}

export const PoolBlackList = new Set(BlackList);

/**
 * Waits for provided miliseconds
 * @param ms - Miliseconds to wait
 */
export const sleep = async (ms: number, msg = "") => {
    let _timeoutReference: string | number | NodeJS.Timeout | undefined;
    return new Promise(
        (resolve) => (_timeoutReference = setTimeout(() => resolve(msg), ms)),
    ).finally(() => clearTimeout(_timeoutReference));
};

/**
 * Extracts the income (received token value) from transaction receipt
 * @param signerAddress - The signer address
 * @param receipt - The transaction receipt
 * @param token - The token address that was transfered
 * @returns The income value or undefined if cannot find any valid value
 */
export const getIncome = (
    signerAddress: string,
    receipt: TransactionReceipt,
    token: string,
): BigNumber | undefined => {
    let result: BigNumber | undefined;
    const erc20Interface = new ethers.utils.Interface(erc20Abi);
    try {
        if (receipt.logs)
            result = receipt.logs
                .filter(
                    (v) =>
                        (v.address && token ? ethers.BigNumber.from(v.address).eq(token) : true) &&
                        v.topics[2] &&
                        ethers.BigNumber.from(v.topics[2]).eq(signerAddress),
                )
                .map((v) => {
                    try {
                        return erc20Interface.decodeEventLog("Transfer", v.data, v.topics);
                    } catch {
                        return undefined;
                    }
                })?.[0]?.value;
    } catch {
        /**/
    }
    return result;
};

/**
 * Extracts the actual clear amount (received token value) from transaction receipt
 * @param toAddress - The to address
 * @param obAddress - The orderbook address
 * @param receipt - The transaction receipt
 * @returns The actual clear amount
 */
export const getActualClearAmount = (
    toAddress: string,
    obAddress: string,
    receipt: TransactionReceipt,
): BigNumber | undefined => {
    if (toAddress.toLowerCase() !== obAddress.toLowerCase()) {
        const erc20Interface = new ethers.utils.Interface(erc20Abi);
        try {
            if (receipt.logs)
                return receipt.logs
                    .map((v) => {
                        try {
                            return erc20Interface.decodeEventLog("Transfer", v.data, v.topics);
                        } catch {
                            return undefined;
                        }
                    })
                    .filter(
                        (v) =>
                            v !== undefined &&
                            BigNumber.from(v.to).eq(toAddress) &&
                            BigNumber.from(v.from).eq(obAddress),
                    )[0]?.value;
            else return undefined;
        } catch {
            return undefined;
        }
    } else {
        const obInterface = new ethers.utils.Interface(orderbookAbi);
        try {
            if (receipt.logs)
                return receipt.logs
                    .map((v) => {
                        try {
                            return obInterface.decodeEventLog("AfterClear", v.data, v.topics);
                        } catch {
                            return undefined;
                        }
                    })
                    .filter((v) => v !== undefined)[0]?.clearStateChange?.aliceOutput;
            else return undefined;
        } catch {
            return undefined;
        }
    }
};

/**
 * Calculates the actual clear price from transactioin event
 * @param receipt - The transaction receipt
 * @param orderbook - The Orderbook contract address
 * @param arb - The Arb contract address
 * @param amount - The clear amount
 * @param buyDecimals - The buy token decimals
 * @returns The actual clear price or undefined if necessary info not found in transaction events
 */
export const getActualPrice = (
    receipt: TransactionReceipt,
    orderbook: string,
    arb: string,
    amount: string,
    buyDecimals: number,
): string | undefined => {
    const erc20Interface = new ethers.utils.Interface(erc20Abi);
    const eventObj = receipt.logs
        ?.map((v) => {
            try {
                return erc20Interface.decodeEventLog("Transfer", v.data, v.topics);
            } catch {
                return undefined;
            }
        })
        .filter(
            (v) =>
                v &&
                !ethers.BigNumber.from(v.from).eq(orderbook) &&
                ethers.BigNumber.from(v.to).eq(arb),
        );
    if (eventObj[0] && eventObj[0]?.value)
        return ethers.utils.formatUnits(
            scale18(eventObj[0].value, buyDecimals).mul(ONE18).div(amount),
        );
    else return undefined;
};

/**
 * Gets token price against ETH
 * @param config - The network config data
 * @param targetTokenAddress - The token address
 * @param targetTokenDecimals - The token decimals
 * @param gasPrice - The network gas price
 * @param dataFetcher - (optional) The DataFetcher instance
 * @param options - (optional) The DataFetcher options
 */
export const getEthPrice = async (
    config: any,
    targetTokenAddress: string,
    targetTokenDecimals: number,
    gasPrice: BigNumber,
    dataFetcher?: DataFetcher,
    options?: DataFetcherOptions,
    fetchPools = true,
): Promise<string | undefined> => {
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
    if (!dataFetcher) dataFetcher = await getDataFetcher(config);
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
};

/**
 * Resolves an array of case-insensitive names to LiquidityProviders, ignores the ones that are not valid
 * @param liquidityProviders - List of liquidity providers
 */
export const processLps = (liquidityProviders?: string[]) => {
    const LP = Object.values(LiquidityProviders);
    if (
        !liquidityProviders ||
        !Array.isArray(liquidityProviders) ||
        !liquidityProviders.length ||
        !liquidityProviders.every((v) => typeof v === "string")
    ) {
        // exclude curve since it is currently in audit, unless it is explicitly specified
        // exclude camelot
        return LP.filter(
            (v) => v !== LiquidityProviders.CurveSwap && v !== LiquidityProviders.Camelot,
        );
    }
    const _lps: LiquidityProviders[] = [];
    for (let i = 0; i < liquidityProviders.length; i++) {
        const index = LP.findIndex(
            (v) => v.toLowerCase() === liquidityProviders[i].toLowerCase().trim(),
        );
        if (index > -1 && !_lps.includes(LP[index])) _lps.push(LP[index]);
    }
    return _lps.length
        ? _lps
        : LP.filter((v) => v !== LiquidityProviders.CurveSwap && v !== LiquidityProviders.Camelot);
};

/**
 * Method to shorten data fields of items that are logged and optionally hide sensitive data
 * @param scrub - Option to scrub sensitive data
 * @param data - The optinnal data to hide
 */
export const appGlobalLogger = (scrub: boolean, ...data: any[]) => {
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
};

/**
 * Method to put a timeout on a promise, throws the exception if promise is not settled within the time
 * @param promise - The Promise to put timeout on
 * @param time - The time in milliseconds
 * @param exception - The exception value to reject with if the promise is not settled within time
 * @returns A new promise that gets settled with initial promise settlement or rejected with exception value
 * if the time runs out before the main promise settlement
 */
export const promiseTimeout = async (
    promise: Promise<any>,
    time: number,
    exception: string | number | bigint | symbol | boolean,
) => {
    let timer: string | number | NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise((_res, _rej) => (timer = setTimeout(_rej, time, exception))),
    ]).finally(() => clearTimeout(timer));
};

/**
 * Gets the route for tokens
 * @param chainId - The network chain id
 * @param rpcs - The rpcs
 * @param sellAmount - The sell amount, should be in onchain token value
 * @param fromTokenAddress - The from token address
 * @param fromTokenDecimals - The from token decimals
 * @param toTokenAddress - The to token address
 * @param toTokenDecimals - The to token decimals
 * @param receiverAddress - The address of the receiver
 * @param routeProcessorAddress - The address of the RouteProcessor contract
 * @param abiencoded - If the result should be abi encoded or not
 */
export const getRouteForTokens = async (
    chainId: number,
    rpcs: string[],
    sellAmount: BigNumber,
    fromTokenAddress: string,
    fromTokenDecimals: number,
    toTokenAddress: string,
    toTokenDecimals: number,
    receiverAddress: string,
    routeProcessorAddress: string,
    abiEncoded = false,
) => {
    const amountIn = sellAmount.toBigInt();
    const fromToken = new Token({
        chainId: chainId,
        decimals: fromTokenDecimals,
        address: fromTokenAddress,
    });
    const toToken = new Token({
        chainId: chainId,
        decimals: toTokenDecimals,
        address: toTokenAddress,
    });
    const dataFetcher = await getDataFetcher({
        chain: { id: chainId },
        rpc: rpcs,
    } as any as PublicClient);
    await dataFetcher.fetchPoolsForToken(fromToken, toToken);
    const pcMap = dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        chainId as ChainId,
        fromToken,
        amountIn,
        toToken,
        Number(await dataFetcher.web3Client.getGasPrice()),
        // providers,
        // poolFilter
    );
    if (route.status == "NoWay") throw "NoWay";
    else {
        let routeText = "";
        route.legs.forEach((v, i) => {
            if (i === 0)
                routeText =
                    routeText +
                    v.tokenTo.symbol +
                    "/" +
                    v.tokenFrom.symbol +
                    "(" +
                    (v as any).poolName +
                    ")";
            else
                routeText =
                    routeText +
                    " + " +
                    v.tokenTo.symbol +
                    "/" +
                    v.tokenFrom.symbol +
                    "(" +
                    (v as any).poolName +
                    ")";
        });
        // eslint-disable-next-line no-console
        console.log("Route portions: ", routeText, "\n");
        const rpParams = Router.routeProcessor4Params(
            pcMap,
            route,
            fromToken,
            toToken,
            receiverAddress as `0x${string}`,
            routeProcessorAddress as `0x${string}`,
            // permits
            // "0.005"
        );
        if (abiEncoded) return ethers.utils.defaultAbiCoder.encode(["bytes"], [rpParams.routeCode]);
        else return rpParams.routeCode;
    }
};

/**
 * Method to visualize the routes, returns array of route strings sorted from highest to lowest percentage
 * @param fromToken - The from token address
 * @param toToken - The to token address
 * @param legs - The legs of the route
 */
export const visualizeRoute = (fromToken: Token, toToken: Token, legs: RouteLeg[]): string[] => {
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
};

/**
 * Shuffles an array
 * @param array - The array
 */
export const shuffleArray = (array: any[]) => {
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
};

/**
 * Prepares an etherjs error for otel span consumption
 * @param error - The ethersjs error
 */
export function getSpanException(error: any) {
    if (
        error instanceof Error &&
        Object.keys(error).length &&
        error.message.includes("providers/5.7.0")
    ) {
        const parsedError = JSON.parse(JSON.stringify(error));
        error.message = JSON.stringify(parsedError);

        // remove stack since it is already present in message
        error.stack = undefined;
        return error;
    }
    return error;
}

/**
 * Builds and bundles orders which their details are queried from a orderbook subgraph
 * @param ordersDetails - Orders details queried from subgraph
 * @param _shuffle - To shuffle the bundled order array at the end
 * @param _bundle = If orders should be bundled based on token pair
 * @returns Array of bundled take orders
 */
export const bundleOrders = (
    ordersDetails: any[],
    _shuffle = true,
    _bundle = true,
): BundledOrders[][] => {
    const bundledOrders: Record<string, BundledOrders[]> = {};
    for (let i = 0; i < ordersDetails.length; i++) {
        const orderDetails = ordersDetails[i];
        const orderbook = orderDetails.orderbook.id;
        const orderStruct = ethers.utils.defaultAbiCoder.decode(
            [OrderV3],
            orderDetails.orderBytes,
        )[0];

        for (let j = 0; j < orderStruct.validOutputs.length; j++) {
            const _output = orderStruct.validOutputs[j];
            const _outputSymbol = orderDetails.outputs.find(
                (v: any) => v.token.address.toLowerCase() === _output.token.toLowerCase(),
            ).token.symbol;

            for (let k = 0; k < orderStruct.validInputs.length; k++) {
                const _input = orderStruct.validInputs[k];
                const _inputSymbol = orderDetails.inputs.find(
                    (v: any) => v.token.address.toLowerCase() === _input.token.toLowerCase(),
                ).token.symbol;

                if (_output.token.toLowerCase() !== _input.token.toLowerCase()) {
                    if (!bundledOrders[orderbook]) {
                        bundledOrders[orderbook] = [];
                    }
                    const pair = bundledOrders[orderbook].find(
                        (v) =>
                            v.sellToken === _output.token.toLowerCase() &&
                            v.buyToken === _input.token.toLowerCase(),
                    );
                    if (pair && _bundle)
                        pair.takeOrders.push({
                            id: orderDetails.orderHash,
                            // active: true,
                            takeOrder: {
                                order: orderStruct,
                                inputIOIndex: k,
                                outputIOIndex: j,
                                signedContext: [],
                            },
                        });
                    else
                        bundledOrders[orderbook].push({
                            orderbook,
                            buyToken: _input.token.toLowerCase(),
                            buyTokenSymbol: _inputSymbol,
                            buyTokenDecimals: _input.decimals,
                            sellToken: _output.token.toLowerCase(),
                            sellTokenSymbol: _outputSymbol,
                            sellTokenDecimals: _output.decimals,
                            takeOrders: [
                                {
                                    id: orderDetails.orderHash,
                                    // active: true,
                                    takeOrder: {
                                        order: orderStruct,
                                        inputIOIndex: k,
                                        outputIOIndex: j,
                                        signedContext: [],
                                    },
                                },
                            ],
                        });
                }
            }
        }
    }
    if (_shuffle) {
        // shuffle bundled orders pairs
        if (_bundle) {
            for (const ob in bundledOrders) {
                shuffleArray(bundledOrders[ob]);
            }
        }

        // shuffle orderbooks
        const result = Object.values(bundledOrders);
        shuffleArray(result);

        return result;
    }
    return Object.values(bundledOrders);
};

/**
 * Gets vault balance of an order or combined value of vaults if bundled
 * @param orderDetails
 * @param orderbookAddress
 * @param viemClient
 * @param multicallAddressOverride
 */
export async function getVaultBalance(
    orderDetails: BundledOrders,
    orderbookAddress: string,
    viemClient: PublicClient,
    multicallAddressOverride?: string,
): Promise<BigNumber> {
    const multicallResult = await viemClient.multicall({
        multicallAddress:
            (multicallAddressOverride as `0x${string}` | undefined) ??
            viemClient.chain?.contracts?.multicall3?.address,
        allowFailure: false,
        contracts: orderDetails.takeOrders.map((v) => ({
            address: orderbookAddress as `0x${string}`,
            allowFailure: false,
            chainId: viemClient.chain!.id,
            abi: parseAbi([orderbookAbi[3]]),
            functionName: "vaultBalance",
            args: [
                // owner
                v.takeOrder.order.owner,
                // token
                v.takeOrder.order.validOutputs[v.takeOrder.outputIOIndex].token,
                // valut id
                v.takeOrder.order.validOutputs[v.takeOrder.outputIOIndex].vaultId,
            ],
        })),
    });

    let result = ethers.BigNumber.from(0);
    for (let i = 0; i < multicallResult.length; i++) {
        result = result.add(multicallResult[i]!);
    }
    return result;
}

/**
 * Quotes order details that are already fetched and bundled by bundleOrder()
 * @param orderDetails - Order details to quote
 * @param rpcs - RPC urls
 * @param blockNumber - Optional block number
 * @param multicallAddressOverride - Optional multicall address
 */
export async function quoteOrders(
    orderDetails: BundledOrders[][],
    rpcs: string[],
    blockNumber?: bigint,
    gas?: bigint,
    multicallAddressOverride?: string,
): Promise<BundledOrders[][]> {
    let quoteResults: any[] = [];
    const targets = orderDetails.flatMap((v) =>
        v.flatMap((list) =>
            list.takeOrders.map((orderConfig) => ({
                orderbook: list.orderbook,
                quoteConfig: getQuoteConfig(orderConfig),
            })),
        ),
    ) as any as QuoteTarget[];
    for (let i = 0; i < rpcs.length; i++) {
        const rpc = rpcs[i];
        try {
            quoteResults = await doQuoteTargets(
                targets,
                rpc,
                blockNumber,
                gas,
                multicallAddressOverride,
            );
            break;
        } catch (e) {
            // throw only after every available rpc has been tried and failed
            if (i === rpcs.length - 1) throw e;
        }
    }

    // map results to the original obj
    for (const orderbookOrders of orderDetails) {
        for (const pair of orderbookOrders) {
            for (const order of pair.takeOrders) {
                const quoteResult = quoteResults.shift();
                if (quoteResult) {
                    if (typeof quoteResult !== "string") {
                        order.quote = {
                            maxOutput: ethers.BigNumber.from(quoteResult.maxOutput),
                            ratio: ethers.BigNumber.from(quoteResult.ratio),
                        };
                    }
                }
            }
        }
    }

    // filter out those that failed quote or have 0 maxoutput
    for (let i = 0; i < orderDetails.length; i++) {
        for (const pair of orderDetails[i]) {
            pair.takeOrders = pair.takeOrders.filter((v) => v.quote && v.quote.maxOutput.gt(0));
            if (pair.takeOrders.length) {
                pair.takeOrders.sort((a, b) =>
                    a.quote!.ratio.lt(b.quote!.ratio)
                        ? -1
                        : a.quote!.ratio.gt(b.quote!.ratio)
                          ? 1
                          : 0,
                );
            }
        }
        orderDetails[i] = orderDetails[i].filter((v) => v.takeOrders.length > 0);
    }

    return orderDetails;
}

/**
 * Quotes a single order
 * @param orderDetails - Order details to quote
 * @param rpcs - RPC urls
 * @param blockNumber - Optional block number
 * @param multicallAddressOverride - Optional multicall address
 */
export async function quoteSingleOrder(
    orderDetails: BundledOrders,
    rpcs: string[],
    blockNumber?: bigint,
    gas?: bigint,
    multicallAddressOverride?: string,
) {
    for (let i = 0; i < rpcs.length; i++) {
        const rpc = rpcs[i];
        try {
            const quoteResult = (
                await doQuoteTargets(
                    [
                        {
                            orderbook: orderDetails.orderbook,
                            quoteConfig: getQuoteConfig(orderDetails.takeOrders[0]),
                        },
                    ] as any as QuoteTarget[],
                    rpc,
                    blockNumber,
                    gas,
                    multicallAddressOverride,
                )
            )[0];
            if (typeof quoteResult !== "string") {
                orderDetails.takeOrders[0].quote = {
                    maxOutput: ethers.BigNumber.from(quoteResult.maxOutput),
                    ratio: ethers.BigNumber.from(quoteResult.ratio),
                };
                return;
            } else {
                return Promise.reject(`failed to quote order, reason: ${quoteResult}`);
            }
        } catch (e) {
            // throw only after every available rpc has been tried and failed
            if (i === rpcs.length - 1) throw (e as Error)?.message;
        }
    }
}

/**
 * Get a TakeOrder type consumable by orderbook Quote lib for quoting orders
 */
export function getQuoteConfig(orderDetails: any): TakeOrder {
    return {
        order: {
            owner: orderDetails.takeOrder.order.owner,
            nonce: orderDetails.takeOrder.order.nonce,
            evaluable: {
                interpreter: orderDetails.takeOrder.order.evaluable.interpreter,
                store: orderDetails.takeOrder.order.evaluable.store,
                bytecode: ethers.utils.arrayify(orderDetails.takeOrder.order.evaluable.bytecode),
            },
            validInputs: orderDetails.takeOrder.order.validInputs.map((input: any) => ({
                token: input.token,
                decimals: input.decimals,
                vaultId:
                    typeof input.vaultId == "string" ? input.vaultId : input.vaultId.toHexString(),
            })),
            validOutputs: orderDetails.takeOrder.order.validOutputs.map((output: any) => ({
                token: output.token,
                decimals: output.decimals,
                vaultId:
                    typeof output.vaultId == "string"
                        ? output.vaultId
                        : output.vaultId.toHexString(),
            })),
        },
        inputIOIndex: orderDetails.takeOrder.inputIOIndex,
        outputIOIndex: orderDetails.takeOrder.outputIOIndex,
        signedContext: orderDetails.takeOrder.signedContext,
    };
}

/**
 * Clones the given object
 * @param obj - Object to clone
 * @returns A new copy of the object
 */
export function clone<T>(obj: any): T {
    if (obj instanceof ethers.BigNumber) {
        return ethers.BigNumber.from(obj.toString()) as T;
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
export const getRpSwap = async (
    chainId: number,
    sellAmount: BigNumber,
    fromToken: Type,
    toToken: Type,
    receiverAddress: string,
    routeProcessorAddress: string,
    dataFetcher: DataFetcher,
    gasPrice: BigNumber,
    lps?: LiquidityProviders[],
) => {
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
};

/**
 * Gets all distinct tokens of all the orders' IOs from a subgraph query,
 * used to to keep a cache of known tokens at runtime to not fetch their
 * details everytime with onchain calls
 */
export function getOrdersTokens(ordersDetails: SgOrder[]): TokenDetails[] {
    const tokens: TokenDetails[] = [];
    for (let i = 0; i < ordersDetails.length; i++) {
        const orderDetails = ordersDetails[i];
        const orderStruct = ethers.utils.defaultAbiCoder.decode(
            [OrderV3],
            orderDetails.orderBytes,
        )[0];

        for (let j = 0; j < orderStruct.validOutputs.length; j++) {
            const _output = orderStruct.validOutputs[j];
            const _outputSymbol = orderDetails.outputs.find(
                (v: any) => v.token.address.toLowerCase() === _output.token.toLowerCase(),
            )?.token?.symbol;
            if (!tokens.find((v) => v.address === _output.token.toLowerCase())) {
                tokens.push({
                    address: _output.token.toLowerCase(),
                    decimals: _output.decimals,
                    symbol: _outputSymbol ?? "UnknownSymbol",
                });
            }
        }
        for (let k = 0; k < orderStruct.validInputs.length; k++) {
            const _input = orderStruct.validInputs[k];
            const _inputSymbol = orderDetails.inputs.find(
                (v: any) => v.token.address.toLowerCase() === _input.token.toLowerCase(),
            )?.token?.symbol;
            if (!tokens.find((v) => v.address === _input.token.toLowerCase())) {
                tokens.push({
                    address: _input.token.toLowerCase(),
                    decimals: _input.decimals,
                    symbol: _inputSymbol ?? "UnknownSymbol",
                });
            }
        }
    }
    return tokens;
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
            ethers.BigNumber.from("1" + "0".repeat(fromToken.decimals)),
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
                abi: parseAbi([orderbookAbi[3]]),
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
 * Get block number with retries, using viem client
 */
export async function getBlockNumber(viemClient: ViemClient): Promise<bigint | undefined> {
    for (let i = 0; i < 3; i++) {
        try {
            return await viemClient.getBlockNumber();
        } catch (e) {
            await sleep(5_000);
        }
    }
    return;
}

/**
 * Get token symbol
 * @param address - The address of token
 * @param viemClient - The viem client
 */
export async function getTokenSymbol(address: string, viemClient: ViemClient): Promise<string> {
    // 3 retries
    for (let i = 0; i < 3; i++) {
        try {
            return await viemClient.readContract({
                address: address as `0x${string}`,
                abi: parseAbi(erc20Abi),
                functionName: "symbol",
            });
        } catch {
            await sleep(5_000);
        }
    }
    return "UnknownSymbol";
}

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
