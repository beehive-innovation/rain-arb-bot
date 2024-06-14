const { assert } = require("chai");
const fixtures = require("./fixtures");
const { ethers, utils: { formatUnits } } = require("ethers");
const { processTx, ProcessTxHaltReason } = require("../src/processes/processTx");

describe("Test process tx", async function () {
    let signer = {};

    const oppBlockNumber = 123456;
    const clearBlockNumber = 123459;
    const {
        ethPrice,
        gasPrice,
        gasLimitEstimation,
        arb,
        vaultBalance,
        orderPairObject1: orderPairObject,
        config,
        expectedRouteVisual,
        pair,
        orderbook,
        txHash,
        effectiveGasPrice,
        gasUsed,
        expectedRouteData,
        getCurrentPrice,
        scannerUrl,
    } = fixtures;
    const takeOrdersConfigStruct = {
        minimumInput: ethers.constants.One,
        maximumInput: vaultBalance,
        maximumIORatio: ethers.constants.MaxUint256,
        orders: [orderPairObject.takeOrders[0].takeOrder],
        data: expectedRouteData,
    };
    const dryrunData = {
        rawtx: {
            data: arb.interface.encodeFunctionData(
                "arb",
                [
                    takeOrdersConfigStruct,
                    gasLimitEstimation.mul("103").div("100").mul(gasPrice).div(2).div(
                        "1" + "0".repeat(18 - orderPairObject.buyTokenDecimals)
                    )
                ]
            ),
            to: arb.address,
            gasPrice,
            gasLimit: gasLimitEstimation.mul("103").div("100"),
        },
        maximumInput: vaultBalance,
        gasCostInToken: ethers.BigNumber.from("500000"),
        takeOrdersConfigStruct,
        price: getCurrentPrice(vaultBalance),
        routeVisual: expectedRouteVisual,
        oppBlockNumber,
    };

    beforeEach(() => {
        signer = {
            getAddress: () => "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb",
            provider: {
                getBlockNumber: async () => 123459
            },
            estimateGas: async () => gasLimitEstimation,
            sendTransaction: async () => {
                return {
                    hash: txHash,
                    wait: async () => {
                        return {
                            status: 1,
                            effectiveGasPrice,
                            gasUsed,
                            logs: [],
                            events: [],
                        };
                    }
                };
            }
        };
    });

    it("should successfully process tx", async function () {
        const result = await processTx({
            orderPairObject,
            signer,
            flashbotSigner: undefined,
            arb,
            orderbook,
            ethPrice,
            config,
            dryrunData,
            pair,
        });
        const expected = {
            reason: undefined,
            error: undefined,
            spanAttributes: {
                clearBlockNumber,
                blockDiff: clearBlockNumber - oppBlockNumber,
                route: dryrunData.routeVisual,
                maxInput: vaultBalance.toString(),
                marketPrice: formatUnits(dryrunData.price),
                estimatedGasCostInToken: "0.5",
                txUrl: scannerUrl + "/tx/" + txHash,
                tx: `{"hash":"${txHash}"}`,
                gasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                gasCostInToken: formatUnits(
                    effectiveGasPrice.mul(gasUsed).div(2)
                ).slice(0, orderPairObject.buyTokenDecimals + 2),
            },
            report: {
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                actualGasCostInToken: formatUnits(
                    effectiveGasPrice.mul(gasUsed).div(2)
                ).slice(0, orderPairObject.buyTokenDecimals + 2),
                income: undefined,
                netProfit: undefined,
                clearedOrders: [
                    orderPairObject.takeOrders[0].id
                ]
            }
        };
        assert.deepEqual(result, expected);
    });

    it("should fail to submit tx", async function () {
        signer.sendTransaction = async () => {
            return Promise.reject({ code: ethers.errors.UNPREDICTABLE_GAS_LIMIT });
        };
        try {
            await processTx({
                orderPairObject,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                ethPrice,
                config,
                dryrunData,
                pair,
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                reason: ProcessTxHaltReason.TxFailed,
                error: { code: ethers.errors.UNPREDICTABLE_GAS_LIMIT },
                spanAttributes: {
                    clearBlockNumber,
                    blockDiff: clearBlockNumber - oppBlockNumber,
                    route: dryrunData.routeVisual,
                    maxInput: vaultBalance.toString(),
                    marketPrice: formatUnits(dryrunData.price),
                    estimatedGasCostInToken: "0.5",
                    rawTx: JSON.stringify(dryrunData.rawtx),
                },
                report: {
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to mine tx", async function () {
        const receipt = {
            status: 0,
            effectiveGasPrice: 123,
            gasUsed: 456,
            logs: [],
            events: [],
        };
        signer.sendTransaction = async () => {
            return {
                hash: txHash,
                wait: async () => {
                    return receipt;
                }
            };
        };
        try {
            await processTx({
                orderPairObject,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                ethPrice,
                config,
                dryrunData,
                pair,
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                reason: ProcessTxHaltReason.TxMineFailed,
                error: undefined,
                spanAttributes: {
                    clearBlockNumber,
                    blockDiff: clearBlockNumber - oppBlockNumber,
                    route: dryrunData.routeVisual,
                    maxInput: vaultBalance.toString(),
                    marketPrice: formatUnits(dryrunData.price),
                    estimatedGasCostInToken: "0.5",
                    receipt: JSON.stringify(receipt),
                    txUrl: scannerUrl + "/tx/" + txHash,
                    tx: `{"hash":"${txHash}"}`,
                },
                report: {
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    txUrl: scannerUrl + "/tx/" + txHash,
                }
            };
            assert.deepEqual(error, expected);
        }
    });
});