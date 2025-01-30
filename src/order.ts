import { ethers } from "ethers";
import { SgOrder } from "./query";
import { Span } from "@opentelemetry/api";
import { OrderbookQuoteAbi, OrderV3, VaultBalanceAbi } from "./abis";
import { shuffleArray, sleep, addWatchedToken, getQuoteConfig } from "./utils";
import {
    erc20Abi,
    encodeFunctionData,
    parseAbiParameters,
    decodeAbiParameters,
    decodeFunctionResult,
} from "viem";
import {
    Pair,
    Order,
    Vault,
    OTOVMap,
    ViemClient,
    OwnersVaults,
    TokenDetails,
    BundledOrders,
    OrdersProfileMap,
    OwnersProfileMap,
    TokensOwnersVaults,
    OrderbooksOwnersProfileMap,
} from "./types";

/**
 * The default owner limit
 */
export const DEFAULT_OWNER_LIMIT = 25 as const;
const OrderV3Abi = parseAbiParameters(OrderV3);

export function toOrder(orderLog: any): Order {
    return {
        owner: orderLog.owner.toLowerCase(),
        nonce: orderLog.nonce.toLowerCase(),
        evaluable: {
            interpreter: orderLog.evaluable.interpreter.toLowerCase(),
            store: orderLog.evaluable.store.toLowerCase(),
            bytecode: orderLog.evaluable.bytecode.toLowerCase(),
        },
        validInputs: orderLog.validInputs.map((v: any) => ({
            token: v.token.toLowerCase(),
            decimals: v.decimals,
            vaultId: ethers.utils.hexlify(v.vaultId),
        })),
        validOutputs: orderLog.validOutputs.map((v: any) => ({
            token: v.token.toLowerCase(),
            decimals: v.decimals,
            vaultId: ethers.utils.hexlify(v.vaultId),
        })),
    };
}

/**
 * Get all pairs of an order
 */
export async function getOrderPairs(
    orderHash: string,
    orderStruct: Order,
    viemClient: ViemClient,
    tokens: TokenDetails[],
    orderDetails?: SgOrder,
): Promise<Pair[]> {
    const pairs: Pair[] = [];
    for (let j = 0; j < orderStruct.validOutputs.length; j++) {
        const _output = orderStruct.validOutputs[j];
        let _outputSymbol = orderDetails?.outputs?.find(
            (v) => v.token.address.toLowerCase() === _output.token.toLowerCase(),
        )?.token?.symbol;
        if (!_outputSymbol) {
            const symbol = tokens.find(
                (v) => v.address.toLowerCase() === _output.token.toLowerCase(),
            )?.symbol;
            if (!symbol) {
                _outputSymbol = await getTokenSymbol(_output.token, viemClient);
            } else {
                _outputSymbol = symbol;
            }
        } else {
            addWatchedToken(
                {
                    address: _output.token.toLowerCase(),
                    symbol: _outputSymbol,
                    decimals: _output.decimals,
                },
                tokens,
            );
        }

        for (let k = 0; k < orderStruct.validInputs.length; k++) {
            const _input = orderStruct.validInputs[k];
            let _inputSymbol = orderDetails?.inputs?.find(
                (v) => v.token.address.toLowerCase() === _input.token.toLowerCase(),
            )?.token?.symbol;
            if (!_inputSymbol) {
                const symbol = tokens.find(
                    (v) => v.address.toLowerCase() === _input.token.toLowerCase(),
                )?.symbol;
                if (!symbol) {
                    _inputSymbol = await getTokenSymbol(_input.token, viemClient);
                } else {
                    _inputSymbol = symbol;
                }
            } else {
                addWatchedToken(
                    {
                        address: _input.token.toLowerCase(),
                        symbol: _inputSymbol,
                        decimals: _input.decimals,
                    },
                    tokens,
                );
            }

            if (_input.token.toLowerCase() !== _output.token.toLowerCase())
                pairs.push({
                    buyToken: _input.token.toLowerCase(),
                    buyTokenSymbol: _inputSymbol,
                    buyTokenDecimals: _input.decimals,
                    sellToken: _output.token.toLowerCase(),
                    sellTokenSymbol: _outputSymbol,
                    sellTokenDecimals: _output.decimals,
                    takeOrder: {
                        id: orderHash,
                        takeOrder: {
                            order: orderStruct,
                            inputIOIndex: k,
                            outputIOIndex: j,
                            signedContext: [],
                        },
                    },
                });
        }
    }
    return pairs;
}

/**
 * Handles new orders fetched from sg to the owner profile map
 */
export async function handleAddOrderbookOwnersProfileMap(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    ordersDetails: SgOrder[],
    viemClient: ViemClient,
    tokens: TokenDetails[],
    ownerLimits?: Record<string, number>,
    span?: Span,
) {
    const changes: Record<string, string[]> = {};
    for (let i = 0; i < ordersDetails.length; i++) {
        const orderDetails = ordersDetails[i];
        const orderHash = orderDetails.orderHash.toLowerCase();
        const orderbook = orderDetails.orderbook.id.toLowerCase();
        const orderStruct = toOrder(
            decodeAbiParameters(OrderV3Abi, orderDetails.orderBytes as `0x${string}`)[0],
        );
        if (span) {
            if (!changes[orderbook]) changes[orderbook] = [];
            if (!changes[orderbook].includes(orderDetails.orderHash.toLowerCase())) {
                changes[orderbook].push(orderDetails.orderHash.toLowerCase());
            }
        }
        const orderbookOwnerProfileItem = orderbooksOwnersProfileMap.get(orderbook);
        if (orderbookOwnerProfileItem) {
            const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner.toLowerCase());
            if (ownerProfile) {
                const order = ownerProfile.orders.get(orderHash);
                if (!order) {
                    ownerProfile.orders.set(orderHash, {
                        active: true,
                        order: orderStruct,
                        takeOrders: await getOrderPairs(
                            orderHash,
                            orderStruct,
                            viemClient,
                            tokens,
                            orderDetails,
                        ),
                    });
                } else {
                    if (!order.active) order.active = true;
                }
            } else {
                const ordersProfileMap: OrdersProfileMap = new Map();
                ordersProfileMap.set(orderHash, {
                    active: true,
                    order: orderStruct,
                    takeOrders: await getOrderPairs(
                        orderHash,
                        orderStruct,
                        viemClient,
                        tokens,
                        orderDetails,
                    ),
                });
                orderbookOwnerProfileItem.set(orderStruct.owner.toLowerCase(), {
                    limit: ownerLimits?.[orderStruct.owner.toLowerCase()] ?? DEFAULT_OWNER_LIMIT,
                    orders: ordersProfileMap,
                    lastIndex: 0,
                });
            }
        } else {
            const ordersProfileMap: OrdersProfileMap = new Map();
            ordersProfileMap.set(orderHash, {
                active: true,
                order: orderStruct,
                takeOrders: await getOrderPairs(
                    orderHash,
                    orderStruct,
                    viemClient,
                    tokens,
                    orderDetails,
                ),
            });
            const ownerProfileMap: OwnersProfileMap = new Map();
            ownerProfileMap.set(orderStruct.owner.toLowerCase(), {
                limit: ownerLimits?.[orderStruct.owner.toLowerCase()] ?? DEFAULT_OWNER_LIMIT,
                orders: ordersProfileMap,
                lastIndex: 0,
            });
            orderbooksOwnersProfileMap.set(orderbook, ownerProfileMap);
        }
    }
    if (span) {
        for (const orderbook in changes) {
            span.setAttribute(`orderbooksChanges.${orderbook}.addedOrders`, changes[orderbook]);
        }
    }
}

/**
 * Handles new removed orders fetched from sg to the owner profile map
 */
export async function handleRemoveOrderbookOwnersProfileMap(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    ordersDetails: SgOrder[],
    span?: Span,
) {
    const changes: Record<string, string[]> = {};
    for (let i = 0; i < ordersDetails.length; i++) {
        const orderDetails = ordersDetails[i];
        const orderbook = orderDetails.orderbook.id.toLowerCase();
        const orderStruct = toOrder(
            decodeAbiParameters(OrderV3Abi, orderDetails.orderBytes as `0x${string}`)[0],
        );
        if (span) {
            if (!changes[orderbook]) changes[orderbook] = [];
            if (!changes[orderbook].includes(orderDetails.orderHash.toLowerCase())) {
                changes[orderbook].push(orderDetails.orderHash.toLowerCase());
            }
        }
        const orderbookOwnerProfileItem = orderbooksOwnersProfileMap.get(orderbook);
        if (orderbookOwnerProfileItem) {
            const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner.toLowerCase());
            if (ownerProfile) {
                ownerProfile.orders.delete(orderDetails.orderHash.toLowerCase());
            }
        }
    }
    if (span) {
        for (const orderbook in changes) {
            span.setAttribute(`orderbooksChanges.${orderbook}.removedOrders`, changes[orderbook]);
        }
    }
}

/**
 * Get a map of per owner orders per orderbook
 * @param ordersDetails - Order details queried from subgraph
 */
export async function getOrderbookOwnersProfileMapFromSg(
    ordersDetails: SgOrder[],
    viemClient: ViemClient,
    tokens: TokenDetails[],
    ownerLimits?: Record<string, number>,
): Promise<OrderbooksOwnersProfileMap> {
    const orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap = new Map();
    await handleAddOrderbookOwnersProfileMap(
        orderbooksOwnersProfileMap,
        ordersDetails,
        viemClient,
        tokens,
        ownerLimits,
    );
    return orderbooksOwnersProfileMap;
}

/**
 * Prepares an array of orders for a arb round by following owners limits
 * @param orderbooksOwnersProfileMap - The orderbooks owners orders map
 * @param shuffle - (optional) Shuffle the order of items
 */
export function prepareOrdersForRound(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    shuffle = true,
): BundledOrders[][] {
    const result: BundledOrders[][] = [];
    for (const [orderbook, ownersProfileMap] of orderbooksOwnersProfileMap) {
        const orderbookBundledOrders: BundledOrders[] = [];
        for (const [, ownerProfile] of ownersProfileMap) {
            let remainingLimit = ownerProfile.limit;
            // consume orders limits
            const allOrders: Pair[] = [];
            ownerProfile.orders.forEach((v) => allOrders.push(...v.takeOrders));
            const consumingOrders = allOrders.splice(ownerProfile.lastIndex, remainingLimit);
            remainingLimit -= consumingOrders.length;
            ownerProfile.lastIndex += consumingOrders.length;
            if (remainingLimit) {
                ownerProfile.lastIndex = 0;
                const remainingConsumingOrders = allOrders.splice(0, remainingLimit);
                ownerProfile.lastIndex += remainingConsumingOrders.length;
                consumingOrders.push(...remainingConsumingOrders);
            }
            for (const order of consumingOrders) {
                gatherPairs(orderbook, order.takeOrder.id, [order], orderbookBundledOrders);
            }
        }
        if (shuffle) {
            // shuffle orders
            for (const bundledOrders of orderbookBundledOrders) {
                shuffleArray(bundledOrders.takeOrders);
            }
            // shuffle pairs
            shuffleArray(orderbookBundledOrders);
        }
        result.push(orderbookBundledOrders);
    }
    if (shuffle) {
        // shuffle orderbooks
        shuffleArray(result);
    }
    return result;
}

/**
 * Gathers owners orders by token pair
 */
function gatherPairs(
    orderbook: string,
    orderHash: string,
    pairs: Pair[],
    bundledOrders: BundledOrders[],
) {
    for (const pair of pairs) {
        const bundleOrder = bundledOrders.find(
            (v) =>
                v.buyToken.toLowerCase() === pair.buyToken.toLowerCase() &&
                v.sellToken.toLowerCase() === pair.sellToken.toLowerCase(),
        );
        if (bundleOrder) {
            // make sure to not duplicate
            if (
                !bundleOrder.takeOrders.find((v) => v.id.toLowerCase() === orderHash.toLowerCase())
            ) {
                bundleOrder.takeOrders.push(pair.takeOrder);
            }
        } else {
            bundledOrders.push({
                orderbook,
                buyToken: pair.buyToken,
                buyTokenDecimals: pair.buyTokenDecimals,
                buyTokenSymbol: pair.buyTokenSymbol,
                sellToken: pair.sellToken,
                sellTokenDecimals: pair.sellTokenDecimals,
                sellTokenSymbol: pair.sellTokenSymbol,
                takeOrders: [pair.takeOrder],
            });
        }
    }
}

/**
 * Builds a map with following form from an `OrderbooksOwnersProfileMap` instance:
 * `orderbook -> token -> owner -> vaults` called `OTOVMap`
 * This is later on used to evaluate the owners limits
 */
export function buildOtovMap(orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap): OTOVMap {
    const result: OTOVMap = new Map();
    orderbooksOwnersProfileMap.forEach((ownersProfileMap, orderbook) => {
        const tokensOwnersVaults: TokensOwnersVaults = new Map();
        ownersProfileMap.forEach((ownerProfile, owner) => {
            ownerProfile.orders.forEach((orderProfile) => {
                orderProfile.takeOrders.forEach((pair) => {
                    const token = pair.sellToken.toLowerCase();
                    const vaultId =
                        pair.takeOrder.takeOrder.order.validOutputs[
                            pair.takeOrder.takeOrder.outputIOIndex
                        ].vaultId.toLowerCase();
                    const ownersVaults = tokensOwnersVaults.get(token);
                    if (ownersVaults) {
                        const vaults = ownersVaults.get(owner.toLowerCase());
                        if (vaults) {
                            if (!vaults.find((v) => v.vaultId === vaultId))
                                vaults.push({ vaultId, balance: 0n });
                        } else {
                            ownersVaults.set(owner.toLowerCase(), [{ vaultId, balance: 0n }]);
                        }
                    } else {
                        const newOwnersVaults: OwnersVaults = new Map();
                        newOwnersVaults.set(owner.toLowerCase(), [{ vaultId, balance: 0n }]);
                        tokensOwnersVaults.set(token, newOwnersVaults);
                    }
                });
            });
        });
        result.set(orderbook, tokensOwnersVaults);
    });
    return result;
}

/**
 * Gets vault balances of an owner's vaults of a given token
 */
export async function fetchVaultBalances(
    orderbook: string,
    token: string,
    owner: string,
    vaults: Vault[],
    viemClient: ViemClient,
    multicallAddressOverride?: string,
) {
    const multicallResult = await viemClient.multicall({
        multicallAddress:
            (multicallAddressOverride as `0x${string}` | undefined) ??
            viemClient.chain?.contracts?.multicall3?.address,
        allowFailure: false,
        contracts: vaults.map((v) => ({
            address: orderbook as `0x${string}`,
            allowFailure: false,
            chainId: viemClient.chain!.id,
            abi: VaultBalanceAbi,
            functionName: "vaultBalance",
            args: [owner, token, v.vaultId],
        })),
    });

    for (let i = 0; i < multicallResult.length; i++) {
        vaults[i].balance = multicallResult[i];
    }
}

/**
 * Evaluates the owners limits by checking an owner vaults avg balances of a token against
 * other owners total balances of that token to calculate a percentage, repeats the same
 * process for every other token and owner and at the end ends up with map of owners with array
 * of percentages, then calculates an avg of all those percenatges and that is applied as a divider
 * factor to the owner's limit.
 * This ensures that if an owner has many orders/vaults and has spread their balances across those
 * many vaults and orders, he/she will get limited.
 * Owners limits that are set by bot's admin as env or cli arg, are exluded from this evaluation process
 */
export async function evaluateOwnersLimits(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    otovMap: OTOVMap,
    viemClient: ViemClient,
    ownerLimits?: Record<string, number>,
    multicallAddressOverride?: string,
) {
    for (const [orderbook, tokensOwnersVaults] of otovMap) {
        const ownersProfileMap = orderbooksOwnersProfileMap.get(orderbook);
        if (ownersProfileMap) {
            const ownersCuts: Map<string, number[]> = new Map();
            for (const [token, ownersVaults] of tokensOwnersVaults) {
                const obTokenBalance = await viemClient.readContract({
                    address: token as `0x${string}`,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [orderbook as `0x${string}`],
                });
                for (const [owner, vaults] of ownersVaults) {
                    // skip if owner limit is set by bot admin
                    if (typeof ownerLimits?.[owner.toLowerCase()] === "number") continue;

                    const ownerProfile = ownersProfileMap.get(owner);
                    if (ownerProfile) {
                        await fetchVaultBalances(
                            orderbook,
                            token,
                            owner,
                            vaults,
                            viemClient,
                            multicallAddressOverride,
                        );
                        const ownerTotalBalance = vaults.reduce(
                            (a, b) => ({
                                balance: a.balance + b.balance,
                            }),
                            {
                                balance: 0n,
                            },
                        ).balance;
                        const avgBalance = ownerTotalBalance / BigInt(vaults.length);
                        const otherOwnersBalances = obTokenBalance - ownerTotalBalance;
                        const balanceRatioPercent =
                            otherOwnersBalances === 0n
                                ? 100n
                                : (avgBalance * 100n) / otherOwnersBalances;

                        // divide into 4 segments
                        let ownerEvalDivideFactor = 1;
                        if (balanceRatioPercent >= 75n) {
                            ownerEvalDivideFactor = 1;
                        } else if (balanceRatioPercent >= 50n && balanceRatioPercent < 75n) {
                            ownerEvalDivideFactor = 2;
                        } else if (balanceRatioPercent >= 25n && balanceRatioPercent < 50n) {
                            ownerEvalDivideFactor = 3;
                        } else if (balanceRatioPercent > 0n && balanceRatioPercent < 25n) {
                            ownerEvalDivideFactor = 4;
                        }

                        // gather owner divide factor for all of the owner's orders' tokens
                        // to calculate an avg from them all later on
                        const cuts = ownersCuts.get(owner.toLowerCase());
                        if (cuts) {
                            cuts.push(ownerEvalDivideFactor);
                        } else {
                            ownersCuts.set(owner.toLowerCase(), [ownerEvalDivideFactor]);
                        }
                    }
                }
            }

            ownersProfileMap.forEach((ownerProfile, owner) => {
                const cuts = ownersCuts.get(owner);
                if (cuts?.length) {
                    const avgCut = cuts.reduce((a, b) => a + b, 0) / cuts.length;
                    // round to nearest int, if turned out 0, set it to 1 as minimum
                    ownerProfile.limit = Math.round(ownerProfile.limit / avgCut);
                    if (ownerProfile.limit === 0) ownerProfile.limit = 1;
                }
            });
        }
    }
}

/**
 * This is a wrapper fn around evaluating owers limits.
 * Provides a protection by evaluating and possibly reducing owner's limit,
 * this takes place by checking an owners avg vault balance of a token against
 * all other owners cumulative balances, the calculated ratio is used a reducing
 * factor for the owner limit when averaged out for all of tokens the owner has
 */
export async function downscaleProtection(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    viemClient: ViemClient,
    ownerLimits?: Record<string, number>,
    reset = true,
    multicallAddressOverride?: string,
) {
    if (reset) {
        resetLimits(orderbooksOwnersProfileMap, ownerLimits);
    }
    const otovMap = buildOtovMap(orderbooksOwnersProfileMap);
    await evaluateOwnersLimits(
        orderbooksOwnersProfileMap,
        otovMap,
        viemClient,
        ownerLimits,
        multicallAddressOverride,
    );
}

/**
 * Resets owners limit to default value
 */
export async function resetLimits(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    ownerLimits?: Record<string, number>,
) {
    orderbooksOwnersProfileMap.forEach((ownersProfileMap) => {
        if (ownersProfileMap) {
            ownersProfileMap.forEach((ownerProfile, owner) => {
                // skip if owner limit is set by bot admin
                if (typeof ownerLimits?.[owner.toLowerCase()] === "number") return;
                ownerProfile.limit = DEFAULT_OWNER_LIMIT;
            });
        }
    });
}

/**
 * Gets all distinct tokens of all the orders' IOs from a subgraph query,
 * used to to keep a cache of known tokens at runtime to not fetch their
 * details everytime with onchain calls
 */
export function getOrdersTokens(ordersDetails: SgOrder[]): TokenDetails[] {
    const tokens: TokenDetails[] = [];
    for (let i = 0; i < ordersDetails.length; i++) {
        const orderDetails = ordersDetails[i];
        const orderStruct = toOrder(
            decodeAbiParameters(OrderV3Abi, orderDetails.orderBytes as `0x${string}`)[0],
        );

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
 * Quotes a single order
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrder(
    orderDetails: BundledOrders,
    viemClient: ViemClient,
    gas?: bigint,
    blockNumber?: bigint,
) {
    const { data } = await viemClient.call({
        to: orderDetails.orderbook as `0x${string}`,
        data: encodeFunctionData({
            abi: OrderbookQuoteAbi,
            functionName: "quote",
            args: [getQuoteConfig(orderDetails.takeOrders[0])],
        }),
        blockNumber,
        gas,
    });
    if (typeof data !== "undefined") {
        const quoteResult = decodeFunctionResult({
            abi: OrderbookQuoteAbi,
            functionName: "quote",
            data,
        });
        orderDetails.takeOrders[0].quote = {
            maxOutput: ethers.BigNumber.from(quoteResult[1]),
            ratio: ethers.BigNumber.from(quoteResult[2]),
        };
        return;
    } else {
        return Promise.reject(`Failed to quote order, reason: reqtured no data`);
    }
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
                abi: erc20Abi,
                functionName: "symbol",
            });
        } catch {
            await sleep(5_000);
        }
    }
    return "UnknownSymbol";
}
