const ethers = require("ethers");
const { arbAbis, orderbookAbi } = require("../abis");
const { Router, Token } = require("sushiswap-router");
const { trace, context, SpanStatusCode } = require("@opentelemetry/api");
const {
    getIncome,
    processLps,
    getEthPrice,
    getDataFetcher,
    getActualPrice,
    visualizeRoute,
    promiseTimeout,
    bundleTakeOrders,
    getActualClearAmount,
    getSpanException
} = require("../utils");


/**
 * Main function that gets order details from subgraph, bundles the ones that have balance and tries clearing them with specialized router contract
 *
 * @param {object} config - The configuration object
 * @param {any[]} ordersDetails - The order details queried from subgraph
 * @param {string} gasCoveragePercentage - (optional) The percentage of the gas cost to cover on each transaction for it to be considered profitable and get submitted
 * @param {import("@opentelemetry/sdk-trace-base").Tracer} tracer
 * @param {import("@opentelemetry/api").Context} ctx
 * @returns The report of details of cleared orders
 */
const srouterClear = async(
    config,
    ordersDetails,
    gasCoveragePercentage = "100",
    tracer,
    ctx,
) => {
    if (
        gasCoveragePercentage < 0 ||
        !Number.isInteger(Number(gasCoveragePercentage))
    ) throw "invalid gas coverage percentage, must be an integer greater than equal 0";

    const lps               = processLps(config.lps);
    const viemClient        = createViemClient(config.chainId, [config.rpc], false);
    const dataFetcher       = getDataFetcher(viemClient, lps);
    const signer            = config.signer;
    const arbAddress        = config.arbAddress;
    const orderbookAddress  = config.orderbookAddress;
    const maxProfit         = config.maxProfit;
    const maxRatio          = config.maxRatio;
    const hops              = config.hops;
    const flashbotSigner    = config.flashbotRpc
        ? new ethers.Wallet(
            signer.privateKey,
            new ethers.providers.JsonRpcProvider(config.flashbotRpc)
        )
        : undefined;

    // instantiating arb contract
    const arb = new ethers.Contract(arbAddress, arbAbis["srouter"], signer);

    // instantiating orderbook contract
    const orderbook = new ethers.Contract(orderbookAddress, orderbookAbi, signer);

    let bundledOrders = [];
    bundledOrders = await tracer.startActiveSpan("preparing-orders", {}, ctx, async (span) => {
        span.setAttributes({
            "details.doesEval": maxProfit ?? true,
            "details.doesBundle": config.bundle
        });
        try {
            const result = await bundleTakeOrders(
                viemClient,
                ordersDetails,
                orderbook,
                arb,
                maxProfit,
                config.shuffle,
                config.interpreterv2,
                config.bundle,
                tracer,
                trace.setSpan(context.active(), span),
                config.multicallAddress
            );
            const status = {code: SpanStatusCode.OK};
            if (!result.length) status.message = "could not find any orders for current market price or with vault balance";
            span.setStatus(status);
            span.end();
            return result;
        } catch (e) {
            span.setStatus({code: SpanStatusCode.ERROR });
            span.recordException(getSpanException(e));
            span.end();
            return Promise.reject(e);
        }
    });

    if (!bundledOrders.length) return;

    const clearProcSpan = tracer.startSpan("clear-process", undefined, ctx);
    const clearProcCtx = trace.setSpan(context.active(), clearProcSpan);

    const report = [];
    for (let i = 0; i < bundledOrders.length; i++) {
        const pair = `${
            bundledOrders[i].buyTokenSymbol
        }/${
            bundledOrders[i].sellTokenSymbol
        }`;
        const pairSpan = tracer.startSpan(
            (config.bundle ? "bundled-orders" : "single-order") + " " + pair,
            undefined,
            clearProcCtx
        );
        const pairCtx = trace.setSpan(context.active(), pairSpan);
        pairSpan.setAttributes({
            "details.orders": JSON.stringify(bundledOrders[i]),
            "details.pair": pair
        });

        try {
            if (!bundledOrders[i].takeOrders.length) {
                pairSpan.setStatus({code: SpanStatusCode.OK, message: "all orders have empty vault balance"});
                pairSpan.end();
                continue;
            }

            const fromToken = new Token({
                chainId: config.chainId,
                decimals: bundledOrders[i].sellTokenDecimals,
                address: bundledOrders[i].sellToken,
                symbol: bundledOrders[i].sellTokenSymbol
            });
            const toToken = new Token({
                chainId: config.chainId,
                decimals: bundledOrders[i].buyTokenDecimals,
                address: bundledOrders[i].buyToken,
                symbol: bundledOrders[i].buyTokenSymbol
            });

            const obSellTokenBalance = ethers.BigNumber.from(await signer.call({
                data: "0x70a08231000000000000000000000000" + orderbookAddress.slice(2),
                to: bundledOrders[i].sellToken
            }));

            if (obSellTokenBalance.isZero()) {
                pairSpan.setStatus({
                    code: SpanStatusCode.OK,
                    message: `Orderbook has no ${bundledOrders[i].sellTokenSymbol} balance`
                });
                pairSpan.end();
                continue;
            }

            let ethPrice;
            const gasPrice = await tracer.startActiveSpan("getGasPrice", {}, pairCtx, async (span) => {
                try {
                    const result = await signer.provider.getGasPrice();
                    span.setAttribute("details.price", result.toString());
                    span.setStatus({code: SpanStatusCode.OK});
                    span.end();
                    return result;
                } catch(e) {
                    span.setStatus({code: SpanStatusCode.ERROR });
                    span.recordException(getSpanException(e));
                    span.end();
                    return Promise.reject("could not get gas price");
                }
            });
            if (gasCoveragePercentage !== "0") {
                await tracer.startActiveSpan("getEthPrice", {}, pairCtx, async (span) => {
                    try {
                        ethPrice = await getEthPrice(
                            config,
                            bundledOrders[i].buyToken,
                            bundledOrders[i].buyTokenDecimals,
                            gasPrice,
                            dataFetcher
                        );
                        if (!ethPrice) {
                            span.setStatus({code: SpanStatusCode.ERROR });
                            span.recordException(new Error("could not get ETH price"));
                            span.end();
                            return Promise.reject("could not get ETH price");
                        } else {
                            span.setAttribute("details.price", ethPrice);
                            span.setStatus({code: SpanStatusCode.OK});
                            span.end();
                        }
                    } catch(e) {
                        span.setStatus({code: SpanStatusCode.ERROR });
                        span.recordException(getSpanException(e));
                        span.end();
                        return Promise.reject("could not get ETH price");
                    }
                });
            }
            else ethPrice = "0";

            await tracer.startActiveSpan(
                "fecthPools",
                { message: "getting pool details from sushi lib for token pair"},
                pairCtx,
                async (span) => {
                    try {
                        await dataFetcher.fetchPoolsForToken(fromToken, toToken);
                        span.setStatus({code: SpanStatusCode.OK});
                        span.end();
                        return;
                    } catch(e) {
                        span.setStatus({code: SpanStatusCode.ERROR });
                        span.recordException(getSpanException(e));
                        span.end();
                        return Promise.reject("could not get pool details");
                    }
                }
            );

            let rawtx, gasCostInToken, takeOrdersConfigStruct, price;
            if (config.bundle) {
                try {
                    ({ rawtx, gasCostInToken, takeOrdersConfigStruct, price } = await dryrun(
                        0,
                        hops,
                        bundledOrders[i],
                        dataFetcher,
                        fromToken,
                        toToken,
                        signer,
                        obSellTokenBalance,
                        gasPrice,
                        gasCoveragePercentage,
                        maxProfit,
                        maxRatio,
                        arb,
                        ethPrice,
                        config,
                        tracer,
                        pairCtx
                    ));
                } catch {
                    rawtx = undefined;
                }
            } else {
                const promises = [];
                for (let j = 1; j < 4; j++) {
                    promises.push(
                        dryrun(
                            j,
                            hops,
                            bundledOrders[i],
                            dataFetcher,
                            fromToken,
                            toToken,
                            signer,
                            obSellTokenBalance,
                            gasPrice,
                            gasCoveragePercentage,
                            maxProfit,
                            maxRatio,
                            arb,
                            ethPrice,
                            config,
                            tracer,
                            pairCtx
                        )
                    );
                }
                const allPromises = await Promise.allSettled(promises);

                let choice;
                for (let j = 0; j < allPromises.length; j++) {
                    if (allPromises[j].status === "fulfilled") {
                        if (!choice || choice.maximumInput.lt(allPromises[j].value.maximumInput)) {
                            choice = allPromises[j].value;
                        }
                    }
                }
                if (choice) {
                    ({ rawtx, gasCostInToken, takeOrdersConfigStruct, price } = choice);
                }
            }

            if (!rawtx) {
                pairSpan.setStatus({
                    code: SpanStatusCode.OK,
                    message: "could not find any opportunity to clear"
                });
                pairSpan.end();
                continue;
            }

            try {
                pairSpan.setAttributes({
                    "details.marketPrice": ethers.utils.formatEther(price),
                    "details.takeOrdersConfigStruct": JSON.stringify(takeOrdersConfigStruct),
                    "details.gasCostInToken": ethers.utils.formatUnits(gasCostInToken, toToken.decimals),
                    "details.minBotReceivingAmount": ethers.utils.formatUnits(
                        gasCostInToken.mul(gasCoveragePercentage).div("100"),
                        toToken.decimals
                    ),
                });

                rawtx.data = arb.interface.encodeFunctionData(
                    "arb",
                    [
                        takeOrdersConfigStruct,
                        gasCostInToken.mul(gasCoveragePercentage).div("100")
                    ]
                );

                const blockNumber = await signer.provider.getBlockNumber();
                pairSpan.setAttribute("details.blockNumber", blockNumber);

                const tx = config.timeout
                    ? await promiseTimeout(
                        (flashbotSigner !== undefined
                            ? flashbotSigner.sendTransaction(rawtx)
                            : signer.sendTransaction(rawtx)),
                        config.timeout,
                        `Transaction failed to get submitted after ${config.timeout}ms`
                    )
                    : flashbotSigner !== undefined
                        ? await flashbotSigner.sendTransaction(rawtx)
                        : await signer.sendTransaction(rawtx);

                const txUrl = config.explorer + "tx/" + tx.hash;
                console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
                pairSpan.setAttributes({
                    "details.txUrl": txUrl,
                    "details.tx": JSON.stringify(tx)
                });

                const receipt = config.timeout
                    ? await promiseTimeout(
                        tx.wait(),
                        config.timeout,
                        `Transaction failed to mine after ${config.timeout}ms`
                    )
                    : await tx.wait();

                if (receipt.status === 1) {
                    const clearActualAmount = getActualClearAmount(
                        arbAddress,
                        orderbookAddress,
                        receipt
                    );
                    const income = getIncome(signer, receipt);
                    const clearActualPrice = getActualPrice(
                        receipt,
                        orderbookAddress,
                        arbAddress,
                        clearActualAmount.mul("1" + "0".repeat(
                            18 - bundledOrders[i].sellTokenDecimals
                        )),
                        bundledOrders[i].buyTokenDecimals
                    );
                    const actualGasCost = ethers.BigNumber.from(
                        receipt.effectiveGasPrice
                    ).mul(receipt.gasUsed);
                    const actualGasCostInToken = ethers.utils.parseUnits(
                        ethPrice
                    ).mul(
                        actualGasCost
                    ).div(
                        "1" + "0".repeat(
                            36 - bundledOrders[i].buyTokenDecimals
                        )
                    );
                    const netProfit = income
                        ? income.sub(actualGasCostInToken)
                        : undefined;

                    if (income) {
                        const incomeFormated = ethers.utils.formatUnits(
                            income,
                            bundledOrders[i].buyTokenDecimals
                        );
                        const netProfitFormated = ethers.utils.formatUnits(
                            netProfit,
                            bundledOrders[i].buyTokenDecimals
                        );
                        pairSpan.setAttributes({
                            "details.income": incomeFormated,
                            "details.netProfit": netProfitFormated
                        });
                    }
                    pairSpan.setAttributes({
                        "details.clearAmount": clearActualAmount.toString(),
                        "details.clearPrice": ethers.utils.formatEther(price),
                        "details.clearActualPrice": clearActualPrice,
                    });
                    pairSpan.setStatus({ code: SpanStatusCode.OK, message: "successfuly cleared" });

                    report.push({
                        txUrl,
                        transactionHash: receipt.transactionHash,
                        tokenPair:
                            bundledOrders[i].buyTokenSymbol +
                            "/" +
                            bundledOrders[i].sellTokenSymbol,
                        buyToken: bundledOrders[i].buyToken,
                        buyTokenDecimals: bundledOrders[i].buyTokenDecimals,
                        sellToken: bundledOrders[i].sellToken,
                        sellTokenDecimals: bundledOrders[i].sellTokenDecimals,
                        clearedAmount: clearActualAmount.toString(),
                        clearPrice: ethers.utils.formatEther(price),
                        clearActualPrice,
                        gasUsed: receipt.gasUsed,
                        gasCost: actualGasCost,
                        income,
                        netProfit,
                        clearedOrders: takeOrdersConfigStruct.orders.map(
                            v => v.id
                        ),
                    });
                }
                else {
                    pairSpan.setAttribute("details.receipt", JSON.stringify(receipt));
                    pairSpan.setStatus({ code: SpanStatusCode.ERROR });
                }
            }
            catch (error) {
                pairSpan.recordException(getSpanException(error));
                pairSpan.setStatus({ code: SpanStatusCode.ERROR });
            }
        }
        catch (error) {
            pairSpan.recordException(getSpanException(error));
            pairSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
        pairSpan.end();
    }
    clearProcSpan.end();
    return report;
};

/**
 * @param {import("@opentelemetry/sdk-trace-base").Tracer} tracer
 * @param {import("@opentelemetry/api").Context} ctx
 */
async function dryrun(
    mode,
    hops,
    bundledOrder,
    dataFetcher,
    fromToken,
    toToken,
    signer,
    obSellTokenBalance,
    gasPrice,
    gasCoveragePercentage,
    maxProfit,
    maxRatio,
    arb,
    ethPrice,
    config,
    tracer,
    ctx
) {
    let succesOrFailure = true;
    let maximumInput = obSellTokenBalance;
    const modeText = mode === 0
        ? "bundled-orders"
        : mode === 1
            ? "single-order"
            : mode === 2
                ? "double-orders"
                : "triple-orders";

    const dryrunSpan = tracer.startSpan(`find-max-input-for-${modeText}`, undefined, ctx);
    const dryrunCtx = trace.setSpan(context.active(), dryrunSpan);

    for (let j = 1; j < hops + 1; j++) {
        const hopSpan = tracer.startSpan(`hop-${j}`, undefined, dryrunCtx);

        const maximumInputFixed = maximumInput.mul(
            "1" + "0".repeat(18 - bundledOrder.sellTokenDecimals)
        );

        hopSpan.setAttributes({
            "details.maximumInput": maximumInput.toString(),
            "details.maximumInputFixed": maximumInputFixed.toString()
        });

        const pcMap = dataFetcher.getCurrentPoolCodeMap(
            fromToken,
            toToken
        );
        const route = Router.findBestRoute(
            pcMap,
            config.chainId,
            fromToken,
            maximumInput,
            toToken,
            gasPrice.toNumber(),
            // 30e9,
            // providers,
            // poolFilter
        );
        if (route.status == "NoWay") {
            hopSpan.setAttribute("details.route", "no-way");
            hopSpan.setStatus({ code: SpanStatusCode.ERROR });
            hopSpan.end();
            succesOrFailure = false;
        }
        else {
            const rateFixed = route.amountOutBN.mul(
                "1" + "0".repeat(18 - bundledOrder.buyTokenDecimals)
            );
            const price = rateFixed.mul("1" + "0".repeat(18)).div(maximumInputFixed);
            hopSpan.setAttribute("details.marketPrice", ethers.utils.formatEther(price));

            // filter out orders that are not price match or failed eval when --max-profit is enabled
            // price check is at +2% as a headroom for current block vs tx block
            if (!mode && maxProfit) {
                bundledOrder.takeOrders = bundledOrder.takeOrders.filter(
                    v => v.ratio !== undefined ? price.mul("102").div("100").gte(v.ratio) : false
                );
                hopSpan.addEvent("filtered out orders with lower ratio than current market price");
            }

            if (bundledOrder.takeOrders.length === 0) {
                hopSpan.addEvent("all orders had lower ratio than current market price");
                hopSpan.end();
                maximumInput = maximumInput.sub(obSellTokenBalance.div(2 ** j));
                continue;
            }

            const routeVisual = [];
            visualizeRoute(fromToken, toToken, route.legs).forEach(
                v => {routeVisual.push(v);}
            );
            hopSpan.setAttributes({
                "details.route.legs": JSON.stringify(route.legs),
                "details.route.visual": routeVisual,
            });

            const rpParams = Router.routeProcessor2Params(
                pcMap,
                route,
                fromToken,
                toToken,
                arb.address,
                config.rp32 ? config.routeProcessor3_2Address : config.routeProcessor3Address,
                // permits
                // "0.005"
            );

            const orders = mode === 0
                ? bundledOrder.takeOrders.map(v => v.takeOrder)
                : mode === 1
                    ? [bundledOrder.takeOrders[0].takeOrder]
                    : mode === 2
                        ? [
                            bundledOrder.takeOrders[0].takeOrder,
                            bundledOrder.takeOrders[0].takeOrder
                        ]
                        : [
                            bundledOrder.takeOrders[0].takeOrder,
                            bundledOrder.takeOrders[0].takeOrder,
                            bundledOrder.takeOrders[0].takeOrder
                        ];

            const takeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput,
                maximumIORatio: maxRatio ? ethers.constants.MaxUint256 : price,
                orders,
                data: ethers.utils.defaultAbiCoder.encode(
                    ["bytes"],
                    [rpParams.routeCode]
                )
            };
            hopSpan.setAttributes({
                "details.route.data": rpParams.routeCode,
                "details.takeOrdersConfigStruct": JSON.stringify(takeOrdersConfigStruct),
            });

            // building and submit the transaction
            try {
                const rawtx = {
                    data: arb.interface.encodeFunctionData("arb", [takeOrdersConfigStruct, "0"]),
                    to: arb.address,
                    gasPrice
                };

                const blockNumber = await signer.provider.getBlockNumber();
                hopSpan.setAttribute("details.blockNumber", blockNumber);

                let gasLimit;
                try {
                    gasLimit = await signer.estimateGas(rawtx);
                    hopSpan.setAttribute("details.estimateGas.value", gasLimit.toString());
                }
                catch(e) {
                    hopSpan.recordException(getSpanException(e));
                    throw "nomatch";
                }
                gasLimit = gasLimit.mul("103").div("100");
                rawtx.gasLimit = gasLimit;
                const gasCost = gasLimit.mul(gasPrice);
                const gasCostInToken = ethers.utils.parseUnits(
                    ethPrice
                ).mul(
                    gasCost
                ).div(
                    "1" + "0".repeat(
                        36 - bundledOrder.buyTokenDecimals
                    )
                );
                hopSpan.setAttribute("details.gasCostInToken", gasCostInToken.toString());
                if (gasCoveragePercentage !== "0") {
                    const headroom = (
                        Number(gasCoveragePercentage) * 1.05
                    ).toFixed();
                    rawtx.data = arb.interface.encodeFunctionData(
                        "arb",
                        [
                            takeOrdersConfigStruct,
                            gasCostInToken.mul(headroom).div("100")
                        ]
                    );
                    hopSpan.setAttribute("details.headroom", gasCostInToken.mul(headroom).div("100").toString());
                    try {
                        await signer.estimateGas(rawtx);
                        hopSpan.setStatus({ code: SpanStatusCode.OK });
                    }
                    catch(e) {
                        hopSpan.recordException(getSpanException(e));
                        throw "dryrun";
                    }
                }
                succesOrFailure = true;
                if (j == 1 || j == hops) {
                    hopSpan.end();
                    dryrunSpan.setStatus({ code: SpanStatusCode.OK });
                    dryrunSpan.end();
                    return {rawtx, maximumInput, gasCostInToken, takeOrdersConfigStruct, price};
                }
            }
            catch (error) {
                succesOrFailure = false;
                hopSpan.setStatus({ code: SpanStatusCode.ERROR });
                if (error !== "nomatch" && error !== "dryrun") {
                    hopSpan.recordException(getSpanException(error));
                    // reason, code, method, transaction, error, stack, message
                }
            }
            hopSpan.end();
        }
        maximumInput = succesOrFailure
            ? maximumInput.add(obSellTokenBalance.div(2 ** j))
            : maximumInput.sub(obSellTokenBalance.div(2 ** j));
    }
    dryrunSpan.setStatus({ code: SpanStatusCode.ERROR });
    dryrunSpan.end();
    return Promise.reject();
}

module.exports = {
    srouterClear
};
