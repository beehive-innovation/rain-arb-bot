const { assert } = require("chai");
const testData = require("./data");
const { ethers } = require("ethers");
const { orderbookAbi } = require("../src/abis");
const { errorSnapshot } = require("../src/error");
const { estimateProfit } = require("../src/utils");
const { dryrun, findOpp } = require("../src/modes/interOrderbook");
const { getBountyEnsureRainlang, parseRainlang } = require("../src/task");

// mocking signer and dataFetcher
let signer = {};
const viemClient = {
    getBlockNumber: async () => BigInt(oppBlockNumber),
    readContract: async () => "0x1234",
};

const oppBlockNumber = 123456;
const {
    inputToEthPrice,
    outputToEthPrice,
    gasPrice,
    gasLimitEstimation,
    arb,
    vaultBalance,
    orderPairObject1: orderPairObject,
    config,
    opposingOrderPairObject,
    orderbooksOrders,
    opposingOrderbookAddress,
} = testData;
config.viemClient = viemClient;

describe("Test inter-orderbook dryrun", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
    });

    it("should succeed", async function () {
        const result = await dryrun({
            orderPairObject,
            opposingOrders: opposingOrderPairObject,
            signer,
            maximumInput: vaultBalance,
            gasPrice,
            arb,
            inputToEthPrice,
            outputToEthPrice,
            config,
            viemClient,
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
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(inputToEthPrice),
                        ethers.utils.parseUnits(outputToEthPrice),
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
                opposingOrders: opposingOrderPairObject,
                signer,
                maximumInput: vaultBalance,
                gasPrice,
                arb,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                knownInitGas: { value: undefined },
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
                    maxInput: vaultBalance.toString(),
                    blockNumber: oppBlockNumber,
                    error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                },
            };
            assert.deepEqual(error.value, expected.value);
            assert.deepEqual(error.reason, expected.reason);
            assert.deepEqual(error.spanAttributes.maxInput, expected.spanAttributes.maxInput);
            assert.deepEqual(error.spanAttributes.blockNumber, expected.spanAttributes.blockNumber);
            assert.deepEqual(error.spanAttributes.error, expected.spanAttributes.error);
        }
    });
});

describe("Test inter-orderbook find opp", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
    });

    it("should find opp", async function () {
        const result = await findOpp({
            orderPairObject,
            signer,
            gasPrice,
            arb,
            inputToEthPrice,
            outputToEthPrice,
            config,
            viemClient,
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
                interpreter: config.dispair.interpreter,
                store: config.dispair.store,
                bytecode: await parseRainlang(
                    await getBountyEnsureRainlang(
                        ethers.utils.parseUnits(inputToEthPrice),
                        ethers.utils.parseUnits(outputToEthPrice),
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
                arb,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                orderbooksOrders,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
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
                    [
                        opposingOrderPairObject.orderbook,
                        opposingOrderPairObject.orderbook,
                        encodedFN,
                    ],
                ),
            };
            const task = {
                evaluable: {
                    interpreter: config.dispair.interpreter,
                    store: config.dispair.store,
                    bytecode: await parseRainlang(
                        await getBountyEnsureRainlang(
                            ethers.utils.parseUnits(inputToEthPrice),
                            ethers.utils.parseUnits(outputToEthPrice),
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
                reason: undefined,
                spanAttributes: {
                    againstOrderbooks: JSON.stringify({
                        [opposingOrderbookAddress]: {
                            maxInput: vaultBalance.toString(),
                            blockNumber: oppBlockNumber,
                            stage: 1,
                            isNodeError: false,
                            error: errorSnapshot("", err),
                            rawtx: JSON.stringify(rawtx),
                        },
                    }),
                    // [`againstOrderbooks.${opposingOrderbookAddress}.blockNumber`]: oppBlockNumber,
                    // [`againstOrderbooks.${opposingOrderbookAddress}.stage`]: 1,
                    // [`againstOrderbooks.${opposingOrderbookAddress}.isNodeError`]: false,
                    // [`againstOrderbooks.${opposingOrderbookAddress}.error`]: errorSnapshot("", err),
                    // [`againstOrderbooks.${opposingOrderbookAddress}.rawtx`]: JSON.stringify(rawtx),
                    // [`againstOrderbooks.${opposingOrderbookAddress}.maxInput`]:
                    //     vaultBalance.toString(),
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});
