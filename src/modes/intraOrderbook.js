const ethers = require("ethers");
const { orderbookAbi, erc20Abi } = require("../abis");
const { getWithdrawEnsureBytecode } = require("../config");
const { estimateProfit, withBigintSerializer, errorSnapshot } = require("../utils");

/**
 * @import { PublicClient } from "viem"
 * @import { BotConfig, BundledOrders, ViemClient, TakeOrderDetails, DryrunResult } from "../types"
 */

/**
 * Executes a extimateGas call for an intra-orderbook tx (clear2()), to determine if the tx is successfull ot not
 * @param {{
 *  config: BotConfig,
 *  orderPairObject: BundledOrders,
 *  viemClient: PublicClient,
 *  signer: ViemClient,
 *  orderbooksOrders: BundledOrders[][],
 *  gasPrice: bigint,
 *  inputToEthPrice: string,
 *  outputToEthPrice: string,
 *  inputBalance: ethers.BigNumber,
 *  outputBalance: ethers.BigNumber,
 *  opposingOrder: TakeOrderDetails
 * }} args
 */
async function dryrun({
    orderPairObject,
    opposingOrder,
    signer,
    gasPrice,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    inputBalance,
    outputBalance,
}) {
    const spanAttributes = {};
    const result = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };

    const inputBountyVaultId = "1";
    const outputBountyVaultId = "1";
    const obInterface = new ethers.utils.Interface(orderbookAbi);
    const withdrawInputCalldata = obInterface.encodeFunctionData(
        "withdraw2",
        [
            orderPairObject.buyToken,
            inputBountyVaultId,
            ethers.constants.MaxUint256,
            []
        ]
    );
    let withdrawOutputCalldata = obInterface.encodeFunctionData(
        "withdraw2",
        [
            orderPairObject.sellToken,
            outputBountyVaultId,
            ethers.constants.MaxUint256,
            []
        ]
    );
    const clear2Calldata = obInterface.encodeFunctionData(
        "clear2",
        [
            orderPairObject.takeOrders[0].takeOrder.order,
            opposingOrder.takeOrder.order,
            {
                aliceInputIOIndex: orderPairObject.takeOrders[0].takeOrder.inputIOIndex,
                aliceOutputIOIndex: orderPairObject.takeOrders[0].takeOrder.outputIOIndex,
                bobInputIOIndex: opposingOrder.takeOrder.inputIOIndex,
                bobOutputIOIndex: opposingOrder.takeOrder.outputIOIndex,
                aliceBountyVaultId: inputBountyVaultId,
                bobBountyVaultId: outputBountyVaultId,
            },
            [],
            []
        ]
    );
    const rawtx = {
        data: obInterface.encodeFunctionData(
            "multicall",
            [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]]
        ),
        to: orderPairObject.orderbook,
        from: signer.account.address,
        gasPrice
    };

    // trying to find opp with doing gas estimation, once to get gas and calculate
    // minimum sender output and second time to check the clear2() with withdraw2() and headroom
    let gasLimit, blockNumber;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["blockNumber"] = blockNumber;
        gasLimit = ethers.BigNumber.from(await signer.estimateGas(rawtx));
    }
    catch(e) {
        // reason, code, method, transaction, error, stack, message
        spanAttributes["error"] = errorSnapshot("", e);
        spanAttributes["rawtx"] = JSON.stringify(rawtx, withBigintSerializer);
        return Promise.reject(result);
    }
    gasLimit = gasLimit.mul("107").div("100");
    rawtx.gas = gasLimit.toBigInt();
    const gasCost = gasLimit.mul(gasPrice);

    // repeat the same process with heaedroom if gas
    // coverage is not 0, 0 gas coverage means 0 minimum
    // sender output which is already called above
    if (config.gasCoveragePercentage !== "0") {
        const headroom = (
            Number(config.gasCoveragePercentage) * 1.05
        ).toFixed();
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
                    gasCost.mul(headroom).div("100"),
                )
            },
            signedContext: []
        };
        withdrawOutputCalldata = obInterface.encodeFunctionData(
            "withdraw2",
            [
                orderPairObject.sellToken,
                outputBountyVaultId,
                ethers.constants.MaxUint256,
                [task]
            ]
        );
        rawtx.data = obInterface.encodeFunctionData(
            "multicall",
            [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]]
        );

        try {
            blockNumber = Number(await viemClient.getBlockNumber());
            spanAttributes["blockNumber"] = blockNumber;
            await signer.estimateGas(rawtx);
            task.evaluable.bytecode = getWithdrawEnsureBytecode(
                signer.account.address,
                orderPairObject.buyToken,
                orderPairObject.sellToken,
                inputBalance,
                outputBalance,
                ethers.utils.parseUnits(inputToEthPrice),
                ethers.utils.parseUnits(outputToEthPrice),
                gasCost.mul(config.gasCoveragePercentage).div("100"),
            );
            withdrawOutputCalldata = obInterface.encodeFunctionData(
                "withdraw2",
                [
                    orderPairObject.sellToken,
                    outputBountyVaultId,
                    ethers.constants.MaxUint256,
                    [task]
                ]
            );
            rawtx.data = obInterface.encodeFunctionData(
                "multicall",
                [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]]
            );
        }
        catch(e) {
            spanAttributes["error"] = errorSnapshot("", e);
            spanAttributes["rawtx"] = JSON.stringify(rawtx, withBigintSerializer);
            return Promise.reject(result);
        }
    }

    // if reached here, it means there was a success and found opp
    spanAttributes["oppBlockNumber"] = blockNumber;
    spanAttributes["foundOpp"] = true;
    delete spanAttributes["blockNumber"];
    result.value = {
        rawtx,
        oppBlockNumber: blockNumber,
        estimatedProfit: estimateProfit(
            orderPairObject,
            ethers.utils.parseUnits(inputToEthPrice),
            ethers.utils.parseUnits(outputToEthPrice),
            opposingOrder,
        )
    };
    return result;
}

/**
 * Tries to find an opp from the same orderbook's opposing orders
 * @param {{
 *  config: BotConfig,
 *  orderPairObject: BundledOrders,
 *  viemClient: PublicClient,
 *  signer: ViemClient,
 *  orderbooksOrders: BundledOrders[][],
 *  gasPrice: bigint,
 *  inputToEthPrice: string,
 *  outputToEthPrice: string,
 * }} args
 * @returns {Promise<DryrunResult>}
 */
async function findOpp({
    orderPairObject,
    signer,
    gasPrice,
    inputToEthPrice,
    outputToEthPrice,
    config,
    viemClient,
    orderbooksOrders,
}) {
    const spanAttributes = {};
    const result = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };

    const ONE = ethers.utils.parseUnits("1");
    const opposingOrders = orderbooksOrders
        .map(v => {
            if (v[0].orderbook === orderPairObject.orderbook) {
                return v.find(e =>
                    e.buyToken === orderPairObject.sellToken &&
                    e.sellToken === orderPairObject.buyToken
                );
            } else {
                return undefined;
            }
        })
        .find(v => v !== undefined)?.takeOrders
        .filter(v =>
            // not same order
            v.id !== orderPairObject.takeOrders[0].id &&
            // not same owner
            v.takeOrder.order.owner.toLowerCase() !==
                orderPairObject.takeOrders[0].takeOrder.order.owner.toLowerCase() &&
            // only orders that (priceA x priceB < 1) can be profitbale
            v.quote.ratio.mul(orderPairObject.takeOrders[0].quote.ratio).div(ONE).lt(ONE)
        );
    if (!opposingOrders.length) throw undefined;

    const allErrorAttributes = [];
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const inputBalance = ethers.BigNumber.from((await viemClient.call({
        to: orderPairObject.buyToken,
        data: erc20.encodeFunctionData("balanceOf", [signer.account.address])
    })).data);
    const outputBalance = ethers.BigNumber.from((await viemClient.call({
        to: orderPairObject.sellToken,
        data: erc20.encodeFunctionData("balanceOf", [signer.account.address])
    })).data);
    for (let i = 0; i < opposingOrders.length; i++) {
        try {
            return await dryrun({
                orderPairObject,
                opposingOrder: opposingOrders[i],
                signer,
                gasPrice,
                inputToEthPrice,
                outputToEthPrice,
                config,
                viemClient,
                inputBalance,
                outputBalance,
            });
        } catch(e) {
            allErrorAttributes.push(JSON.stringify(e.spanAttributes));
        }
    }
    spanAttributes["intraOrderbook"] = allErrorAttributes;
    return Promise.reject(result);
}

module.exports = {
    dryrun,
    findOpp,
};