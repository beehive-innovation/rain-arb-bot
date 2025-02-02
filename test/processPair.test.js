const { assert } = require("chai");
const fixtures = require("./data");
const mockServer = require("mockttp").getLocal();
const { encodeQuoteResponse } = require("./utils");
const { clone, estimateProfit } = require("../src/utils");
const {
    ethers,
    utils: { formatUnits },
} = require("ethers");
const {
    processPair,
    ProcessPairHaltReason,
    ProcessPairReportStatus,
} = require("../src/processOrders");

describe("Test process pair", async function () {
    // mock dataFecther, ethers signer and viem client
    let dataFetcher = {};
    let signer = {};
    let viemClient = {};

    const {
        gasPrice,
        gasLimitEstimation,
        arb,
        vaultBalance,
        orderPairObject1: orderPairObject,
        config: fixtureConfig,
        poolCodeMap,
        expectedRouteVisual,
        pair,
        orderbook,
        txHash,
        effectiveGasPrice,
        gasUsed,
        scannerUrl,
        getCurrentPrice,
        expectedRouteData,
        getCurrentInputToEthPrice,
        orderbooksOrders,
        getAmountOut,
    } = fixtures;
    const config = JSON.parse(JSON.stringify(fixtureConfig));
    config.rpc = ["http://localhost:8082/rpc"];
    const quoteResponse = encodeQuoteResponse([[true, vaultBalance, ethers.constants.Zero]]);
    const state = {
        gasPrice: gasPrice.mul(107).div(100).toBigInt(),
    };

    beforeEach(() => {
        mockServer.start(8082);
        config.gasCoveragePercentage = "0";
        signer = {
            account: { address: "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb" },
            BALANCE: ethers.BigNumber.from(0),
            BOUNTY: [],
            getAddress: () => "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb",
            getBlockNumber: async () => 123456,
            getGasPrice: async () => gasPrice.toBigInt(),
            estimateGas: async () => gasLimitEstimation.toBigInt(),
            sendTransaction: async () => txHash,
            sendTx: async () => txHash,
            getTransactionCount: async () => 0,
            waitForTransactionReceipt: async () => {
                return {
                    status: "success",
                    effectiveGasPrice,
                    gasUsed,
                    logs: [],
                    events: [],
                };
            },
        };
        dataFetcher = {
            fetchPoolsForToken: async () => {},
            fetchedPairPools: [],
        };
        viemClient = {
            chain: { id: 137 },
            multicall: async () => [vaultBalance.toBigInt()],
            getGasPrice: async () => gasPrice.toBigInt(),
            getBlockNumber: async () => 123456n,
            getTransactionCount: async () => 0,
            waitForTransactionReceipt: async () => {
                return {
                    status: "success",
                    effectiveGasPrice,
                    gasUsed,
                    logs: [],
                    events: [],
                };
            },
        };
        config.dataFetcher = {
            getCurrentPoolCodeMap: () => {
                return poolCodeMap;
            },
        };
    });
    afterEach(() => mockServer.stop());

    it("should process pair successfully from RP", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await (
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
                orderbooksOrders,
                state,
            })
        )();
        const expected = {
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                income: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
            },
            reason: undefined,
            error: undefined,
            gasCost: gasPrice.mul(gasUsed),
            spanAttributes: {
                "details.blockNumber": 123456,
                "details.blockNumberDiff": 0,
                "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                "details.amountIn": formatUnits(vaultBalance),
                "details.amountOut": formatUnits(getAmountOut(vaultBalance), 6),
                "details.marketQuote.num": 0.99699,
                "details.marketQuote.str": "0.99699",
                oppBlockNumber: 123456,
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.route": expectedRouteVisual,
                "details.txUrl": scannerUrl + "/tx/" + txHash,
                "details.pair": pair,
                "details.gasPrice": gasPrice.mul(107).div(100).toString(),
                "details.actualGasCost": Number(formatUnits(effectiveGasPrice.mul(gasUsed))),
                foundOpp: true,
                didClear: true,
                "details.inputToEthPrice": formatUnits(getCurrentInputToEthPrice()),
                "details.outputToEthPrice": "1",
                "details.clearModePick": "rp4",
                "details.quote": JSON.stringify({
                    maxOutput: formatUnits(vaultBalance),
                    ratio: formatUnits(ethers.constants.Zero),
                }),
                "details.estimatedProfit": formatUnits(
                    estimateProfit(
                        orderPairObject,
                        getCurrentInputToEthPrice(),
                        ethers.utils.parseUnits("1"),
                        undefined,
                        getCurrentPrice(vaultBalance),
                        vaultBalance,
                    ),
                ),
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should process pair successfully from inter-orderbook", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        let count = 0;
        dataFetcher.getCurrentPoolCodeMap = () => {
            if (count < 1) {
                count++;
                return poolCodeMap;
            } else return new Map();
        };
        const result = await (
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                arb,
                genericArb: arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
                orderbooksOrders,
                state,
            })
        )();
        const expected = {
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                income: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
            },
            reason: undefined,
            error: undefined,
            gasCost: gasPrice.mul(gasUsed),
            spanAttributes: {
                "details.blockNumber": 123456,
                "details.blockNumberDiff": 0,
                "details.maxInput": vaultBalance.toString(),
                oppBlockNumber: 123456,
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.txUrl": scannerUrl + "/tx/" + txHash,
                "details.pair": pair,
                "details.gasPrice": gasPrice.mul(107).div(100).toString(),
                "details.actualGasCost": Number(formatUnits(effectiveGasPrice.mul(gasUsed))),
                foundOpp: true,
                didClear: true,
                "details.marketQuote.num": 0.99699,
                "details.marketQuote.str": "0.99699",
                "details.inputToEthPrice": formatUnits(getCurrentInputToEthPrice()),
                "details.outputToEthPrice": "1",
                "details.clearModePick": "inter",
                "details.quote": JSON.stringify({
                    maxOutput: formatUnits(vaultBalance),
                    ratio: formatUnits(ethers.constants.Zero),
                }),
                "details.estimatedProfit": formatUnits(
                    estimateProfit(
                        orderPairObject,
                        getCurrentInputToEthPrice(),
                        ethers.utils.parseUnits("1"),
                        orderbooksOrders[0][0],
                        undefined,
                        vaultBalance,
                    ),
                ),
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should have no output", async function () {
        // set quote max output to zero
        await mockServer
            .forPost("/rpc")
            .thenSendJsonRpcResult(
                encodeQuoteResponse([[true, ethers.constants.Zero, ethers.constants.Zero]]),
            );
        const orderPairObjectCopy = clone(orderPairObject);
        const result = await (
            await processPair({
                config,
                orderPairObject: orderPairObjectCopy,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
                state,
            })
        )();
        const expected = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            report: {
                status: ProcessPairReportStatus.ZeroOutput,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
            spanAttributes: {
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.pair": pair,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should fail to quote order", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcError();
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.NoOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                },
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToQuote,
                error: 'Execution reverted with unknown error. Data: "" ',
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to get eth price", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        config.gasCoveragePercentage = "100";
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.NoOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                },
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToGetEthPrice,
                error: "no-route",
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.marketQuote.num": 0.99699,
                    "details.marketQuote.str": "0.99699",
                    "details.quote": JSON.stringify({
                        maxOutput: formatUnits(vaultBalance),
                        ratio: formatUnits(ethers.constants.Zero),
                    }),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to get pools", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = { code: ethers.errors.CALL_EXCEPTION };
        dataFetcher.fetchPoolsForToken = () => {
            return Promise.reject(evmError);
        };
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.NoOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                },
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToGetPools,
                error: evmError,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.quote": JSON.stringify({
                        maxOutput: formatUnits(vaultBalance),
                        ratio: formatUnits(ethers.constants.Zero),
                    }),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail tx", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = { code: ethers.errors.CALL_EXCEPTION };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTx = async () => {
            return Promise.reject(evmError);
        };
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
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
                    bytecode: "0x",
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
                gasPrice: gasPrice.mul(107).div(100).toString(),
                gas: gasLimitEstimation.toString(),
                from: signer.account.address,
            };
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                },
                reason: ProcessPairHaltReason.TxFailed,
                gasCost: undefined,
                error: evmError,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.mul(107).div(100).toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.amountIn": formatUnits(vaultBalance),
                    "details.amountOut": formatUnits(getAmountOut(vaultBalance), 6),
                    oppBlockNumber: 123456,
                    "details.route": expectedRouteVisual,
                    foundOpp: true,
                    "details.rawTx": JSON.stringify(rawtx),
                    "details.inputToEthPrice": formatUnits(getCurrentInputToEthPrice()),
                    "details.outputToEthPrice": "1",
                    "details.marketQuote.num": 0.99699,
                    "details.marketQuote.str": "0.99699",
                    "details.clearModePick": "rp4",
                    txNoneNodeError: true,
                    "details.quote": JSON.stringify({
                        maxOutput: formatUnits(vaultBalance),
                        ratio: formatUnits(ethers.constants.Zero),
                    }),
                    "details.estimatedProfit": formatUnits(
                        estimateProfit(
                            orderPairObject,
                            getCurrentInputToEthPrice(),
                            ethers.utils.parseUnits("1"),
                            undefined,
                            getCurrentPrice(vaultBalance),
                            vaultBalance,
                        ),
                    ),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should revert tx", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const errorReceipt = {
            status: "reverted",
            code: ethers.errors.CALL_EXCEPTION,
            gasUsed,
            effectiveGasPrice,
        };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTx = async () => txHash;
        viemClient.waitForTransactionReceipt = async () => errorReceipt;
        viemClient.getTransaction = async () => ({});
        viemClient.call = async () => Promise.reject("out of gas");
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    txUrl: scannerUrl + "/tx/" + txHash,
                    actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                },
                reason: ProcessPairHaltReason.TxReverted,
                error: {
                    err: "transaction reverted onchain, account ran out of gas for transaction gas cost",
                    nodeError: false,
                    snapshot:
                        "transaction reverted onchain, account ran out of gas for transaction gas cost",
                },
                gasCost: undefined,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.mul(107).div(100).toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.amountIn": formatUnits(vaultBalance),
                    "details.amountOut": formatUnits(getAmountOut(vaultBalance), 6),
                    oppBlockNumber: 123456,
                    "details.route": expectedRouteVisual,
                    foundOpp: true,
                    "details.txUrl": scannerUrl + "/tx/" + txHash,
                    "details.inputToEthPrice": formatUnits(getCurrentInputToEthPrice()),
                    "details.outputToEthPrice": "1",
                    "details.marketQuote.num": 0.99699,
                    "details.marketQuote.str": "0.99699",
                    "details.clearModePick": "rp4",
                    txNoneNodeError: true,
                    "details.quote": JSON.stringify({
                        maxOutput: formatUnits(vaultBalance),
                        ratio: formatUnits(ethers.constants.Zero),
                    }),
                    "details.estimatedProfit": formatUnits(
                        estimateProfit(
                            orderPairObject,
                            getCurrentInputToEthPrice(),
                            ethers.utils.parseUnits("1"),
                            undefined,
                            getCurrentPrice(vaultBalance),
                            vaultBalance,
                        ),
                    ),
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to mine tx", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const errorRejection = new Error("timeout");
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTx = async () => txHash;
        viemClient.waitForTransactionReceipt = async () => Promise.reject(errorRejection);
        viemClient.getTransactionReceipt = async () => Promise.reject(errorRejection);
        try {
            await (
                await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    flashbotSigner: undefined,
                    arb,
                    orderbook,
                    pair,
                    mainAccount: signer,
                    accounts: [signer],
                    fetchedPairPools: [],
                    state,
                })
            )();
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
                    bytecode: "0x",
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
                gasPrice: gasPrice.mul(107).div(100).toString(),
                gas: gasLimitEstimation.toString(),
                from: signer.account.address,
            };
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    txUrl: scannerUrl + "/tx/" + txHash,
                },
                reason: ProcessPairHaltReason.TxMineFailed,
                error: errorRejection,
                gasCost: undefined,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.mul(107).div(100).toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.amountIn": formatUnits(vaultBalance),
                    "details.amountOut": formatUnits(getAmountOut(vaultBalance), 6),
                    oppBlockNumber: 123456,
                    "details.route": expectedRouteVisual,
                    foundOpp: true,
                    "details.rawTx": JSON.stringify(rawtx),
                    "details.txUrl": scannerUrl + "/tx/" + txHash,
                    "details.inputToEthPrice": formatUnits(getCurrentInputToEthPrice()),
                    "details.outputToEthPrice": "1",
                    "details.marketQuote.num": 0.99699,
                    "details.marketQuote.str": "0.99699",
                    "details.clearModePick": "rp4",
                    txNoneNodeError: true,
                    "details.quote": JSON.stringify({
                        maxOutput: formatUnits(vaultBalance),
                        ratio: formatUnits(ethers.constants.Zero),
                    }),
                    "details.estimatedProfit": formatUnits(
                        estimateProfit(
                            orderPairObject,
                            getCurrentInputToEthPrice(),
                            ethers.utils.parseUnits("1"),
                            undefined,
                            getCurrentPrice(vaultBalance),
                            vaultBalance,
                        ),
                    ),
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});
