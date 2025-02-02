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
    encodeFunctionData,
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
 * Get the bounty check ensure task bytecode
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExcepted - Minimum expected amount
 */
export function getBountyEnsureBytecode(
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExcepted: BigNumber,
    sender: string,
): string {
    const inputPrice = inputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const outputPrice = outputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const minimum = minimumExcepted.toHexString().substring(2).padStart(64, "0");
    const msgSender = sender.substring(2).padStart(64, "0").toLowerCase();
    // rainlang bytecode:
    // :ensure(equal-to(sender context<0 0>()) \"unknown sender\"),
    // :ensure(
    //   greater-than-or-equal-to(
    //     add(
    //       mul(inputToEthPrice context<1 0>())
    //       mul(outputToEthPrice context<1 1>())
    //     )
    //     minimumExcepted
    //   )
    //   \"minimum sender output\"
    // );
    return `0x0000000000000000000000000000000000000000000000000000000000000006${msgSender}8e756e6b6e6f776e2073656e6465720000000000000000000000000000000000${inputPrice}${outputPrice}${minimum}956d696e696d756d2073656e646572206f7574707574000000000000000000000000000000000000000000000000000000000000000000000000000000000047010000100500000110000103100000011000001e1200001d020000011000050110000403100101011000033d12000003100001011000023d1200002b120000211200001d020000`;
}

/**
 * Get the bounty check ensure task bytecode for clear2 withdraw
 * @param botAddress - Bot wallet address
 * @param inputToken - Input token address
 * @param outputToken - Output token address
 * @param orgInputBalance - Input token original balance
 * @param orgOutputBalance - Output token original balance
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExcepted - Minimum expected amount
 */
export function getWithdrawEnsureBytecode(
    botAddress: string,
    inputToken: string,
    outputToken: string,
    orgInputBalance: BigNumber,
    orgOutputBalance: BigNumber,
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExcepted: BigNumber,
    sender: string,
): string {
    const bot = botAddress.substring(2).padStart(64, "0");
    const input = inputToken.substring(2).padStart(64, "0");
    const output = outputToken.substring(2).padStart(64, "0");
    const inputBalance = orgInputBalance.toHexString().substring(2).padStart(64, "0");
    const outputBalance = orgOutputBalance.toHexString().substring(2).padStart(64, "0");
    const inputPrice = inputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const outputPrice = outputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const minimum = minimumExcepted.toHexString().substring(2).padStart(64, "0");
    const msgSender = sender.substring(2).padStart(64, "0").toLowerCase();
    // rainlang bytecode:
    // :ensure(equal-to(sender context<0 0>()) \"unknown sender\"),
    // :ensure(
    //   greater-than-or-equal-to(
    //     add(
    //       mul(sub(erc20-balance-of(inputToken botAddress) originalInputBalance) inputToEthPrice)
    //       mul(sub(erc20-balance-of(outputToken botAddress) originalOutputBalance) outputToEthPrice)
    //     )
    //     minimumSenderOutput
    //   )
    //   \"minimumSenderOutput\"
    // );
    return `0x000000000000000000000000000000000000000000000000000000000000000b${msgSender}8e756e6b6e6f776e2073656e6465720000000000000000000000000000000000${input}${bot}${inputBalance}${inputPrice}${output}${outputBalance}${outputPrice}${minimum}936d696e696d756d53656e6465724f75747075740000000000000000000000000000000000000000000000000000000000000000000000000000000000000067010000180700000110000103100000011000001e1200001d0200000110000a011000090110000801100007011000030110000611120000471200003d1200000110000501100004011000030110000211120000471200003d1200002b120000211200001d020000`;
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

// import { readFileSync } from "fs";
import { deployerAbi } from "./abis";
import { BigNumber, ethers, utils } from "ethers";
import { Dispair } from "./types";
import { parseAbi, stringToHex } from "viem";
import { MetaStore, RainDocument } from "@rainlanguage/dotrain";

// const metaStore = new MetaStore(false);
// export const TaskEntryPoint = ["main"] as const;
// export const EnsureBountyDotrain = readFileSync("./tasks/ensure-bounty.rain", {
//     encoding: "utf8",
// });
// export const WithdrawEnsureBountyDotrain = readFileSync("./tasks/withdraw-ensure-bounty.rain", {
//     encoding: "utf8",
// });

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
    const x = `---
#sender ! msg sender
#input-to-eth-price ! input token to eth price
#output-to-eth-price ! output token to eth price
#minimum-expected ! minimum expected bounty

#main
:ensure(equal-to(sender context<0 0>()) "unknown sender"),
total-bounty-eth: add(
    mul(input-to-eth-price context<1 0>())
    mul(output-to-eth-price context<1 1>())
),
:ensure(
    greater-than-or-equal-to(
        total-bounty-eth
        minimum-expected
    )
    "minimum sender output"
);
`;
    const metaStore = new MetaStore(false);
    const rd = RainDocument.create(x, metaStore, [
        ["sender", sender],
        ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
        ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
        ["minimum-expected", utils.formatUnits(minimumExpected)],
    ]);
    const res = await rd.compose(["main"]);
    rd.free();
    metaStore.free();
    return res;
    // const res = await RainDocument.composeText(x, ["main"], metaStore, [
    //     ["sender", sender],
    //     ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
    //     ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
    //     ["minimum-expected", utils.formatUnits(minimumExpected)],
    // ]);
    // metaStore.free();
    // return res;
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
    const x = `---
#sender ! msg sender
#bot-address ! bot wallet adddress as bounty vault owner
#input-token ! input token address
#output-token ! input token address
#input-to-eth-price ! input token to eth price
#output-to-eth-price ! output token to eth price
#org-input-balance ! original balance of the bot input token before clear
#org-output-balance ! original balance of the bot output token before clear
#minimum-expected ! minimum expected bounty

#main
:ensure(equal-to(sender context<0 0>()) "unknown sender"),
input-bounty: sub(
    erc20-balance-of(input-token bot-address)
    org-input-balance
),
output-bounty: sub(
    erc20-balance-of(output-token bot-address)
    org-output-balance
),
total-bounty-eth: add(
    mul(input-bounty input-to-eth-price)
    mul(output-bounty output-to-eth-price)
),
:ensure(
    greater-than-or-equal-to(
        total-bounty-eth
        minimum-expected
    )
    "minimum sender output"
);
`;
    const metaStore = new MetaStore(false);
    const rd = RainDocument.create(x, metaStore, [
        ["sender", sender],
        ["bot-address", botAddress],
        ["input-token", inputToken],
        ["output-token", outputToken],
        ["minimum-expected", utils.formatUnits(minimumExpected)],
        ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
        ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
        ["org-input-balance", utils.formatUnits(orgInputBalance)],
        ["org-output-balance", utils.formatUnits(orgOutputBalance)],
    ]);
    const res = await rd.compose(["main"]);
    rd.free();
    metaStore.free();
    return res;
    // const res = await RainDocument.composeText(x, ["main"], metaStore, [
    //     ["sender", sender],
    //     ["bot-address", botAddress],
    //     ["input-token", inputToken],
    //     ["output-token", outputToken],
    //     ["minimum-expected", utils.formatUnits(minimumExpected)],
    //     ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
    //     ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
    //     ["org-input-balance", utils.formatUnits(orgInputBalance)],
    //     ["org-output-balance", utils.formatUnits(orgOutputBalance)],
    // ]);
    // return res;
}

/**
 * Calls parse2 on a given deployer to parse the given rainlang text
 */
export async function parseRainlang(
    rainlang: string,
    viemClient: ViemClient | PublicClient,
    dispair: Dispair,
): Promise<string> {
    const res = await viemClient.call({
        to: dispair.deployer as `0x${string}`,
        data: encodeFunctionData({
            abi: parseAbi(deployerAbi),
            functionName: "parse2",
            args: [stringToHex(rainlang)],
        }),
    });
    if (!res.data) return "0x";
    else return res.data;
    // return await viemClient.readContract({
    //     address: dispair.deployer as `0x${string}`,
    //     abi: parseAbi(deployerAbi),
    //     functionName: "parse2",
    //     args: [stringToHex(rainlang)],
    // });
}

export function getBountyEnsureRainlangg(
    config: BotConfig,
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExpected: BigNumber,
    sender: string,
): string {
    let rainlang = config.rainlang.rainlang;
    const inputPrice = inputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const outputPrice = outputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const minimum = minimumExpected.toHexString().substring(2).padStart(64, "0");
    const signer = ethers.BigNumber.from(sender).toHexString().substring(2).padStart(64, "0");
    rainlang = rainlang.replaceAll(config.rainlang.signer.substring(2).padStart(64, "0"), signer);
    rainlang = rainlang.replaceAll(
        config.rainlang.inputPrice.substring(2).padStart(64, "0"),
        inputPrice,
    );
    rainlang = rainlang.replaceAll(
        config.rainlang.outputPrice.substring(2).padStart(64, "0"),
        outputPrice,
    );
    rainlang = rainlang.replaceAll(config.rainlang.minimum.substring(2).padStart(64, "0"), minimum);
    return rainlang;
}
