const ethers = require("ethers");
const { Router } = require("sushi/router");
const { Token } = require("sushi/currency");
const { arbAbis, orderbookAbi } = require("./abis");
const { SpanStatusCode } = require("@opentelemetry/api");
const {
    getIncome,
    processLps,
    getEthPrice,
    getDataFetcher,
    visualizeRoute,
    promiseTimeout,
    bundleOrders,
    getSpanException,
    getVaultBalance,
    createViemClient,
    getActualClearAmount,
} = require("./utils");

/**
 * Specifies reason that order process halted
 */
const ProcessPairHaltReason = {
    NoWalletFund: 1,
    NoRoute: 2,
    FailedToGetVaultBalance: 3,
    FailedToGetGasPrice: 4,
    FailedToGetEthPrice: 5,
    FailedToGetPools: 6,
    TxFailed: 7,
    TxMineFailed: 8,
    UnexpectedError: 9,
};

/**
 * Specifies status of an processed order report
 */
const ProcessPairReportStatus = {
    EmptyVault: 1,
    NoOpportunity: 2,
    FoundOpportunity: 3,
};

/**
 * Specifies the reason that dryrun failed
 */
const DryrunHaltReason = {
    NoOpportunity: 1,
    NoWalletFund: 2,
    NoRoute: 3,
};

/**
 * Main function that processes all given orders and tries clearing them against onchain liquidity and reports the result
 *
 * @param {object} config - The configuration object
 * @param {any[]} ordersDetails - The order details queried from subgraph
 * @param {import("@opentelemetry/sdk-trace-base").Tracer} tracer
 * @param {import("@opentelemetry/api").Context} ctx
 */
const processOrders = async(
    config,
    ordersDetails,
    tracer,
    ctx,
) => {
    const lps               = processLps(config.lps);
    const viemClient        = createViemClient(config.chain.id, [config.rpc], false);
    const dataFetcher       = getDataFetcher(viemClient, lps, false);
    const signer            = config.signer;
    const flashbotSigner    = config.flashbotRpc
        ? new ethers.Wallet(
            signer.privateKey,
            new ethers.providers.JsonRpcProvider(config.flashbotRpc)
        )
        : undefined;

    // instantiating arb contract
    const arb = new ethers.Contract(config.arbAddress, arbAbis, signer);

    // instantiating orderbook contract
    const orderbook = new ethers.Contract(config.orderbookAddress, orderbookAbi, signer);

    // prepare orders
    const bundledOrders = bundleOrders(
        ordersDetails,
        config.shuffle,
        config.bundle,
    );
    if (!bundledOrders.length) return;

    const reports = [];
    for (let i = 0; i < bundledOrders.length; i++) {
        const pair = `${bundledOrders[i].buyTokenSymbol}/${bundledOrders[i].sellTokenSymbol}`;

        // instantiate a span for this pair
        const span = tracer.startSpan(
            (config.bundle ? "bundled-orders" : "single-order") + " " + pair,
            undefined,
            ctx
        );

        // process the pair
        try {
            const result = await processPair({
                config,
                orderPairObject: bundledOrders[i],
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner,
                arb,
                orderbook,
                pair,
            });
            reports.push(result.report);

            // set the span attributes with the values gathered at processPair()
            span.setAttributes(result.spanAttributes);

            // set the otel span status based on report status
            if (result.report.status === ProcessPairReportStatus.EmptyVault) {
                span.setStatus({ code: SpanStatusCode.OK, message: "empty vault" });
            } else if (result.report.status === ProcessPairReportStatus.NoOpportunity) {
                span.setStatus({ code: SpanStatusCode.OK, message: "no opportunity" });
            } else if (result.report.status === ProcessPairReportStatus.FoundOpportunity) {
                span.setStatus({ code: SpanStatusCode.OK, message: "found opportunity" });
            } else {
                // set the span status to unexpected error
                span.setStatus({ code: SpanStatusCode.ERROR, message: "unexpected error" });
            }
        } catch(e) {
            // set the span attributes with the values gathered at processPair()
            span.setAttributes(e.spanAttributes);

            // record otel span status based on reported reason
            if (e.reason) {
                // report the error reason along with the rest of report
                reports.push({
                    ...e.report,
                    error: e.error,
                    reason: e.reason,
                });

                // set the otel span status based on returned reason
                if (e.reason === ProcessPairHaltReason.NoWalletFund) {
                    // in case that wallet has no more funds, terminate the process by breaking the loop
                    if (e.error) span.recordException(getSpanException(e.error));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: "empty wallet" });
                    span.end();
                    throw "empty wallet";
                } else if (e.reason === ProcessPairHaltReason.FailedToGetVaultBalance) {
                    if (e.error) span.recordException(getSpanException(e.error));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: pair + ": failed to get vault balance" });
                } else if (e.reason === ProcessPairHaltReason.FailedToGetGasPrice) {
                    if (e.error) span.recordException(getSpanException(e.error));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: pair + ": failed to get gas price" });
                } else if (e.reason === ProcessPairHaltReason.FailedToGetPools) {
                    if (e.error) span.recordException(getSpanException(e.error));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: pair + ": failed to get pool details" });
                } else if (e.reason === ProcessPairHaltReason.FailedToGetEthPrice) {
                    // set OK status because a token might not have a pool and as a result eth price cannot
                    // be fetched for it and if it is set to ERROR it will constantly error on each round
                    // resulting in lots of false positives
                    if (e.error) span.setAttribute("errorDetails", JSON.stringify(getSpanException(e.error)));
                    span.setStatus({ code: SpanStatusCode.OK, message: "failed to get eth price" });
                } else {
                    // set the otel span status as OK as an unsuccessfull clear, this can happen for example
                    // because of mev front running or false positive opportunities, etc
                    if (e.error) span.setAttribute("errorDetails", JSON.stringify(getSpanException(e.error)));
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.setAttribute("unsuccessfullClear", true);
                }
            } else {
                // record the error for the span
                if (e.error) span.recordException(getSpanException(e.error));

                // report the unexpected error reason
                reports.push({
                    ...e.report,
                    error: e.error,
                    reason: ProcessPairHaltReason.UnexpectedError,
                });
                // set the span status to unexpected error
                span.setStatus({ code: SpanStatusCode.ERROR, message: pair + ": unexpected error" });
            }
        }
        span.end();
    }
    return reports;
};

/**
 * Processes an pair order by trying to clear it against an onchain liquidity and reporting the result
 */
async function processPair(args) {
    const {
        config,
        orderPairObject,
        viemClient,
        dataFetcher,
        signer,
        flashbotSigner,
        arb,
        orderbook,
        pair,
    } = args;

    const spanAttributes = {};
    const result = {
        reason: undefined,
        error: undefined,
        report: undefined,
        spanAttributes,
    };

    spanAttributes["details.orders"] = orderPairObject.takeOrders.map(v => v.id);
    spanAttributes["details.pair"] = pair;

    const fromToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.sellTokenDecimals,
        address: orderPairObject.sellToken,
        symbol: orderPairObject.sellTokenSymbol
    });
    const toToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.buyTokenDecimals,
        address: orderPairObject.buyToken,
        symbol: orderPairObject.buyTokenSymbol
    });

    // get vault balance
    let vaultBalance;
    try {
        vaultBalance = await getVaultBalance(
            orderPairObject,
            orderbook.address,
            // if on test, use test hardhat viem client
            config.isTest ? config.testViemClient : viemClient,
            config.isTest ? "0xcA11bde05977b3631167028862bE2a173976CA11" : undefined
        );
        if (vaultBalance.isZero()) {
            result.report = {
                status: ProcessPairReportStatus.EmptyVault,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            return result;
        }
    } catch(e) {
        result.error = e;
        result.reason = ProcessPairHaltReason.FailedToGetVaultBalance;
        throw result;
    }

    // get gas price
    let gasPrice;
    try {
        // only for test case
        if (config.isTest && config.testType === "gas-price") throw "gas-price";

        gasPrice = await signer.provider.getGasPrice();
        spanAttributes["details.gasPrice"] = gasPrice.toString();
    } catch(e) {
        result.reason = ProcessPairHaltReason.FailedToGetGasPrice;
        result.error = e;
        throw result;
    }

    // get eth price
    let ethPrice;
    if (config.gasCoveragePercentage !== "0") {
        try {
            const options = {
                fetchPoolsTimeout: 10000,
                memoize: true,
            };
            // pin block number for test case
            if (config.isTest && config.testBlockNumber) {
                options.blockNumber = config.testBlockNumber;
            }
            ethPrice = await getEthPrice(
                config,
                orderPairObject.buyToken,
                orderPairObject.buyTokenDecimals,
                gasPrice,
                dataFetcher,
                options
            );
            if (!ethPrice) {
                result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
                return Promise.reject(result);
            }
            else spanAttributes["details.ethPrice"] = ethPrice;
        } catch(e) {
            result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
            result.error = e;
            throw result;
        }
    }
    else ethPrice = "0";

    // get pool details
    try {
        // only for test case
        if (config.isTest && config.testType === "pools") throw "pools";
        const options = {
            fetchPoolsTimeout: 30000,
            memoize: true,
        };
        // pin block number for test case
        if (config.isTest && config.testBlockNumber) {
            options.blockNumber = config.testBlockNumber;
        }
        await dataFetcher.fetchPoolsForToken(
            fromToken,
            toToken,
            undefined,
            options
        );
    } catch(e) {
        result.reason = ProcessPairHaltReason.FailedToGetPools;
        result.error = e;
        throw result;
    }

    // execute maxInput discovery dryrun logic
    let rawtx, gasCostInToken, takeOrdersConfigStruct, price, routeVisual, maximumInput;
    if (config.bundle) {
        try {
            const dryrunResult = await dryrun(
                0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                vaultBalance,
                gasPrice,
                arb,
                ethPrice,
                config,
            );
            ({
                rawtx,
                gasCostInToken,
                takeOrdersConfigStruct,
                price,
                routeVisual,
                maximumInput,
            } = dryrunResult.value);
            for (attrKey in dryrunResult.spanAttributes) {
                spanAttributes[attrKey] = dryrunResult.spanAttributes[attrKey];
            }
        } catch(e) {
            if (e.reason === DryrunHaltReason.NoWalletFund) {
                result.reason = ProcessPairHaltReason.NoWalletFund;
                throw result;
            }
            if (e.reason === DryrunHaltReason.NoRoute) {
                result.reason = ProcessPairHaltReason.NoRoute;
                throw result;
            }
            // record all span attributes in case neither of above errors were present
            for (attrKey in e.spanAttributes) {
                spanAttributes[attrKey] = e.spanAttributes[attrKey];
            }
            rawtx = undefined;
        }
    } else {
        const promises = [];
        for (let j = 1; j < config.retries + 1; j++) {
            promises.push(
                dryrun(
                    j,
                    orderPairObject,
                    dataFetcher,
                    fromToken,
                    toToken,
                    signer,
                    vaultBalance,
                    gasPrice,
                    arb,
                    ethPrice,
                    config,
                )
            );
        }
        const allPromises = await Promise.allSettled(promises);

        let choice;
        if (allPromises.some(v => v.status === "fulfilled")) {
            for (let j = 0; j < allPromises.length; j++) {
                if (allPromises[j].status === "fulfilled") {
                    if (
                        !choice ||
                        choice.maximumInput.lt(allPromises[j].value.value.maximumInput)
                    ) {
                        for (attrKey in allPromises[j].value.spanAttributes) {
                            spanAttributes[attrKey] = allPromises[j].value.spanAttributes[attrKey];
                        }
                        choice = allPromises[j].value.value;
                    }
                }
            }
        } else {
            for (let j = 0; j < allPromises.length; j++) {
                if (allPromises[j].reason.reason === DryrunHaltReason.NoWalletFund) {
                    result.reason = ProcessPairHaltReason.NoWalletFund;
                    throw result;
                }
                if (allPromises[j].reason.reason === DryrunHaltReason.NoRoute) {
                    result.reason = ProcessPairHaltReason.NoRoute;
                    throw result;
                }
            }
            // record all retries span attributes in case neither of above errors were present
            if (allPromises.length === 1) {
                for (attrKey in allPromises[0].reason.spanAttributes) {
                    spanAttributes[
                        "details." + attrKey
                    ] = allPromises[0].reason.spanAttributes[attrKey];
                }
            } else {
                spanAttributes["details.retries"] = [];
                for (let j = 0; j < allPromises.length; j++) {
                    spanAttributes["details.retries"].push(
                        JSON.stringify(allPromises[j].reason.spanAttributes)
                    );
                }
            }
        }
        if (choice) {
            ({
                rawtx,
                gasCostInToken,
                takeOrdersConfigStruct,
                price,
                routeVisual,
                maximumInput,
            } = choice);
        }
    }
    if (!rawtx) {
        result.report = {
            status: ProcessPairReportStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        };
        return result;
    }

    // from here on we know an opp is found, so record it in report and in otel span attributes
    result.report = {
        status: ProcessPairReportStatus.FoundOpportunity,
        tokenPair: pair,
        buyToken: orderPairObject.buyToken,
        sellToken: orderPairObject.sellToken,
    };
    spanAttributes["foundOpp"] = true;

    // get block number
    let blockNumber;
    try {
        blockNumber = await signer.provider.getBlockNumber();
        spanAttributes["details.blockNumber"] = blockNumber;
    } catch(e) {
        // dont reject if getting block number fails but just record it,
        // since an opp is found and can ultimately be cleared
        spanAttributes["details.blockNumberError"] = JSON.stringify(getSpanException(e));
    }

    // submit the tx
    let tx, txUrl;
    try {
        spanAttributes["details.route"] = routeVisual;
        spanAttributes["details.maxInput"] = maximumInput.toString();
        spanAttributes["details.marketPrice"] = ethers.utils.formatEther(price);
        spanAttributes["details.gasCostInToken"] = ethers.utils.formatUnits(gasCostInToken, toToken.decimals);

        rawtx.data = arb.interface.encodeFunctionData(
            "arb",
            [
                takeOrdersConfigStruct,
                gasCostInToken.mul(config.gasCoveragePercentage).div("100")
            ]
        );

        // only for test case
        if (config.isTest && config.testType === "tx-fail") throw "tx-fail";

        tx = config.timeout
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

        txUrl = config.chain.blockExplorers.default.url + "/tx/" + tx.hash;
        console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
        spanAttributes["details.txUrl"] = txUrl;
        spanAttributes["details.tx"] = JSON.stringify(tx);
    } catch(e) {
        // record rawtx in case it is not already present in the error
        if (!JSON.stringify(e).includes(rawtx.data)) spanAttributes[
            "details.rawTx"
        ] = JSON.stringify(rawtx);
        result.error = e;
        result.reason = ProcessPairHaltReason.TxFailed;
        throw result;
    }

    // wait for tx receipt
    try {
        // only for test case
        if (config.isTest && config.testType === "tx-mine-fail") throw "tx-mine-fail";

        const receipt = config.timeout
            ? await promiseTimeout(
                tx.wait(),
                config.timeout,
                `Transaction failed to mine after ${config.timeout}ms`
            )
            : await tx.wait();

        if (receipt.status === 1) {
            spanAttributes["didClear"] = true;

            const clearActualAmount = getActualClearAmount(
                arb.address,
                orderbook.address,
                receipt
            );
            const income = getIncome(await signer.getAddress(), receipt);
            const actualGasCost = ethers.BigNumber.from(
                receipt.effectiveGasPrice
            ).mul(receipt.gasUsed);
            const actualGasCostInToken = ethers.utils.parseUnits(
                ethPrice
            ).mul(
                actualGasCost
            ).div(
                "1" + "0".repeat(
                    36 - orderPairObject.buyTokenDecimals
                )
            );
            const netProfit = income
                ? income.sub(actualGasCostInToken)
                : undefined;

            if (income) {
                spanAttributes["details.income"] = ethers.utils.formatUnits(
                    income,
                    orderPairObject.buyTokenDecimals
                );
                spanAttributes["details.netProfit"] = ethers.utils.formatUnits(
                    netProfit,
                    orderPairObject.buyTokenDecimals
                );
            }
            result.report = {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: clearActualAmount.toString(),
                actualGasCost: ethers.utils.formatUnits(actualGasCost),
                actualGasCostInToken: ethers.utils.formatUnits(
                    actualGasCostInToken,
                    orderPairObject.buyTokenDecimals
                ),
                income,
                netProfit,
                clearedOrders: orderPairObject.takeOrders.map(
                    v => v.id
                ),
            };
            return result;
        }
        else {
            spanAttributes["details.receipt"] = JSON.stringify(receipt);
            result.reason = ProcessPairHaltReason.TxMineFailed;
            return Promise.reject(result);
        }
    } catch(e) {
        result.error = e;
        result.reason = ProcessPairHaltReason.TxMineFailed;
        throw result;
    }
}

/**
 * Tries to find the maxInput for an arb tx by doing a binary search
 */
async function dryrun(
    mode,
    bundledOrder,
    dataFetcher,
    fromToken,
    toToken,
    signer,
    vaultBalance,
    gasPrice,
    arb,
    ethPrice,
    config,
) {
    const spanAttributes = {};
    const result = {
        value: undefined,
        reason: undefined,
        spanAttributes,
    };
    let noRoute = true;

    const getRouteProcessorParamsVersion = {
        "3": Router.routeProcessor3Params,
        "3.1": Router.routeProcessor3_1Params,
        "3.2": Router.routeProcessor3_2Params,
        "4": Router.routeProcessor4Params,
    };
    let binarySearchLastHopSuccess = true;
    let maximumInput = vaultBalance;

    const allHopsAttributes = [];
    for (let j = 1; j < config.hops + 1; j++) {
        const hopAttrs = {};
        hopAttrs["maxInput"] = maximumInput.toString();

        const maximumInputFixed = maximumInput.mul(
            "1" + "0".repeat(18 - bundledOrder.sellTokenDecimals)
        );

        const pcMap = dataFetcher.getCurrentPoolCodeMap(
            fromToken,
            toToken
        );
        const route = Router.findBestRoute(
            pcMap,
            config.chain.id,
            fromToken,
            maximumInput.toBigInt(),
            toToken,
            gasPrice.toNumber(),
            // 30e9,
            // providers,
            // poolFilter
        );
        if (route.status == "NoWay" || (config.isTest && config.testType === "no-route")) {
            hopAttrs["route"] = "no-way";
            binarySearchLastHopSuccess = false;
        }
        else {
            // if reached here, a route has been found at least once among all hops
            noRoute = false;

            const rateFixed = ethers.BigNumber.from(route.amountOutBI).mul(
                "1" + "0".repeat(18 - bundledOrder.buyTokenDecimals)
            );
            const price = rateFixed.mul("1" + "0".repeat(18)).div(maximumInputFixed);
            hopAttrs["marketPrice"] = ethers.utils.formatEther(price);

            const routeVisual = [];
            try {
                visualizeRoute(fromToken, toToken, route.legs).forEach(
                    v => {routeVisual.push(v);}
                );
            } catch {
                /**/
            }

            const rpParams = getRouteProcessorParamsVersion["3.2"](
                pcMap,
                route,
                fromToken,
                toToken,
                arb.address,
                config.routeProcessors["3.2"],
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
                maximumIORatio: config.maxRatio ? ethers.constants.MaxUint256 : price,
                orders,
                data: ethers.utils.defaultAbiCoder.encode(
                    ["bytes"],
                    [rpParams.routeCode]
                )
            };

            // building and submit the transaction
            try {
                const rawtx = {
                    data: arb.interface.encodeFunctionData("arb", [takeOrdersConfigStruct, "0"]),
                    to: arb.address,
                    gasPrice
                };

                let blockNumber = await signer.provider.getBlockNumber();
                hopAttrs["blockNumber"] = blockNumber;

                let gasLimit;
                try {
                    if (config.isTest && config.testType === "no-fund") throw "insufficient funds for gas";
                    gasLimit = await signer.estimateGas(rawtx);
                }
                catch(e) {
                    const spanError = getSpanException(e);
                    const errorString = JSON.stringify(spanError);
                    if (
                        errorString.includes("gas required exceeds allowance")
                        || errorString.includes("insufficient funds for gas")
                    ) {
                        hopAttrs["error"] = spanError;
                        result.reason = DryrunHaltReason.NoWalletFund;
                        return Promise.reject(result);
                    }
                    // only record the last error for traces
                    if (j === config.hops) {
                        hopAttrs["route"] = routeVisual;
                        hopAttrs["error"] = spanError;
                    }
                    throw "noopp";
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

                if (config.gasCoveragePercentage !== "0") {
                    const headroom = (
                        Number(config.gasCoveragePercentage) * 1.05
                    ).toFixed();
                    rawtx.data = arb.interface.encodeFunctionData(
                        "arb",
                        [
                            takeOrdersConfigStruct,
                            gasCostInToken.mul(headroom).div("100")
                        ]
                    );

                    blockNumber = await signer.provider.getBlockNumber();
                    hopAttrs["blockNumber"] = blockNumber;

                    try {
                        await signer.estimateGas(rawtx);
                    }
                    catch(e) {
                        const spanError = getSpanException(e);
                        const errorString = JSON.stringify(spanError);
                        if (
                            errorString.includes("gas required exceeds allowance")
                            || errorString.includes("insufficient funds for gas")
                        ) {
                            hopAttrs["error"] = spanError;
                            result.reason = DryrunHaltReason.NoWalletFund;
                            return Promise.reject(result);
                        }
                        if (j === config.hops) {
                            hopAttrs["route"] = routeVisual;
                            hopAttrs["gasCostInToken"] = ethers.utils.formatUnits(
                                gasCostInToken,
                                toToken.decimals
                            );
                            hopAttrs["error"] = spanError;
                        }
                        throw "noopp";
                    }
                }
                binarySearchLastHopSuccess = true;
                if (j == 1 || j == config.hops) {
                    // we dont need allHopsAttributes in case an opp is found
                    // since all those data will be available in the submitting tx
                    spanAttributes["oppBlockNumber"] = blockNumber;
                    spanAttributes["foundOpp"] = true;
                    result.value = {
                        rawtx,
                        maximumInput,
                        gasCostInToken,
                        takeOrdersConfigStruct,
                        price,
                        routeVisual
                    };
                    return result;
                }
            }
            catch (error) {
                binarySearchLastHopSuccess = false;
                if (error !== "noopp") {
                    hopAttrs["error"] = getSpanException(error);
                    // reason, code, method, transaction, error, stack, message
                }
            }
        }
        allHopsAttributes.push(JSON.stringify(hopAttrs));
        maximumInput = binarySearchLastHopSuccess
            ? maximumInput.add(vaultBalance.div(2 ** j))
            : maximumInput.sub(vaultBalance.div(2 ** j));
    }
    // in case no opp is found, allHopsAttributes will be included
    spanAttributes["hops"] = allHopsAttributes;

    if (noRoute) result.reason = DryrunHaltReason.NoRoute;
    else result.reason = DryrunHaltReason.NoOpportunity;

    return Promise.reject(result);
}

module.exports = {
    processOrders,
    processPair,
    ProcessPairHaltReason,
    ProcessPairReportStatus,
    DryrunHaltReason,
};
