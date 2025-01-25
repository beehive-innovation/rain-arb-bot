import { PublicClient } from "viem";
import { Token } from "sushi/currency";
import { ChainId, Router } from "sushi";
import { BigNumber, ethers } from "ethers";
import { getDataFetcher } from "../src/config";

/**
 * Gets the route for tokens
 * @param chainId - The network chain id
 * @param rpcs - The rpcs
 * @param sellAmount - The sell amount, should be in onchain token value
 * @param fromTokenAddress - The from token address
 * @param fromTokenDecimals - The from token decimals
 * @param toTokenAddress - The to token address
 * @param toTokenDecimals - The to token decimals
 * @param receiverAddress - The address of the receiver
 * @param routeProcessorAddress - The address of the RouteProcessor contract
 * @param abiencoded - If the result should be abi encoded or not
 */
export const getRouteForTokens = async (
    chainId: number,
    rpcs: string[],
    sellAmount: BigNumber,
    fromTokenAddress: string,
    fromTokenDecimals: number,
    toTokenAddress: string,
    toTokenDecimals: number,
    receiverAddress: string,
    routeProcessorAddress: string,
    abiEncoded = false,
) => {
    const amountIn = sellAmount.toBigInt();
    const fromToken = new Token({
        chainId: chainId,
        decimals: fromTokenDecimals,
        address: fromTokenAddress,
    });
    const toToken = new Token({
        chainId: chainId,
        decimals: toTokenDecimals,
        address: toTokenAddress,
    });
    const dataFetcher = await getDataFetcher({
        chain: { id: chainId },
        rpc: rpcs,
    } as any as PublicClient);
    await dataFetcher.fetchPoolsForToken(fromToken, toToken);
    const pcMap = dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        chainId as ChainId,
        fromToken,
        amountIn,
        toToken,
        Number(await dataFetcher.web3Client.getGasPrice()),
        // providers,
        // poolFilter
    );
    if (route.status == "NoWay") throw "NoWay";
    else {
        let routeText = "";
        route.legs.forEach((v, i) => {
            if (i === 0)
                routeText =
                    routeText +
                    v.tokenTo.symbol +
                    "/" +
                    v.tokenFrom.symbol +
                    "(" +
                    (v as any).poolName +
                    ")";
            else
                routeText =
                    routeText +
                    " + " +
                    v.tokenTo.symbol +
                    "/" +
                    v.tokenFrom.symbol +
                    "(" +
                    (v as any).poolName +
                    ")";
        });
        // eslint-disable-next-line no-console
        console.log("Route portions: ", routeText, "\n");
        const rpParams = Router.routeProcessor4Params(
            pcMap,
            route,
            fromToken,
            toToken,
            receiverAddress as `0x${string}`,
            routeProcessorAddress as `0x${string}`,
            // permits
            // "0.005"
        );
        if (abiEncoded) return ethers.utils.defaultAbiCoder.encode(["bytes"], [rpParams.routeCode]);
        else return rpParams.routeCode;
    }
};
