import { assert } from "chai";
import fixtures from "./data";
import { ethers } from "ethers";
import { ProcessPairHaltReason, ProcessPairReportStatus } from "../src/types";
import { InsufficientFundsError, InvalidInputRpcError, TransactionReceipt } from "viem";
import {
    getNonce,
    getSigner,
    pollSigners,
    handleReceipt,
    sendTransaction,
    handleTransaction,
    getTxGas,
} from "../src/tx";

describe("Test tx", async function () {
    let signer: any = {};
    let viemClient: any = {};
    const {
        orderPairObject1: orderPairObject,
        config,
        pair,
        orderbook,
        txHash,
        scannerUrl,
        toToken,
        fromToken,
    } = fixtures;
    const gasUsed = 10n;
    const effectiveGasPrice = 44n;
    const inputToEthPrice = "1.5";
    const outputToEthPrice = "0.5";
    beforeEach(() => {
        // mock signer and viemClient before each test
        signer = {
            chain: config.chain,
            account: { address: "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb" },
            BALANCE: ethers.BigNumber.from(0),
            BOUNTY: [],
            BUSY: false,
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
        viemClient = {
            chain: config.chain,
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
    });

    it("should handle transaction successfully", async function () {
        const spanAttributes = {};
        const rawtx = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        const res = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            spanAttributes,
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
        };
        const result = await (
            await handleTransaction(
                signer,
                viemClient,
                spanAttributes,
                rawtx as any,
                orderbook,
                orderPairObject,
                inputToEthPrice,
                outputToEthPrice,
                res,
                pair,
                toToken,
                fromToken,
                config as any,
            )
        )();
        const expected = {
            reason: undefined,
            error: undefined,
            gasCost: ethers.BigNumber.from(gasUsed * effectiveGasPrice),
            spanAttributes: {
                "details.txUrl": scannerUrl + "/tx/" + txHash,
                didClear: true,
                "details.actualGasCost": Number(
                    ethers.utils.formatUnits(effectiveGasPrice * gasUsed),
                ),
            },
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: ethers.utils.formatUnits(gasUsed * effectiveGasPrice),
                income: undefined,
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
            },
        };
        assert.deepEqual(result, expected);
    });

    it("handle fail to submit transaction", async function () {
        // mock signer to reject the sendTransaction
        signer.sendTx = async () => {
            throw new InsufficientFundsError();
        };
        const spanAttributes = {};
        const rawtx = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        const res = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            spanAttributes,
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
        };
        try {
            await (
                await handleTransaction(
                    signer,
                    viemClient,
                    spanAttributes,
                    rawtx as any,
                    orderbook,
                    orderPairObject,
                    inputToEthPrice,
                    outputToEthPrice,
                    res,
                    pair,
                    toToken,
                    fromToken,
                    config as any,
                )
            )();
            assert.fail("expected to fail, but resolved");
        } catch (e) {
            const x = {
                error: new InsufficientFundsError(),
                gasCost: undefined,
                reason: ProcessPairHaltReason.TxFailed,
                report: {
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                },
                spanAttributes: {
                    "details.rawTx": JSON.stringify({
                        to: rawtx.to,
                        data: "",
                        from: signer.account.address,
                    }),
                    txNoneNodeError: false,
                },
            };
            assert.deepEqual(e, x);
        }
    });

    it("should handle success transaction receipt successfully", async function () {
        const receipt: Promise<TransactionReceipt> = (async () => ({
            status: "success", // success tx receipt
            effectiveGasPrice,
            gasUsed,
            logs: [],
            events: [],
        }))() as any;
        const spanAttributes = {};
        const rawtx: any = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        const txUrl = scannerUrl + "/tx/" + txHash;
        const res = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            spanAttributes,
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
        };
        const result = await handleReceipt(
            txHash,
            await receipt,
            signer,
            spanAttributes,
            rawtx,
            orderbook,
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            res,
            txUrl,
            pair,
            toToken,
            fromToken,
            config as any,
            0,
        );
        const expected = {
            reason: undefined,
            error: undefined,
            gasCost: ethers.BigNumber.from(gasUsed * effectiveGasPrice),
            spanAttributes: {
                didClear: true,
                "details.actualGasCost": Number(
                    ethers.utils.formatUnits(effectiveGasPrice * gasUsed),
                ),
            },
            report: {
                status: 3,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: ethers.utils.formatUnits(gasUsed * effectiveGasPrice),
                income: undefined,
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should handle revert transaction receipt successfully", async function () {
        // mock signer to throw on tx simulation
        signer.call = async () => {
            throw new InsufficientFundsError();
        };
        const receipt: Promise<TransactionReceipt> = (async () => ({
            status: "revert", // revert tx receipt
            effectiveGasPrice,
            gasUsed,
            logs: [],
            events: [],
        }))() as any;
        const spanAttributes = {};
        const rawtx: any = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        const txUrl = scannerUrl + "/tx/" + txHash;
        const res = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            spanAttributes,
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
        };
        try {
            await handleReceipt(
                txHash,
                await receipt,
                signer,
                spanAttributes,
                rawtx,
                orderbook,
                orderPairObject,
                inputToEthPrice,
                outputToEthPrice,
                res,
                txUrl,
                pair,
                toToken,
                fromToken,
                config as any,
                0,
            );
            assert.fail("expected to fail, but resolved");
        } catch (e) {
            const expected = {
                reason: ProcessPairHaltReason.TxReverted,
                error: {
                    err: "transaction reverted onchain, account ran out of gas for transaction gas cost",
                    nodeError: false,
                    snapshot:
                        "transaction reverted onchain, account ran out of gas for transaction gas cost",
                },
                gasCost: undefined,
                spanAttributes: { txNoneNodeError: true },
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    txUrl,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    actualGasCost: ethers.utils.formatUnits(gasUsed * effectiveGasPrice),
                },
            };
            assert.deepEqual(e, expected);
        }
    });

    it("should test sendTransaction happy", async function () {
        const rawtx: any = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        const result = await sendTransaction(signer, rawtx);
        assert.equal(result, txHash);
    });

    it("should test sendTransaction unhappy", async function () {
        const rawtx: any = {
            to: "0x" + "1".repeat(40),
            data: "",
        };
        try {
            // mock inner send call to throw an error
            signer.sendTransaction = async () => {
                throw new InsufficientFundsError();
            };
            await sendTransaction(signer, rawtx);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            assert.deepEqual(error, new InsufficientFundsError());
        }
    });

    it("should test getNonce happy", async function () {
        // should get nonce succesfully
        const result = await getNonce(signer);
        assert.equal(result, 0);
    });

    it("should test getNonce unhappy", async function () {
        try {
            // mock inner getTransactionCount to throw an error
            signer.getTransactionCount = async () => {
                throw new InvalidInputRpcError(new Error("some error"));
            };
            await getNonce(signer);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            assert.deepEqual(error, new InvalidInputRpcError(new Error("some error")));
        }
    });

    it("should test getSigner", async function () {
        // mock some signer accounts and main signer
        const mainSigner: any = { BUSY: true };
        const someMockedSigners: any[] = [
            { BUSY: true },
            { BUSY: true },
            { BUSY: true },
            { BUSY: true },
        ];

        // set timeout to free a signer after 2s
        setTimeout(() => (someMockedSigners[2].BUSY = false), 2000);
        // test multi account
        let result = await getSigner(someMockedSigners, mainSigner);
        assert.equal(result, someMockedSigners[2]);

        // set timeout to free main signer after 2s
        setTimeout(() => (mainSigner.BUSY = false), 2000);
        // test single account
        result = await getSigner([], mainSigner);
        assert.equal(result, mainSigner);
    });

    it("should test pollSigners", async function () {
        // mock some signer accounts
        const someMockedSigners: any[] = [
            { BUSY: true },
            { BUSY: true },
            { BUSY: true },
            { BUSY: true },
        ];

        // set timeout to free a signer after 2s
        setTimeout(() => (someMockedSigners[2].BUSY = false), 2000);

        const result = await pollSigners(someMockedSigners);
        assert.equal(result, someMockedSigners[2]);
    });

    it("should test getTxGas", async function () {
        const gas = 500n;

        // percentage
        const config = {
            txGas: "120%",
        } as any;
        let result = getTxGas(config, gas);
        let expected = 600n;
        assert.equal(result, expected);

        // static
        config.txGas = "900";
        result = getTxGas(config, gas);
        expected = 900n;
        assert.equal(result, expected);

        // none
        config.txGas = undefined;
        result = getTxGas(config, gas);
        assert.equal(result, gas);
    });
});
