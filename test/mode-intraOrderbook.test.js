const { assert } = require("chai");
const testData = require("./data");
const { ethers } = require("ethers");
const { errorSnapshot } = require("../src/error");
const { clone, estimateProfit } = require("../src/utils");
const { getWithdrawEnsureBytecode } = require("../src/config");
const { dryrun, findOpp } = require("../src/modes/intraOrderbook");

// mocking signer and dataFetcher
let signer = {};
const viemClient = {
    getBlockNumber: async () => BigInt(oppBlockNumber),
    call: async () => ({ data: ethers.BigNumber.from("1000000000000000000").toHexString() }),
    readContract: async () => 1000000000000000000n,
};

const oppBlockNumber = 123456;
const {
    inputToEthPrice,
    outputToEthPrice,
    gasPrice,
    gasLimitEstimation,
    orderPairObject1: orderPairObject,
    config,
    orderbooksOrders: orderbooksOrdersTemp,
    orderbook,
} = testData;
const orderbooksOrders = clone(orderbooksOrdersTemp);
orderbooksOrders[0][0].orderbook = orderPairObject.orderbook;

describe("Test intra-orderbook dryrun", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
    });
    const inputBalance = ethers.BigNumber.from("1000000000000000000");
    const outputBalance = ethers.BigNumber.from("1000000");

    it("should succeed", async function () {
        const result = await dryrun({
            orderPairObject,
            opposingOrder: orderbooksOrders[0][0].takeOrders[0],
            signer,
            gasPrice,
            inputToEthPrice,
            outputToEthPrice,
            config,
            viemClient,
            inputBalance,
            outputBalance,
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
            orderbooksOrders[0][0].takeOrders[0].takeOrder.order,
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
                    orderbooksOrders[0][0].takeOrders[0],
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should fail with no opp", async function () {
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await dryrun({
                orderPairObject,
                opposingOrder: orderbooksOrders[0][0].takeOrders[0],
                signer,
                gasPrice,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                inputBalance,
                outputBalance,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: undefined,
                spanAttributes: {
                    blockNumber: oppBlockNumber,
                    error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                },
            };
            assert.deepEqual(error.value, expected.value);
            assert.deepEqual(error.reason, expected.reason);
            assert.deepEqual(error.spanAttributes.blockNumber, expected.spanAttributes.blockNumber);
            assert.deepEqual(error.spanAttributes.error, expected.spanAttributes.error);
        }
    });
});

describe("Test intra-orderbook find opp", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
    });
    const balance = ethers.BigNumber.from("1000000000000000000");
    const balance2 = ethers.BigNumber.from("1000000000000000000000000000000");

    it("should find opp", async function () {
        const result = await findOpp({
            orderPairObject,
            signer,
            gasPrice,
            inputToEthPrice,
            outputToEthPrice,
            config,
            viemClient,
            orderbooksOrders,
        });
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getWithdrawEnsureBytecode(
                    signer.account.address,
                    orderPairObject.buyToken,
                    orderPairObject.sellToken,
                    balance2,
                    balance,
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
            orderbooksOrders[0][0].takeOrders[0].takeOrder.order,
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
                    orderbooksOrders[0][0].takeOrders[0],
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        const err = ethers.errors.UNPREDICTABLE_GAS_LIMIT;
        signer.estimateGas = async () => {
            return Promise.reject(err);
        };
        try {
            await findOpp({
                orderPairObject,
                signer,
                gasPrice,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                orderbooksOrders,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const balance = ethers.BigNumber.from("1000000000000000000");
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
                [
                    {
                        evaluable: {
                            interpreter:
                                orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                            store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                            bytecode: getWithdrawEnsureBytecode(
                                signer.account.address,
                                orderPairObject.buyToken,
                                orderPairObject.sellToken,
                                balance2,
                                balance,
                                ethers.utils.parseUnits(inputToEthPrice),
                                ethers.utils.parseUnits(outputToEthPrice),
                                ethers.constants.Zero,
                                signer.account.address,
                            ),
                        },
                        signedContext: [],
                    },
                ],
            ]);
            const clear2Calldata = orderbook.interface.encodeFunctionData("clear2", [
                orderPairObject.takeOrders[0].takeOrder.order,
                orderbooksOrders[0][0].takeOrders[0].takeOrder.order,
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
            const rawtx = {
                data: orderbook.interface.encodeFunctionData("multicall", [
                    [clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata],
                ]),
                to: orderPairObject.orderbook,
                gasPrice,
                from: signer.account.address,
            };
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: undefined,
                spanAttributes: {
                    intraOrderbook: [
                        JSON.stringify({
                            blockNumber: oppBlockNumber,
                            stage: 1,
                            isNodeError: false,
                            error: errorSnapshot("", err),
                            rawtx: JSON.stringify(rawtx),
                        }),
                    ],
                    // "intraOrderbook.0.blockNumber": oppBlockNumber,
                    // "intraOrderbook.0.stage": 1,
                    // "intraOrderbook.0.isNodeError": false,
                    // "intraOrderbook.0.error": errorSnapshot("", err),
                    // "intraOrderbook.0.rawtx": JSON.stringify(rawtx),
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});
