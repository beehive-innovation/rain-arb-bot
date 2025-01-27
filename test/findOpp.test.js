const { assert } = require("chai");
const testData = require("./data");
const { findOpp } = require("../src/modes");
const { orderbookAbi } = require("../src/abis");
const { errorSnapshot } = require("../src/error");
const { clone, estimateProfit, withBigintSerializer } = require("../src/utils");
const {
    ethers,
    utils: { formatUnits },
} = require("ethers");
const { getBountyEnsureBytecode, getWithdrawEnsureBytecode } = require("../src/config");

// mocking signer and dataFetcher
let signer = {};
let dataFetcher = {};
const viemClient = {
    getBlockNumber: async () => BigInt(oppBlockNumber),
    call: async () => ({ data: ethers.BigNumber.from("1000000000000000000").toHexString() }),
    readContract: async () => 1000000000000000000n,
};

const oppBlockNumber = 123456;
const {
    inputToEthPrice,
    outputToEthPrice,
    gasPrice: _gasPrice,
    gasLimitEstimation,
    arb,
    vaultBalance,
    orderPairObject1: orderPairObject,
    config,
    opposingOrderPairObject,
    orderbooksOrders,
    opposingOrderbookAddress,
    fromToken,
    toToken,
    poolCodeMap,
    expectedRouteData,
    expectedRouteVisual,
    getCurrentPrice,
    orderbook,
    getAmountOut,
} = testData;
const gasPrice = _gasPrice.toBigInt();

describe("Test find opp", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation.toBigInt(),
            getBalance: async () => 0n,
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should find opp from RP", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb: undefined,
            fromToken,
            toToken,
            signer,
            gasPrice,
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders,
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
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.constants.Zero,
                    gasLimitEstimation.mul(gasPrice),
                    signer.account.address,
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
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
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
                clearModePick: "rp4",
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should find opp from inter-orderbook", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb: arb,
            fromToken,
            toToken,
            signer,
            gasPrice,
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders,
        });
        const opposingMaxInput = vaultBalance
            .mul(orderPairObject.takeOrders[0].quote.ratio)
            .div(`1${"0".repeat(36 - orderPairObject.buyTokenDecimals)}`);
        const opposingMaxIORatio = ethers.BigNumber.from(`1${"0".repeat(36)}`).div(
            orderPairObject.takeOrders[0].quote.ratio,
        );
        const obInterface = new ethers.utils.Interface(orderbookAbi);
        const encodedFN = obInterface.encodeFunctionData("takeOrders2", [
            {
                minimumInput: ethers.constants.One,
                maximumInput: opposingMaxInput,
                maximumIORatio: opposingMaxIORatio,
                orders: opposingOrderPairObject.takeOrders.map((v) => v.takeOrder),
                data: "0x",
            },
        ]);
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: ethers.constants.MaxUint256,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "bytes"],
                [opposingOrderPairObject.orderbook, opposingOrderPairObject.orderbook, encodedFN],
            ),
        };
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    gasLimitEstimation.mul(gasPrice),
                    signer.account.address,
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
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    opposingOrderPairObject,
                    undefined,
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                maxInput: vaultBalance.toString(),
                clearModePick: "inter",
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should find opp from intra-orderbook", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        const orderbooksOrdersTemp = clone(orderbooksOrders);
        orderbooksOrdersTemp[0][0].orderbook = orderPairObject.orderbook;
        const inputBalance = ethers.BigNumber.from("1000000000000000000000000000000");
        const outputBalance = ethers.BigNumber.from("1000000000000000000");
        const result = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb: arb,
            fromToken,
            toToken,
            signer,
            gasPrice,
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders: orderbooksOrdersTemp,
        });
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getWithdrawEnsureBytecode(
                    signer.account.address,
                    orderPairObject.buyToken,
                    orderPairObject.sellToken,
                    inputBalance,
                    outputBalance,
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    gasLimitEstimation.mul(gasPrice),
                    signer.account.address,
                ),
            },
            signedContext: [],
        };
        const withdrawInputCalldata = orderbook.interface.encodeFunctionData("withdraw2", [
            orderPairObject.buyToken,
            "1",
            ethers.constants.MaxUint256,
            [],
        ]);
        const withdrawOutputCalldata = orderbook.interface.encodeFunctionData("withdraw2", [
            orderPairObject.sellToken,
            "1",
            ethers.constants.MaxUint256,
            [task],
        ]);
        const clear2Calldata = orderbook.interface.encodeFunctionData("clear2", [
            orderPairObject.takeOrders[0].takeOrder.order,
            orderbooksOrdersTemp[0][0].takeOrders[0].takeOrder.order,
            {
                aliceInputIOIndex: orderPairObject.takeOrders[0].takeOrder.inputIOIndex,
                aliceOutputIOIndex: orderPairObject.takeOrders[0].takeOrder.outputIOIndex,
                bobInputIOIndex: orderbooksOrders[0][0].takeOrders[0].takeOrder.inputIOIndex,
                bobOutputIOIndex: orderbooksOrders[0][0].takeOrders[0].takeOrder.outputIOIndex,
                aliceBountyVaultId: "1",
                bobBountyVaultId: "1",
            },
            [],
            [],
        ]);
        const expected = {
            value: {
                rawtx: {
                    data: orderbook.interface.encodeFunctionData("multicall", [
                        [clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata],
                    ]),
                    to: orderPairObject.orderbook,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(inputToEthPrice),
                    ethers.utils.parseUnits(outputToEthPrice),
                    orderbooksOrdersTemp[0][0].takeOrders[0],
                    undefined,
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                clearModePick: "intra",
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        const err = ethers.errors.UNPREDICTABLE_GAS_LIMIT;
        signer.estimateGas = async () => {
            return Promise.reject(err);
        };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        try {
            await findOpp({
                orderPairObject,
                dataFetcher,
                arb,
                genericArb: arb,
                fromToken,
                toToken,
                signer,
                gasPrice,
                config,
                viemClient,
                inputToEthPrice,
                outputToEthPrice,
                orderbooksOrders,
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
                    interpreter:
                        orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: getBountyEnsureBytecode(
                        ethers.utils.parseUnits(inputToEthPrice),
                        ethers.constants.Zero,
                        ethers.constants.Zero,
                        signer.account.address,
                    ),
                },
                signedContext: [],
            };
            const rawtx = JSON.stringify(
                {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice: gasPrice,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            const opposingMaxInput = vaultBalance
                .mul(orderPairObject.takeOrders[0].quote.ratio)
                .div(`1${"0".repeat(36 - orderPairObject.buyTokenDecimals)}`);
            const opposingMaxIORatio = ethers.BigNumber.from(`1${"0".repeat(36)}`).div(
                orderPairObject.takeOrders[0].quote.ratio,
            );
            const obInterface = new ethers.utils.Interface(orderbookAbi);
            const encodedFN = obInterface.encodeFunctionData("takeOrders2", [
                {
                    minimumInput: ethers.constants.One,
                    maximumInput: opposingMaxInput,
                    maximumIORatio: opposingMaxIORatio,
                    orders: opposingOrderPairObject.takeOrders.map((v) => v.takeOrder),
                    data: "0x",
                },
            ]);
            const expectedTakeOrdersConfigStruct2 = {
                minimumInput: ethers.constants.One,
                maximumInput: ethers.constants.MaxUint256,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: ethers.utils.defaultAbiCoder.encode(
                    ["address", "address", "bytes"],
                    [
                        opposingOrderPairObject.orderbook,
                        opposingOrderPairObject.orderbook,
                        encodedFN,
                    ],
                ),
            };
            const task2 = {
                evaluable: {
                    interpreter:
                        orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: getBountyEnsureBytecode(
                        ethers.utils.parseUnits(inputToEthPrice),
                        ethers.utils.parseUnits(outputToEthPrice),
                        ethers.constants.Zero,
                        signer.account.address,
                    ),
                },
                signedContext: [],
            };
            const rawtx2 = {
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct2,
                    task2,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            };
            const expected = {
                rawtx: undefined,
                oppBlockNumber: undefined,
                noneNodeError: errorSnapshot("", err),
                spanAttributes: {
                    routeProcessor: JSON.stringify({
                        full: JSON.stringify({
                            amountIn: formatUnits(vaultBalance),
                            amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                            marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                            route: expectedRouteVisual,
                            blockNumber: oppBlockNumber,
                            stage: 1,
                            isNodeError: false,
                            error: errorSnapshot("", err),
                            rawtx: rawtx,
                        }),
                    }),
                    interOrderbook: JSON.stringify({
                        againstOrderbooks: JSON.stringify({
                            [opposingOrderbookAddress]: {
                                maxInput: vaultBalance.toString(),
                                blockNumber: oppBlockNumber,
                                stage: 1,
                                isNodeError: false,
                                error: errorSnapshot("", err),
                                rawtx: JSON.stringify(rawtx2, withBigintSerializer),
                            },
                        }),
                    }),
                    // // rp span attrs
                    // "routeProcessor.full.stage": 1,
                    // "routeProcessor.full.rawtx": rawtx,
                    // "routeProcessor.full.isNodeError": false,
                    // "routeProcessor.full.route": expectedRouteVisual,
                    // "routeProcessor.full.blockNumber": oppBlockNumber,
                    // "routeProcessor.full.error": errorSnapshot("", err),
                    // "routeProcessor.full.amountIn": formatUnits(vaultBalance),
                    // "routeProcessor.full.amountOut": formatUnits(getAmountOut(vaultBalance), 6),
                    // "routeProcessor.full.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),

                    // // inter-ob span attrs
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.stage`]: 1,
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.isNodeError`]: false,
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.blockNumber`]:
                    //     oppBlockNumber,
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.rawtx`]:
                    //     JSON.stringify(rawtx2, withBigintSerializer),
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.maxInput`]:
                    //     vaultBalance.toString(),
                    // [`interOrderbook.againstOrderbooks.${opposingOrderbookAddress}.error`]:
                    //     errorSnapshot("", err),
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});
