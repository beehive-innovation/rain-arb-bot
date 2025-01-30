import { Contract } from "ethers";
import { PublicClient } from "viem";
import { DataFetcher } from "sushi";
import { Token } from "sushi/currency";
import { findOpp as findInterObOpp } from "./interOrderbook";
import { findOpp as findIntraObOpp } from "./intraOrderbook";
import { findOppWithRetries as findRpOpp } from "./routeProcessor";
import { BotConfig, BundledOrders, ViemClient, DryrunResult, SpanAttrs } from "../types";

/**
 * The main entrypoint for the main logic to find opps.
 * Find opps with different modes (RP, inter-ob) async, and returns the
 * span attributes and a built ready to send tx object if found any or the
 * the one that clears the most for the target order, or rejects if no opp
 * is found by returning the details in span attributes.
 */
export async function findOpp({
    orderPairObject,
    dataFetcher,
    arb,
    genericArb,
    fromToken,
    toToken,
    signer,
    gasPrice,
    config,
    viemClient,
    inputToEthPrice,
    outputToEthPrice,
    orderbooksOrders,
    l1GasPrice,
}: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    dataFetcher: DataFetcher;
    signer: ViemClient;
    arb: Contract;
    genericArb: Contract | undefined;
    orderbooksOrders: BundledOrders[][];
    gasPrice: bigint;
    inputToEthPrice: string;
    outputToEthPrice: string;
    toToken: Token;
    fromToken: Token;
    l1GasPrice: bigint;
}): Promise<DryrunResult> {
    const promises = [
        findRpOpp({
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice: inputToEthPrice,
            config,
            viemClient,
            l1GasPrice,
        }),
        ...(!config.rpOnly
            ? [
                  findIntraObOpp({
                      orderPairObject,
                      signer,
                      gasPrice,
                      inputToEthPrice,
                      outputToEthPrice,
                      config,
                      viemClient,
                      orderbooksOrders,
                      l1GasPrice,
                  }),
                  findInterObOpp({
                      orderPairObject,
                      signer,
                      gasPrice,
                      arb: genericArb!,
                      inputToEthPrice,
                      outputToEthPrice,
                      config,
                      viemClient,
                      orderbooksOrders,
                      l1GasPrice,
                  }),
              ]
            : []),
    ];
    const allResults = await Promise.allSettled(promises);

    if (allResults.some((v) => v.status === "fulfilled")) {
        // pick and return the highest profit
        allResults.forEach((v, i) => {
            if (v.status === "fulfilled") {
                v.value.spanAttributes["clearModePick"] =
                    i === 0 ? "rp4" : i === 1 ? "intra" : "inter";
            }
        });
        const res = allResults.filter(
            (v) => v.status === "fulfilled",
        ) as PromiseFulfilledResult<DryrunResult>[];
        return res.sort((a, b) =>
            b.value.value!.estimatedProfit.lt(a.value.value!.estimatedProfit)
                ? -1
                : b.value.value!.estimatedProfit.gt(a.value.value!.estimatedProfit)
                  ? 1
                  : 0,
        )[0].value;
    } else {
        const spanAttributes: SpanAttrs = {};
        const result = {
            spanAttributes,
            rawtx: undefined,
            oppBlockNumber: undefined,
            noneNodeError: undefined,
        };
        if ((allResults[0] as any)?.reason?.spanAttributes) {
            spanAttributes["routeProcessor"] = JSON.stringify(
                (allResults[0] as any).reason.spanAttributes,
            );
        }
        if ((allResults[1] as any)?.reason?.spanAttributes) {
            spanAttributes["intraOrderbook"] = JSON.stringify(
                (allResults[1] as any).reason.spanAttributes["intraOrderbook"],
            );
        }
        if ((allResults[2] as any)?.reason?.spanAttributes) {
            spanAttributes["interOrderbook"] = JSON.stringify(
                (allResults[2] as any).reason.spanAttributes,
            );
        }
        if ((allResults[0] as any)?.reason?.value?.noneNodeError) {
            result.noneNodeError = (allResults[0] as any).reason.value.noneNodeError;
        } else if (
            result.noneNodeError === undefined &&
            (allResults[1] as any)?.reason?.value?.noneNodeError
        ) {
            result.noneNodeError = (allResults[1] as any).reason.value.noneNodeError;
        } else if (
            result.noneNodeError === undefined &&
            (allResults[2] as any)?.reason?.value?.noneNodeError
        ) {
            result.noneNodeError = (allResults[2] as any).reason.value.noneNodeError;
        }
        throw result;
    }
}
