const { assert } = require("chai");
const testData = require("./data");
const { errorSnapshot } = require("../src/error");
const { estimateProfit, clone } = require("../src/utils");
const {
    ethers,
    utils: { formatUnits },
} = require("ethers");
const { getBountyEnsureRainlang, parseRainlang } = require("../src/task");
const {
    dryrun,
    findOpp,
    findOppWithRetries,
    RouteProcessorDryrunHaltReason,
} = require("../src/modes/routeProcessor");

// mocking signer and dataFetcher
let signer = {};
let dataFetcher = {};
const viemClient = {
    getBlockNumber: async () => BigInt(oppBlockNumber),
    readContract: async () => "0x1234",
};

const oppBlockNumber = 123456;
const {
    inputToEthPrice: ethPrice,
    gasPrice,
    gasLimitEstimation,
    arb,
    vaultBalance,
    orderPairObject1: orderPairObject,
    fromToken,
    toToken,
    config,
    poolCodeMap,
    expectedRouteData,
    expectedRouteVisual,
    getCurrentPrice,
    getAmountOut,
} = testData;
config.viemClient = viemClient;

describe("Test route processor dryrun", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should succeed", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await dryrun({
            mode: 0,
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            maximumInput: vaultBalance,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
            knownInitGas: { value: undefined },
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: ethers.constants.MaxUint256,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        gasLimitEstimation.mul(gasPrice),
                        signer.account.address,
                    ),
                    viemClient,
                    config.dispair,
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should fail with no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await dryrun({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                maximumInput: vaultBalance,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
                knownInitGas: { value: undefined },
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: {
                    amountIn: formatUnits(vaultBalance),
                    route: "no-way",
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail with no opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await dryrun({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                maximumInput: vaultBalance,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
                knownInitGas: { value: undefined },
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: ethers.constants.MaxUint256,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter: config.dispair.interpreter,
                    store: config.dispair.store,
                    bytecode: await parseRainlang(
                        await getBountyEnsureRainlang(
                            ethers.utils.parseUnits(ethPrice),
                            ethers.constants.Zero,
                            ethers.constants.Zero,
                            signer.account.address,
                        ),
                        viemClient,
                        config.dispair,
                    ),
                },
                signedContext: [],
            };
            const rawtx = {
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            };
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                    amountIn: formatUnits(vaultBalance),
                    amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                    blockNumber: oppBlockNumber,
                    error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                    route: expectedRouteVisual,
                    stage: 1,
                    rawtx: JSON.stringify(rawtx),
                    isNodeError: false,
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});

describe("Test route processor find opp", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should find opp for full vault balance", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await findOpp({
            mode: 0,
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: ethers.constants.MaxUint256,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        gasLimitEstimation.mul(gasPrice),
                        signer.account.address,
                    ),
                    viemClient,
                    config.dispair,
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should find opp with binary search", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return gasLimitEstimation;
        };
        const orderPairObjectCopy = clone(orderPairObject);
        orderPairObjectCopy.takeOrders[0].quote.ratio = ethers.utils.parseUnits("0.009900695135");
        orderPairObjectCopy.takeOrders[0].quote.maxOutput = ethers.BigNumber.from(
            "1" + "0".repeat(25),
        );
        const result = await findOpp({
            mode: 0,
            orderPairObject: orderPairObjectCopy,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: ethers.utils.parseUnits("9999999.701976776123046875"),
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        gasLimitEstimation.mul(gasPrice),
                        signer.account.address,
                    ),
                    viemClient,
                    config.dispair,
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: ethers.utils.parseUnits("9999999.701976776123046875"),
                price: getCurrentPrice(ethers.utils.parseUnits("9999999.701976776123046875")),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObjectCopy,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    ethers.utils.parseUnits("0.009900695426163716"),
                    ethers.utils.parseUnits("9999999.701976776123046875"),
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: "9999999.701976776123046875",
                amountOut: "99006.951311",
                marketPrice: ethers.utils.formatUnits(
                    getCurrentPrice(ethers.utils.parseUnits("9999999.701976776123046875")),
                ),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await findOpp({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: ethers.constants.MaxUint256,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter: config.dispair.interpreter,
                    store: config.dispair.store,
                    bytecode: await parseRainlang(
                        await getBountyEnsureRainlang(
                            ethers.utils.parseUnits(ethPrice),
                            ethers.constants.Zero,
                            ethers.constants.Zero,
                            signer.account.address,
                        ),
                        viemClient,
                        config.dispair,
                    ),
                },
                signedContext: [],
            };
            const rawtx = JSON.stringify({
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            });
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    // full: `{"amountIn":"${formatUnits(vaultBalance)}","amountOut":"${formatUnits(getAmountOut(vaultBalance), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false,"error":${JSON.stringify(errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT))},"rawtx":${JSON.stringify(rawtx)}}`,
                    full: JSON.stringify({
                        amountIn: formatUnits(vaultBalance),
                        amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                        marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                        route: expectedRouteVisual,
                        blockNumber: oppBlockNumber,
                        stage: 1,
                        isNodeError: false,
                        error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                        rawtx: rawtx,
                    }),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should find no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await findOpp({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: {
                    // full: `{"amountIn":"${formatUnits(vaultBalance)}","route":"no-way"}`,
                    full: JSON.stringify({
                        amountIn: formatUnits(vaultBalance),
                        route: "no-way",
                    }),
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});

describe("Test find opp with retries", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should find opp with 2 retries", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        let rejectFirst = true;
        signer.estimateGas = async () => {
            if (rejectFirst) {
                rejectFirst = false;
                return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
            } else return gasLimitEstimation;
        };
        const result = await findOppWithRetries({
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: ethers.constants.MaxUint256,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [
                orderPairObject.takeOrders[0].takeOrder,
                orderPairObject.takeOrders[0].takeOrder,
            ],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        gasLimitEstimation.mul(gasPrice),
                        signer.account.address,
                    ),
                    viemClient,
                    config.dispair,
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await findOppWithRetries({
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: ethers.constants.MaxUint256,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter: config.dispair.interpreter,
                    store: config.dispair.store,
                    bytecode: await parseRainlang(
                        await getBountyEnsureRainlang(
                            ethers.utils.parseUnits(ethPrice),
                            ethers.constants.Zero,
                            ethers.constants.Zero,
                            signer.account.address,
                        ),
                        viemClient,
                        config.dispair,
                    ),
                },
                signedContext: [],
            };
            const rawtx = JSON.stringify({
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            });
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    // full: `{"amountIn":"${formatUnits(vaultBalance)}","amountOut":"${formatUnits(getAmountOut(vaultBalance), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false,"error":${JSON.stringify(errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT))},"rawtx":${JSON.stringify(rawtx)}}`,
                    full: JSON.stringify({
                        amountIn: formatUnits(vaultBalance),
                        amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                        marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                        route: expectedRouteVisual,
                        blockNumber: oppBlockNumber,
                        stage: 1,
                        isNodeError: false,
                        error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                        rawtx: rawtx,
                    }),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should find no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await findOppWithRetries({
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: { route: "no-way" },
            };
            assert.deepEqual(error, expected);
        }
    });
});
