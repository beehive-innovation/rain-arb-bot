import { getSgOrderbooks } from "./sg";
import { sendTransaction } from "./tx";
import { WNATIVE } from "sushi/currency";
import { ChainId, ChainKey } from "sushi/chain";
import { DataFetcher, LiquidityProviders } from "sushi/router";
import {
    BotConfig,
    RpcRecord,
    ViemClient,
    ChainConfig,
    isRpcResponse,
    BotDataFetcher,
} from "./types";
import {
    http,
    fallback,
    HDAccount,
    webSocket,
    PublicClient,
    publicActions,
    walletActions,
    PrivateKeyAccount,
    createWalletClient,
} from "viem";
import {
    STABLES,
    publicClientConfig,
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_3_1_ADDRESS,
    ROUTE_PROCESSOR_3_2_ADDRESS,
} from "sushi/config";

/**
 * List of liquidity provider that are excluded
 */
export const ExcludedLiquidityProviders = [
    LiquidityProviders.CurveSwap,
    LiquidityProviders.Camelot,
    LiquidityProviders.Trident,
] as const;

/**
 * Get the chain config for a given chain id
 * @param chainId - The chain id
 */
export function getChainConfig(chainId: ChainId): ChainConfig {
    const chain = publicClientConfig[chainId].chain;
    if (!chain) throw new Error("network not supported");
    const nativeWrappedToken = WNATIVE[chainId];
    if (!nativeWrappedToken) throw new Error("network not supported");
    const routeProcessors: Record<string, `0x${string}`> = {};
    [
        ["3", ROUTE_PROCESSOR_3_ADDRESS],
        ["3.1", ROUTE_PROCESSOR_3_1_ADDRESS],
        ["3.2", ROUTE_PROCESSOR_3_2_ADDRESS],
        ["4", ROUTE_PROCESSOR_4_ADDRESS],
    ].forEach(([key, addresses]: any[]) => {
        const address = addresses[chainId];
        if (address) {
            routeProcessors[key] = address;
        }
    });
    const stableTokens = (STABLES as any)[chainId];
    return {
        chain,
        nativeWrappedToken,
        routeProcessors,
        stableTokens,
        isSpecialL2: SpecialL2Chains.is(chain.id),
    };
}

/**
 * Creates a viem client
 * @param chainId - The chain id
 * @param rpcs - The RPC urls
 * @param useFallbacks - If fallback RPCs should be used as well or not
 * @param account - If fallback RPCs should be used as well or not
 * @param timeout
 */
export async function createViemClient(
    chainId: ChainId,
    rpcs: string[],
    useFallbacks = false,
    account?: HDAccount | PrivateKeyAccount,
    timeout?: number,
    testClient?: any,
    config?: BotConfig,
): Promise<ViemClient> {
    const configuration = { rank: false, retryCount: 3 };
    const urls = rpcs?.filter((v) => typeof v === "string") ?? [];
    const topRpcs = urls.map((v) =>
        v.startsWith("http")
            ? http(v, {
                  timeout,
                  onFetchRequest: config?.onFetchRequest,
                  onFetchResponse: config?.onFetchResponse,
              })
            : webSocket(v, {
                  timeout,
                  keepAlive: true,
                  reconnect: true,
              }),
    );
    const fallbacks = (fallbackRpcs[chainId] ?? [])
        .filter((v) => !urls.includes(v))
        .map((v) =>
            v.startsWith("http")
                ? http(v, {
                      timeout,
                      onFetchRequest: config?.onFetchRequest,
                      onFetchResponse: config?.onFetchResponse,
                  })
                : webSocket(v, {
                      timeout,
                      keepAlive: true,
                      reconnect: true,
                  }),
        );
    const transport = !topRpcs.length
        ? fallback(fallbacks, configuration)
        : useFallbacks
          ? fallback([...topRpcs, ...fallbacks], configuration)
          : fallback(topRpcs, configuration);

    const client = testClient
        ? ((await testClient({ account }))
              .extend(publicActions)
              .extend(walletActions) as any as ViemClient)
        : (createWalletClient({
              account,
              chain: publicClientConfig[chainId]?.chain,
              transport,
          }).extend(publicActions) as any as ViemClient);

    // set injected properties
    client.BUSY = false;
    client.sendTx = async (tx) => {
        return await sendTransaction(client, tx);
    };

    return client;
}

/**
 * Keeps record of http fetch requests for a http viem client
 */
export function onFetchRequest(request: Request, rpcRecords: Record<string, RpcRecord>) {
    let url = request.url;
    if (!request.url.endsWith("/")) url = url + "/";
    let record = rpcRecords[url];
    if (!record) {
        record = rpcRecords[url] = {
            req: 0,
            success: 0,
            failure: 0,
            cache: {},
        };
    }
    record.req++;
}

/**
 * Keeps record of http fetch responses for a http viem client
 */
export function onFetchResponse(response: Response, rpcRecords: Record<string, RpcRecord>) {
    let url = response.url;
    if (!response.url.endsWith("/")) url = url + "/";
    let record = rpcRecords[url];
    if (!record) {
        record = rpcRecords[url] = {
            req: 0,
            success: 0,
            failure: 0,
            cache: {},
        };
    }
    if (response.status !== 200) record.failure++;

    // for clearing the cache we need to explicitly parse the results even
    // if response status was not 200 but still can hold valid rpc obj id
    response
        .json()
        .then((v) => {
            if (isRpcResponse(v)) {
                if (response.status === 200) {
                    if ("result" in v) record.success++;
                    else record.failure++;
                }
            } else if (response.status === 200) record.failure++;
        })
        .catch(() => {
            if (response.status === 200) record.failure++;
        });
}

/**
 * Instantiates a DataFetcher
 * @param configOrViemClient - The network config data or a viem public client
 * @param liquidityProviders - Array of Liquidity Providers
 */
export async function getDataFetcher(
    configOrViemClient: BotConfig | PublicClient,
    liquidityProviders: LiquidityProviders[] = [],
    useFallbacks = false,
): Promise<BotDataFetcher> {
    try {
        const dataFetcher = new DataFetcher(
            configOrViemClient.chain!.id as ChainId,
            "transport" in configOrViemClient
                ? (configOrViemClient as PublicClient)
                : ((await createViemClient(
                      configOrViemClient.chain.id as ChainId,
                      configOrViemClient.rpc,
                      useFallbacks,
                      undefined,
                      undefined,
                  )) as any as PublicClient),
        );

        // start and immediately stop data fetching as we only want data fetching on demand
        dataFetcher.startDataFetching(!liquidityProviders.length ? undefined : liquidityProviders);
        dataFetcher.stopDataFetching();
        (dataFetcher as any).fetchedPairPools = [];
        return dataFetcher as BotDataFetcher;
    } catch (error) {
        throw "cannot instantiate DataFetcher for this network";
    }
}

/**
 * List of L2 chains that require SEPARATE L1 gas actions.
 * other L2 chains that dont require separate L1 gas actions
 * such as Arbitrum and Polygon zkEvm are excluded, these chains'
 * gas actions are performed the same as usual L1 chains.
 */
export enum SpecialL2Chains {
    BASE = ChainId.BASE,
    OPTIMISM = ChainId.OPTIMISM,
}
export namespace SpecialL2Chains {
    export function is(chainId: number): boolean {
        return Object.values(SpecialL2Chains).includes(chainId as any);
    }
}

/**
 * Get meta info for a bot to post on otel
 */
export async function getMetaInfo(config: BotConfig, sg: string[]): Promise<Record<string, any>> {
    const obs: string[] = [];
    for (const s of sg) {
        try {
            obs.push(...(await getSgOrderbooks(s)));
        } catch {
            /**/
        }
    }
    try {
        return {
            "meta.chain": ChainKey[config.chain.id as ChainId],
            "meta.chainId": config.chain.id,
            "meta.sg": sg,
            "meta.rpArb": config.arbAddress,
            "meta.genericArb": config.genericArbAddress,
            "meta.orderbooks": obs,
        };
    } catch (e) {
        return {};
    }
}

/**
 * Resolves an array of case-insensitive names to LiquidityProviders, ignores the ones that are not valid
 * @param liquidityProviders - List of liquidity providers
 */
export function processLps(liquidityProviders?: string[]): LiquidityProviders[] {
    const LP = Object.values(LiquidityProviders);
    if (
        !liquidityProviders ||
        !Array.isArray(liquidityProviders) ||
        !liquidityProviders.length ||
        !liquidityProviders.every((v) => typeof v === "string")
    ) {
        return LP.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
    }
    const lps: LiquidityProviders[] = [];
    for (let i = 0; i < liquidityProviders.length; i++) {
        const index = LP.findIndex(
            (v) => v.toLowerCase() === liquidityProviders[i].toLowerCase().trim(),
        );
        if (index > -1 && !lps.includes(LP[index])) lps.push(LP[index]);
    }
    return lps.length ? lps : LP.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
}

/**
 * Chain specific fallback data
 */
export const fallbackRpcs: Record<number, readonly string[]> = {
    [ChainId.ARBITRUM_NOVA]: ["https://nova.arbitrum.io/rpc"],
    [ChainId.ARBITRUM]: [
        "https://arbitrum.drpc.org",
        "https://arb-pokt.nodies.app",
        "https://1rpc.io/arb",
        "https://rpc.ankr.com/arbitrum",
        "https://arbitrum-one.public.blastapi.io",
        "https://endpoints.omniatech.io/v1/arbitrum/one/public",
        "https://arb1.croswap.com/rpc",
        "https://arbitrum.blockpi.network/v1/rpc/public",
        "https://arb-mainnet-public.unifra.io",
        "https://lb.drpc.org/ogrpc?network=arbitrum&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.AVALANCHE]: [
        "https://api.avax.network/ext/bc/C/rpc",
        "https://rpc.ankr.com/avalanche",
    ],
    [ChainId.BOBA]: ["https://mainnet.boba.network", "https://lightning-replica.boba.network"],
    [ChainId.BOBA_AVAX]: ["https://avax.boba.network", "https://replica.avax.boba.network"],
    [ChainId.BOBA_BNB]: ["https://bnb.boba.network", "https://replica.bnb.boba.network"],
    [ChainId.BSC]: [
        "https://rpc.ankr.com/bsc",
        "https://bsc.blockpi.network/v1/rpc/public",
        "https://bsc-pokt.nodies.app",
        "https://bscrpc.com",
        "https://1rpc.io/bnb",
        "https://bsc.drpc.org",
        "https://bsc.meowrpc.com",
        "https://binance.llamarpc.com",
        "https://bsc-dataseed.binance.org",
        "https://bsc-dataseed1.binance.org",
        "https://bsc-dataseed2.binance.org",
        "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.BTTC]: ["https://rpc.bittorrentchain.io"],
    [ChainId.CELO]: ["https://forno.celo.org"],
    [ChainId.ETHEREUM]: [
        "https://eth-pokt.nodies.app",
        "https://eth.drpc.org",
        "https://ethereum-rpc.publicnode.com",
        "https://eth.llamarpc.com",
        "https://1rpc.io/eth",
        "https://ethereum.publicnode.com",
        "https://cloudflare-eth.com",
        "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.FANTOM]: [
        "https://rpc.ankr.com/fantom",
        "https://rpc.fantom.network",
        "https://rpc2.fantom.network",
    ],
    [ChainId.FUSE]: ["https://rpc.fuse.io"],
    [ChainId.GNOSIS]: ["https://rpc.ankr.com/gnosis"],
    [ChainId.HARMONY]: ["https://api.harmony.one", "https://rpc.ankr.com/harmony"],
    [ChainId.KAVA]: ["https://evm.kava.io", "https://evm2.kava.io"],
    [ChainId.MOONBEAM]: ["https://rpc.api.moonbeam.network", "https://rpc.ankr.com/moonbeam"],
    [ChainId.MOONRIVER]: ["https://rpc.api.moonriver.moonbeam.network"],
    [ChainId.OPTIMISM]: [
        "https://rpc.ankr.com/optimism",
        "https://optimism-mainnet.public.blastapi.io",
        "https://1rpc.io/op",
        "https://optimism.blockpi.network/v1/rpc/public",
        "https://mainnet.optimism.io",
        "https://lb.drpc.org/ogrpc?network=optimism&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.POLYGON]: [
        "https://polygon.meowrpc.com",
        "https://polygon-rpc.com",
        "https://polygon-pokt.nodies.app",
        "https://polygon-bor-rpc.publicnode.com",
        "https://1rpc.io/matic",
        "https://polygon-mainnet.public.blastapi.io",
        "https://polygon.blockpi.network/v1/rpc/public",
        "https://polygon.llamarpc.com",
        "https://polygon-rpc.com",
        "https://rpc.ankr.com/polygon",
        "https://matic-mainnet.chainstacklabs.com",
        "https://polygon-bor.publicnode.com",
        "https://rpc-mainnet.matic.quiknode.pro",
        "https://rpc-mainnet.maticvigil.com",
    ],
    [ChainId.POLYGON_ZKEVM]: [
        "https://zkevm-rpc.com",
        "https://rpc.ankr.com/polygon_zkevm",
        "https://rpc.polygon-zkevm.gateway.fm",
    ],
    [ChainId.THUNDERCORE]: [
        "https://mainnet-rpc.thundercore.com",
        "https://mainnet-rpc.thundercore.io",
        "https://mainnet-rpc.thundertoken.net",
    ],
    [ChainId.FLARE]: [
        "https://rpc.ankr.com/flare",
        "https://flare-api.flare.network/ext/C/rpc",
        "https://flare.rpc.thirdweb.com",
    ],
    [ChainId.LINEA]: [
        "https://linea.blockpi.network/v1/rpc/public",
        "https://rpc.linea.build",
        "https://linea-rpc.publicnode.com",
        "https://1rpc.io/linea",
        "https://linea.drpc.org",
    ],
    [ChainId.BASE]: [
        "https://base-rpc.publicnode.com",
        "https://base.blockpi.network/v1/rpc/public",
        "https://1rpc.io/base",
        "https://base-pokt.nodies.app",
        "https://mainnet.base.org",
        "https://base.meowrpc.com",
    ],
} as const;

import { readFileSync } from "fs";
import { DeployerAbi } from "./abis";
import { BigNumber, utils } from "ethers";
import { Dispair } from "./types";
import { stringToHex } from "viem";
import { MetaStore, RainDocument } from "@rainlanguage/dotrain";

const metaStore = new MetaStore(false);
export const TaskEntryPoint = ["main"] as const;
export const EnsureBountyDotrain = readFileSync("./tasks/ensure-bounty.rain", {
    encoding: "utf8",
});
export const WithdrawEnsureBountyDotrain = readFileSync("./tasks/withdraw-ensure-bounty.rain", {
    encoding: "utf8",
});

/**
 * Get the bounty check ensure task rainlang
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExpected - Minimum expected amount
 * @param sender - The msg sender
 */
export async function getBountyEnsureRainlang(
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExpected: BigNumber,
    sender: string,
): Promise<string> {
    return await RainDocument.composeText(
        EnsureBountyDotrain,
        TaskEntryPoint as any as string[],
        metaStore,
        [
            ["sender", sender],
            ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
            ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
            ["minimum-expected", utils.formatUnits(minimumExpected)],
        ],
    );
}

/**
 * Get the bounty check ensure task rainlang for clear2 withdraw
 * @param botAddress - Bot wallet address
 * @param inputToken - Input token address
 * @param outputToken - Output token address
 * @param orgInputBalance - Input token original balance
 * @param orgOutputBalance - Output token original balance
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExpected - Minimum expected amount
 * @param sender - The msg sender
 */
export async function getWithdrawEnsureRainlang(
    botAddress: string,
    inputToken: string,
    outputToken: string,
    orgInputBalance: BigNumber,
    orgOutputBalance: BigNumber,
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExpected: BigNumber,
    sender: string,
): Promise<string> {
    return await RainDocument.composeText(
        WithdrawEnsureBountyDotrain,
        TaskEntryPoint as any as string[],
        metaStore,
        [
            ["sender", sender],
            ["bot-address", botAddress],
            ["input-token", inputToken],
            ["output-token", outputToken],
            ["minimum-expected", utils.formatUnits(minimumExpected)],
            ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
            ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
            ["org-input-balance", utils.formatUnits(orgInputBalance)],
            ["org-output-balance", utils.formatUnits(orgOutputBalance)],
        ],
    );
}

/**
 * Calls parse2 on a given deployer to parse the given rainlang text
 */
export async function parseRainlang(
    rainlang: string,
    viemClient: ViemClient | PublicClient,
    dispair: Dispair,
): Promise<string> {
    return await viemClient.readContract({
        address: dispair.deployer as `0x${string}`,
        abi: DeployerAbi,
        functionName: "parse2",
        args: [stringToHex(rainlang)],
    });
}
