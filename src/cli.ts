import { config } from "dotenv";
import { isAddress } from "viem";
import { getGasPrice } from "./gas";
import { Command } from "commander";
import { getMetaInfo } from "./config";
import { BigNumber, ethers } from "ethers";
import { Context } from "@opentelemetry/api";
import { sleep, isBigNumberish } from "./utils";
import { getOrderChanges, SgOrder } from "./query";
import { Resource } from "@opentelemetry/resources";
import { getOrderDetails, clear, getConfig } from ".";
import { ErrorSeverity, errorSnapshot } from "./error";
import { Tracer } from "@opentelemetry/sdk-trace-base";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
    BotConfig,
    CliOptions,
    ViemClient,
    BundledOrders,
    OperationState,
    ProcessPairReportStatus,
} from "./types";
import {
    sweepToEth,
    manageAccounts,
    rotateProviders,
    sweepToMainWallet,
    getBatchEthBalance,
} from "./account";
import {
    getOrdersTokens,
    downscaleProtection,
    prepareOrdersForRound,
    getOrderbookOwnersProfileMapFromSg,
    handleAddOrderbookOwnersProfileMap,
    handleRemoveOrderbookOwnersProfileMap,
} from "./order";
import {
    diag,
    trace,
    context,
    DiagLogLevel,
    SpanStatusCode,
    DiagConsoleLogger,
} from "@opentelemetry/api";
import {
    BasicTracerProvider,
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

config();

/**
 * Options specified in env variables
 */
const ENV_OPTIONS = {
    key: process?.env?.BOT_WALLET_PRIVATEKEY,
    mnemonic: process?.env?.MNEMONIC,
    arbAddress: process?.env?.ARB_ADDRESS,
    genericArbAddress: process?.env?.GENERIC_ARB_ADDRESS,
    orderbookAddress: process?.env?.ORDERBOOK_ADDRESS,
    lps: process?.env?.LIQUIDITY_PROVIDERS,
    gasCoverage: process?.env?.GAS_COVER || "100",
    orderHash: process?.env?.ORDER_HASH,
    orderOwner: process?.env?.ORDER_OWNER,
    sleep: process?.env?.SLEEP,
    maxRatio: process?.env?.MAX_RATIO?.toLowerCase() === "true" ? true : false,
    publicRpc: process?.env?.PUBLIC_RPC?.toLowerCase() === "true" ? true : false,
    timeout: process?.env?.TIMEOUT,
    hops: process?.env?.HOPS,
    retries: process?.env?.RETRIES,
    poolUpdateInterval: process?.env?.POOL_UPDATE_INTERVAL,
    walletCount: process?.env?.WALLET_COUNT,
    topupAmount: process?.env?.TOPUP_AMOUNT,
    botMinBalance: process?.env?.BOT_MIN_BALANCE,
    selfFundOrders: process?.env?.SELF_FUND_ORDERS,
    gasPriceMultiplier: process?.env?.GAS_PRICE_MULTIPLIER,
    gasLimitMultiplier: process?.env?.GAS_LIMIT_MULTIPLIER,
    txGas: process?.env?.TX_GAS,
    quoteGas: process?.env?.QUOTE_GAS,
    route: process?.env?.ROUTE,
    dispair: process?.env?.DISPAIR,
    rpOnly: process?.env?.RP_ONLY?.toLowerCase() === "true" ? true : false,
    ownerProfile: process?.env?.OWNER_PROFILE
        ? Array.from(process?.env?.OWNER_PROFILE.matchAll(/[^,\s]+/g)).map((v) => v[0])
        : undefined,
    rpc: process?.env?.RPC_URL
        ? Array.from(process?.env?.RPC_URL.matchAll(/[^,\s]+/g)).map((v) => v[0])
        : undefined,
    writeRpc: process?.env?.WRITE_RPC
        ? Array.from(process?.env?.WRITE_RPC.matchAll(/[^,\s]+/g)).map((v) => v[0])
        : undefined,
    subgraph: process?.env?.SUBGRAPH
        ? Array.from(process?.env?.SUBGRAPH.matchAll(/[^,\s]+/g)).map((v) => v[0])
        : undefined,
};

const getOptions = async (argv: any, version?: string) => {
    const cmdOptions = new Command("node arb-bot")
        .option(
            "-k, --key <private-key>",
            "Private key of wallet that performs the transactions, one of this or --mnemonic should be specified. Will override the 'BOT_WALLET_PRIVATEKEY' in env variables",
        )
        .option(
            "-m, --mnemonic <mnemonic-phrase>",
            "Mnemonic phrase of wallet that performs the transactions, one of this or --key should be specified, requires '--wallet-count' and '--topup-amount'. Will override the 'MNEMONIC' in env variables",
        )
        .option(
            "-r, --rpc <url...>",
            "RPC URL(s) that will be provider for interacting with evm, use different providers if more than 1 is specified to prevent banning. Will override the 'RPC_URL' in env variables",
        )
        .option(
            "-s, --subgraph <url...>",
            "Subgraph URL(s) to read orders details from, can be used in combination with --orders, Will override the 'SUBGRAPH' in env variables",
        )
        .option(
            "--orderbook-address <address>",
            "Option to filter the subgraph query results with address of the deployed orderbook contract, Will override the 'ORDERBOOK_ADDRESS' in env variables",
        )
        .option(
            "--arb-address <address>",
            "Address of the deployed arb contract, Will override the 'ARB_ADDRESS' in env variables",
        )
        .option(
            "--generic-arb-address <address>",
            "Address of the deployed generic arb contract to perform inter-orderbook clears, Will override the 'GENERIC_ARB_ADDRESS' in env variables",
        )
        .option(
            "--dispair <address>",
            "Address of dispair (ExpressionDeployer contract) to use for tasks, Will override the 'DISPAIR' in env variables",
        )
        .option(
            "-l, --lps <string>",
            "List of liquidity providers (dex) to use by the router as one quoted string seperated by a comma for each, example: 'SushiSwapV2,UniswapV3', Will override the 'LIQUIDITY_PROVIDERS' in env variables, if unset will use all available liquidty providers",
        )
        .option(
            "-g, --gas-coverage <integer>",
            "The percentage of gas to cover to be considered profitable for the transaction to be submitted, an integer greater than equal 0, default is 100 meaning full coverage, Will override the 'GAS_COVER' in env variables",
        )
        .option(
            "--order-hash <hash>",
            "Option to filter the subgraph query results with a specific order hash, Will override the 'ORDER_HASH' in env variables",
        )
        .option(
            "--order-owner <address>",
            "Option to filter the subgraph query results with a specific order owner address, Will override the 'ORDER_OWNER' in env variables",
        )
        .option(
            "--sleep <integer>",
            "Seconds to wait between each arb round, default is 10, Will override the 'SLEEP' in env variables",
        )
        .option(
            "--write-rpc <url...>",
            "Option to explicitly use for write transactions, such as flashbots or mev protect rpc to protect against mev attacks, Will override the 'WRITE_RPC' in env variables",
        )
        .option(
            "--timeout <integer>",
            "Optional seconds to wait for the transaction to mine before disregarding it, Will override the 'TIMEOUT' in env variables",
        )
        .option(
            "--max-ratio",
            "Option to maximize maxIORatio, Will override the 'MAX_RATIO' in env variables",
        )
        .option(
            "--hops <integer>",
            "Option to specify how many hops the binary search should do, default is 1 if left unspecified, Will override the 'HOPS' in env variables",
        )
        .option(
            "--retries <integer>",
            "Option to specify how many retries should be done for the same order, max value is 3, default is 1 if left unspecified, Will override the 'RETRIES' in env variables",
        )
        .option(
            "--pool-update-interval <integer>",
            "Option to specify time (in minutes) between pools updates, default is 0 minutes, Will override the 'POOL_UPDATE_INTERVAL' in env variables",
        )
        .option(
            "-w, --wallet-count <integer>",
            "Number of wallet to submit transactions with, requires '--mnemonic'. Will override the 'WALLET_COUNT' in env variables",
        )
        .option(
            "-t, --topup-amount <number>",
            "The initial topup amount of excess wallets, requires '--mnemonic'. Will override the 'TOPUP_AMOUNT' in env variables",
        )
        .option(
            "--bot-min-balance <number>",
            "The minimum gas token balance the bot wallet must have. Will override the 'BOT_MIN_BALANCE' in env variables",
        )
        .option(
            "--self-fund-orders <string>",
            "Specifies owned order to get funded once their vault goes below the specified threshold, example: token,vaultId,threshold,toptupamount;token,vaultId,threshold,toptupamount;... . Will override the 'SELF_FUND_ORDERS' in env variables",
        )
        .option(
            "--owner-profile <OWNER=LIMIT...>",
            "Specifies the owner limit, example: --owner-profile 0x123456=12 . Will override the 'OWNER_PROFILE' in env variables",
        )
        .option(
            "--public-rpc",
            "Allows to use public RPCs as fallbacks, default is false. Will override the 'PUBLIC_RPC' in env variables",
        )
        .option(
            "--route <string>",
            "Specifies the routing mode 'multi' or 'single' or 'full', default is 'single'. Will override the 'ROUTE' in env variables",
        )
        .option(
            "--gas-price-multiplier <integer>",
            "Option to multiply the gas price fetched from the rpc as percentage, default is 107, ie +7%. Will override the 'GAS_PRICE_MULTIPLIER' in env variables",
        )
        .option(
            "--gas-limit-multiplier <integer>",
            "Option to multiply the gas limit estimation from the rpc as percentage, default is 100, ie no change. Will override the 'GAS_LIMIT_MULTIPLIER' in env variables",
        )
        .option(
            "--tx-gas <integer>",
            "Option to set a gas limit for all submitting txs optionally with appended percentage sign to apply as percentage to original gas. Will override the 'TX_GAS' in env variables",
        )
        .option(
            "--quote-gas <integer>",
            "Option to set a static gas limit for quote read calls, default is 1 milion. Will override the 'QUOTE_GAS' in env variables",
        )
        .option(
            "--rp-only",
            "Only clear orders through RP4, excludes intra and inter orderbook clears. Will override the 'RP_ONLY' in env variables",
        )
        .description(
            [
                "A NodeJS app to find and take arbitrage trades for Rain Orderbook orders against some DeFi liquidity providers, requires NodeJS v18 or higher.",
                '- Use "node arb-bot [options]" command alias for running the app from its repository workspace',
                '- Use "arb-bot [options]" command alias when this app is installed as a dependency in another project',
            ].join("\n"),
        )
        .alias("arb-bot")
        .version(version ?? "0.0.0")
        .parse(argv)
        .opts();

    // assigning specified options from cli/env
    cmdOptions.key = cmdOptions.key || getEnv(ENV_OPTIONS.key);
    cmdOptions.mnemonic = cmdOptions.mnemonic || getEnv(ENV_OPTIONS.mnemonic);
    cmdOptions.rpc = cmdOptions.rpc || getEnv(ENV_OPTIONS.rpc);
    cmdOptions.writeRpc = cmdOptions.writeRpc || getEnv(ENV_OPTIONS.writeRpc);
    cmdOptions.arbAddress = cmdOptions.arbAddress || getEnv(ENV_OPTIONS.arbAddress);
    cmdOptions.genericArbAddress =
        cmdOptions.genericArbAddress || getEnv(ENV_OPTIONS.genericArbAddress);
    cmdOptions.orderbookAddress =
        cmdOptions.orderbookAddress || getEnv(ENV_OPTIONS.orderbookAddress);
    cmdOptions.subgraph = cmdOptions.subgraph || getEnv(ENV_OPTIONS.subgraph);
    cmdOptions.lps = cmdOptions.lps || getEnv(ENV_OPTIONS.lps);
    cmdOptions.gasCoverage = cmdOptions.gasCoverage || getEnv(ENV_OPTIONS.gasCoverage);
    cmdOptions.orderHash = cmdOptions.orderHash || getEnv(ENV_OPTIONS.orderHash);
    cmdOptions.orderOwner = cmdOptions.orderOwner || getEnv(ENV_OPTIONS.orderOwner);
    cmdOptions.sleep = cmdOptions.sleep || getEnv(ENV_OPTIONS.sleep);
    cmdOptions.maxRatio = cmdOptions.maxRatio || getEnv(ENV_OPTIONS.maxRatio);
    cmdOptions.timeout = cmdOptions.timeout || getEnv(ENV_OPTIONS.timeout);
    cmdOptions.hops = cmdOptions.hops || getEnv(ENV_OPTIONS.hops);
    cmdOptions.retries = cmdOptions.retries || getEnv(ENV_OPTIONS.retries);
    cmdOptions.poolUpdateInterval =
        cmdOptions.poolUpdateInterval || getEnv(ENV_OPTIONS.poolUpdateInterval);
    cmdOptions.walletCount = cmdOptions.walletCount || getEnv(ENV_OPTIONS.walletCount);
    cmdOptions.topupAmount = cmdOptions.topupAmount || getEnv(ENV_OPTIONS.topupAmount);
    cmdOptions.selfFundOrders = cmdOptions.selfFundOrders || getEnv(ENV_OPTIONS.selfFundOrders);
    cmdOptions.gasPriceMultiplier =
        cmdOptions.gasPriceMultiplier || getEnv(ENV_OPTIONS.gasPriceMultiplier);
    cmdOptions.gasLimitMultiplier =
        cmdOptions.gasLimitMultiplier || getEnv(ENV_OPTIONS.gasLimitMultiplier);
    cmdOptions.txGas = cmdOptions.txGas || getEnv(ENV_OPTIONS.txGas);
    cmdOptions.quoteGas = cmdOptions.quoteGas || getEnv(ENV_OPTIONS.quoteGas);
    cmdOptions.botMinBalance = cmdOptions.botMinBalance || getEnv(ENV_OPTIONS.botMinBalance);
    cmdOptions.ownerProfile = cmdOptions.ownerProfile || getEnv(ENV_OPTIONS.ownerProfile);
    cmdOptions.route = cmdOptions.route || getEnv(ENV_OPTIONS.route);
    cmdOptions.publicRpc = cmdOptions.publicRpc || getEnv(ENV_OPTIONS.publicRpc);
    cmdOptions.rpOnly = cmdOptions.rpOnly || getEnv(ENV_OPTIONS.rpOnly);
    cmdOptions.dispair = cmdOptions.dispair || getEnv(ENV_OPTIONS.dispair);
    if (cmdOptions.ownerProfile) {
        const profiles: Record<string, number> = {};
        cmdOptions.ownerProfile.forEach((v: string) => {
            const parsed = v.split("=");
            if (parsed.length !== 2) {
                throw "Invalid owner profile, must be in form of 'ownerAddress=limitValue'";
            }
            if (!ethers.utils.isAddress(parsed[0])) {
                throw `Invalid owner address: ${parsed[0]}`;
            }
            if (!isBigNumberish(parsed[1]) && parsed[1] !== "max") {
                throw "Invalid owner profile limit, must be an integer gte 0";
            }
            if (parsed[1] === "max") {
                profiles[parsed[0].toLowerCase()] = Number.MAX_SAFE_INTEGER;
            } else {
                const limit = BigNumber.from(parsed[1]);
                profiles[parsed[0].toLowerCase()] = limit.gte(Number.MAX_SAFE_INTEGER.toString())
                    ? Number.MAX_SAFE_INTEGER
                    : limit.toNumber();
            }
        });
        cmdOptions.ownerProfile = profiles;
    }
    if (cmdOptions.lps) {
        cmdOptions.lps = Array.from((cmdOptions.lps as string).matchAll(/[^,\s]+/g)).map(
            (v) => v[0],
        );
    }
    if (cmdOptions.selfFundOrders) {
        cmdOptions.selfFundOrders = Array.from(
            (cmdOptions.selfFundOrders as string).matchAll(/[^;]+/g),
        ).map((v) => {
            const matches = Array.from(v[0].matchAll(/[^,]+/g)).map((e) => e[0]);
            return {
                token: matches[0].toLowerCase(),
                vaultId: matches[1],
                threshold: matches[2],
                topupAmount: matches[3],
            };
        });
    }
    return cmdOptions;
};

export const arbRound = async (
    tracer: Tracer,
    roundCtx: Context,
    options: CliOptions,
    config: BotConfig,
    bundledOrders: BundledOrders[][],
    state: OperationState,
) => {
    return await tracer.startActiveSpan("process-orders", {}, roundCtx, async (span) => {
        const ctx = trace.setSpan(context.active(), span);
        options;
        try {
            let txs;
            let foundOpp = false;
            let didClear = false;
            const { reports = [], avgGasCost = undefined } = await clear(
                config,
                bundledOrders,
                state,
                tracer,
                ctx,
            );
            if (reports && reports.length) {
                txs = reports.map((v) => v.txUrl).filter((v) => !!v);
                if (txs.length) {
                    foundOpp = true;
                    span.setAttribute("txUrls", txs);
                    span.setAttribute("foundOpp", true);
                } else if (
                    reports.some((v) => v.status === ProcessPairReportStatus.FoundOpportunity)
                ) {
                    foundOpp = true;
                    span.setAttribute("foundOpp", true);
                }
                if (
                    reports.some(
                        (v) => v.status === ProcessPairReportStatus.FoundOpportunity && !v.reason,
                    )
                ) {
                    didClear = true;
                    span.setAttribute("didClear", true);
                }
            } else {
                span.setAttribute("didClear", false);
            }
            if (avgGasCost) {
                span.setAttribute("avgGasCost", ethers.utils.formatUnits(avgGasCost));
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return { txs, foundOpp, didClear, avgGasCost };
        } catch (e: any) {
            if (e?.startsWith?.("Failed to batch quote orders")) {
                span.setAttribute("severity", ErrorSeverity.LOW);
                span.setStatus({ code: SpanStatusCode.ERROR, message: e });
            } else {
                const snapshot = errorSnapshot("Unexpected error occured", e);
                span.setAttribute("severity", ErrorSeverity.HIGH);
                span.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }
            span.recordException(e);
            span.setAttribute("didClear", false);
            span.setAttribute("foundOpp", false);
            span.end();
            return { txs: [], foundOpp: false, didClear: false, avgGasCost: undefined };
        }
    });
};

/**
 * CLI startup function
 * @param argv - cli args
 */
export async function startup(argv: any, version?: string, tracer?: Tracer, ctx?: Context) {
    let roundGap = 10000;
    let _poolUpdateInterval = 0;

    const options = await getOptions(argv, version);

    if ((!options.key && !options.mnemonic) || (options.key && options.mnemonic)) {
        throw "undefined wallet, only one of key or mnemonic should be specified";
    }
    if (options.mnemonic) {
        if (!options.walletCount || !options.topupAmount) {
            throw "--wallet-count and --toptup-amount are required when using mnemonic option";
        }
        if (!/^[0-9]+$/.test(options.walletCount)) {
            throw "invalid --wallet-count, it should be an integer greater than equal 0";
        } else {
            options.walletCount = Number(options.walletCount);
        }
        if (!/^[0-9]+(.[0-9]+)?$/.test(options.topupAmount)) {
            throw "invalid --topup-amount, it should be an number greater than equal 0";
        }
    }
    if (options.key) {
        if (!/^(0x)?[a-fA-F0-9]{64}$/.test(options.key)) throw "invalid wallet private key";
    }
    if (!options.rpc) throw "undefined RPC URL";
    if (options.writeRpc) {
        if (
            !Array.isArray(options.writeRpc) ||
            options.writeRpc.some((v) => typeof v !== "string")
        ) {
            throw `Invalid write rpcs: ${options.writeRpc}`;
        }
    }
    if (!options.arbAddress) throw "undefined arb contract address";
    if (options.sleep) {
        if (/^[0-9]+$/.test(options.sleep)) roundGap = Number(options.sleep) * 1000;
        else throw "invalid sleep value, must be an integer greater than equal 0";
    }
    if (options.poolUpdateInterval) {
        if (typeof options.poolUpdateInterval === "number") {
            _poolUpdateInterval = options.poolUpdateInterval;
            if (_poolUpdateInterval < 0 || !Number.isInteger(_poolUpdateInterval))
                throw "invalid poolUpdateInterval value, must be an integer greater than equal zero";
        } else if (
            typeof options.poolUpdateInterval === "string" &&
            /^[0-9]+$/.test(options.poolUpdateInterval)
        ) {
            _poolUpdateInterval = Number(options.poolUpdateInterval);
            if (_poolUpdateInterval < 0)
                throw "invalid poolUpdateInterval value, must be an integer greater than equal zero";
        } else throw "invalid poolUpdateInterval value, must be an integer greater than equal zero";
    }
    if (!options.botMinBalance || !/^[0-9]+(.[0-9]+)?$/.test(options.botMinBalance)) {
        throw "expected a valid value for --bot-min-balance, it should be an number greater than 0";
    }
    if (options.gasPriceMultiplier) {
        if (typeof options.gasPriceMultiplier === "number") {
            if (options.gasPriceMultiplier <= 0 || !Number.isInteger(options.gasPriceMultiplier))
                throw "invalid gasPriceMultiplier value, must be an integer greater than zero";
        } else if (
            typeof options.gasPriceMultiplier === "string" &&
            /^[0-9]+$/.test(options.gasPriceMultiplier)
        ) {
            options.gasPriceMultiplier = Number(options.gasPriceMultiplier);
            if (options.gasPriceMultiplier <= 0)
                throw "invalid gasPriceMultiplier value, must be an integer greater than zero";
        } else throw "invalid gasPriceMultiplier value, must be an integer greater than zero";
    } else {
        options.gasPriceMultiplier = 107;
    }
    if (options.gasLimitMultiplier) {
        if (typeof options.gasLimitMultiplier === "number") {
            if (options.gasLimitMultiplier <= 0 || !Number.isInteger(options.gasLimitMultiplier))
                throw "invalid gasLimitMultiplier value, must be an integer greater than zero";
        } else if (
            typeof options.gasLimitMultiplier === "string" &&
            /^[0-9]+$/.test(options.gasLimitMultiplier)
        ) {
            options.gasLimitMultiplier = Number(options.gasLimitMultiplier);
            if (options.gasLimitMultiplier <= 0)
                throw "invalid gasLimitMultiplier value, must be an integer greater than zero";
        } else throw "invalid gasLimitMultiplier value, must be an integer greater than zero";
    } else {
        options.gasLimitMultiplier = 100;
    }
    if (options.txGas) {
        if (typeof options.txGas !== "string" || !/^[0-9]+%?$/.test(options.txGas)) {
            throw "invalid txGas value, must be an integer greater than zero optionally with appended percentage sign to apply as percentage to original gas";
        }
    }
    if (options.dispair) {
        if (typeof options.dispair !== "string" || !isAddress(options.dispair, { strict: false })) {
            throw "expected dispair (ExpressionDeployer contract) address";
        }
    } else {
        throw "undefined dispair address";
    }
    if (options.quoteGas) {
        try {
            options.quoteGas = BigInt(options.quoteGas);
        } catch {
            throw "invalid quoteGas value, must be an integer greater than equal zero";
        }
    } else {
        options.quoteGas = 1_000_000n; // default
    }
    const poolUpdateInterval = _poolUpdateInterval * 60 * 1000;
    let ordersDetails: SgOrder[] = [];
    if (!process?.env?.CLI_STARTUP_TEST) {
        for (let i = 0; i < 3; i++) {
            try {
                ordersDetails = await getOrderDetails(options.subgraph, {
                    orderHash: options.orderHash,
                    orderOwner: options.orderOwner,
                    orderbook: options.orderbookAddress,
                });
                break;
            } catch (e) {
                if (i != 2) await sleep(10000 * (i + 1));
                else throw e;
            }
        }
    }
    const lastReadOrdersTimestamp = Math.floor(Date.now() / 1000);
    const tokens = getOrdersTokens(ordersDetails);
    options.tokens = tokens;

    // get config
    const config = await getConfig(
        options.rpc,
        options.key ?? options.mnemonic,
        options.arbAddress,
        options as CliOptions,
        tracer,
        ctx,
    );

    // fetch initial gas price on startup
    const state: OperationState = {
        gasPrice: 0n,
        l1GasPrice: 0n,
    };
    await getGasPrice(config, state);

    return {
        roundGap,
        options: options as CliOptions,
        poolUpdateInterval,
        config,
        orderbooksOwnersProfileMap: await getOrderbookOwnersProfileMapFromSg(
            ordersDetails,
            config.viemClient as any as ViemClient,
            tokens,
            (options as CliOptions).ownerProfile,
        ),
        tokens,
        lastReadOrdersTimestamp,
        state,
    };
}

export const main = async (argv: any, version?: string) => {
    // startup otel to collect span, logs, etc
    // diag otel
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

    const exporter = new OTLPTraceExporter(
        process?.env?.HYPERDX_API_KEY
            ? {
                  url: "https://in-otel.hyperdx.io/v1/traces",
                  headers: {
                      authorization: process?.env?.HYPERDX_API_KEY,
                  },
                  compression: CompressionAlgorithm.GZIP,
              }
            : {
                  compression: CompressionAlgorithm.GZIP,
              },
    );
    const provider = new BasicTracerProvider({
        resource: new Resource({
            [SEMRESATTRS_SERVICE_NAME]: process?.env?.TRACER_SERVICE_NAME ?? "arb-bot",
        }),
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    // console spans in case hyperdx api is not defined
    if (!process?.env?.HYPERDX_API_KEY) {
        const consoleExporter = new ConsoleSpanExporter();
        provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));
    }

    provider.register();
    const tracer = provider.getTracer("arb-bot-tracer");

    // parse cli args and startup bot configuration
    const {
        roundGap,
        options,
        poolUpdateInterval,
        config,
        orderbooksOwnersProfileMap,
        tokens,
        lastReadOrdersTimestamp,
        state,
    } = await tracer.startActiveSpan("startup", async (startupSpan) => {
        const ctx = trace.setSpan(context.active(), startupSpan);
        try {
            const result = await startup(argv, version, tracer, ctx);
            startupSpan.setStatus({ code: SpanStatusCode.OK });
            startupSpan.end();
            return result;
        } catch (e: any) {
            const snapshot = errorSnapshot("", e);
            startupSpan.setAttribute("severity", ErrorSeverity.HIGH);
            startupSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            startupSpan.recordException(e);

            // end this span and wait for it to finish
            startupSpan.end();
            await sleep(20000);

            // reject the promise that makes the cli process to exit with error
            return Promise.reject(e);
        }
    });

    const lastReadOrdersMap = options.subgraph.map((v) => ({
        sg: v,
        skip: 0,
    }));
    const day = 24 * 60 * 60 * 1000;
    let lastGasReset = Date.now() + day;
    let lastInterval = Date.now() + poolUpdateInterval;
    let lastUsedAccountIndex = config.accounts.length;
    let avgGasCost: BigNumber | undefined;
    let counter = 1;
    const wgc: ViemClient[] = [];
    const wgcBuffer: { address: string; count: number }[] = [];
    const botMinBalance = ethers.utils.parseUnits(options.botMinBalance);

    // run bot's processing orders in a loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await tracer.startActiveSpan(`round-${counter}`, async (roundSpan) => {
            const roundCtx = trace.setSpan(context.active(), roundSpan);
            const newMeta = await getMetaInfo(config, options.subgraph);
            roundSpan.setAttributes({
                ...newMeta,
                "meta.mainAccount": config.mainAccount.account.address,
                "meta.gitCommitHash": process?.env?.GIT_COMMIT ?? "N/A",
                "meta.dockerTag": process?.env?.DOCKER_TAG ?? "N/A",
            });

            await tracer.startActiveSpan(
                "check-wallet-balance",
                {},
                roundCtx,
                async (walletSpan) => {
                    try {
                        const botGasBalance = ethers.BigNumber.from(
                            await config.viemClient.getBalance({
                                address: config.mainAccount.account.address,
                            }),
                        );
                        config.mainAccount.BALANCE = botGasBalance;
                        if (botMinBalance.gt(botGasBalance)) {
                            const header = `bot main wallet ${
                                config.mainAccount.account.address
                            } is low on gas, expected at least: ${
                                options.botMinBalance
                            }, current: ${ethers.utils.formatUnits(botGasBalance)}, `;
                            const fill = config.accounts.length
                                ? `that wallet is the one that funds the multi wallet, there are still ${
                                      config.accounts.length + 1
                                  } wallets with enough balance in circulation that clear orders, please consider toping up soon`
                                : "it will still work with remaining gas as far as it can, please topup as soon as possible";
                            walletSpan.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: header + fill,
                            });
                            walletSpan.setAttribute(
                                "severity",
                                config.accounts.length ? ErrorSeverity.MEDIUM : ErrorSeverity.HIGH,
                            );
                        }
                    } catch (error) {
                        walletSpan.setStatus({
                            code: SpanStatusCode.ERROR,
                            message:
                                "Failed to check main wallet balance: " + errorSnapshot("", error),
                        });
                        walletSpan.setAttribute("severity", ErrorSeverity.LOW);
                    }
                    walletSpan.end();
                },
            );
            // remove pool memoizer cache on each interval
            let update = false;
            const now = Date.now();
            if (lastInterval <= now) {
                lastInterval = now + poolUpdateInterval;
                update = true;
            }
            try {
                const bundledOrders = prepareOrdersForRound(orderbooksOwnersProfileMap, true);
                await rotateProviders(config, update);
                roundSpan.setAttribute("details.rpc", config.rpc);
                const roundResult = await arbRound(
                    tracer,
                    roundCtx,
                    options,
                    config,
                    bundledOrders,
                    state,
                );
                let txs, foundOpp, didClear, roundAvgGasCost;
                if (roundResult) {
                    txs = roundResult.txs;
                    foundOpp = roundResult.foundOpp;
                    didClear = roundResult.didClear;
                    roundAvgGasCost = roundResult.avgGasCost;
                }
                if (txs && txs.length) {
                    roundSpan.setAttribute("txUrls", txs);
                    roundSpan.setAttribute("foundOpp", true);
                } else if (didClear) {
                    roundSpan.setAttribute("foundOpp", true);
                    roundSpan.setAttribute("didClear", true);
                } else if (foundOpp) {
                    roundSpan.setAttribute("foundOpp", true);
                    roundSpan.setAttribute("didClear", false);
                } else {
                    roundSpan.setAttribute("foundOpp", false);
                    roundSpan.setAttribute("didClear", false);
                }

                // fecth account's balances
                if (foundOpp && config.accounts.length) {
                    try {
                        const balances = await getBatchEthBalance(
                            config.accounts.map((v) => v.account.address),
                            config.viemClient as any as ViemClient,
                        );
                        config.accounts.forEach((v, i) => (v.BALANCE = balances[i]));
                    } catch {
                        /**/
                    }
                }

                // keep avg gas cost
                if (roundAvgGasCost) {
                    const _now = Date.now();
                    if (lastGasReset <= _now) {
                        lastGasReset = _now + day;
                        avgGasCost = undefined;
                    }
                    if (avgGasCost) {
                        avgGasCost = avgGasCost.add(roundAvgGasCost).div(2);
                    } else {
                        avgGasCost = roundAvgGasCost;
                    }
                }
                if (avgGasCost && config.accounts.length) {
                    // manage account by removing those that have ran out of gas
                    // and issuing a new one into circulation
                    lastUsedAccountIndex = await manageAccounts(
                        config,
                        options,
                        avgGasCost,
                        lastUsedAccountIndex,
                        wgc,
                        state,
                        tracer,
                        roundCtx,
                    );
                }

                // sweep tokens and wallets every 100 rounds
                if (counter % 100 === 0) {
                    // try to sweep wallets that still have non transfered tokens to main wallet
                    if (wgc.length) {
                        for (let k = wgc.length - 1; k >= 0; k--) {
                            try {
                                await sweepToMainWallet(
                                    wgc[k],
                                    config.mainAccount,
                                    state,
                                    config,
                                    tracer,
                                    roundCtx,
                                );
                                if (!wgc[k].BOUNTY.length) {
                                    const index = wgcBuffer.findIndex(
                                        (v) => v.address === wgc[k].account.address,
                                    );
                                    if (index > -1) wgcBuffer.splice(index, 1);
                                    wgc.splice(k, 1);
                                } else {
                                    // retry to sweep garbage wallet 3 times before letting it go
                                    const index = wgcBuffer.findIndex(
                                        (v) => v.address === wgc[k].account.address,
                                    );
                                    if (index > -1) {
                                        wgcBuffer[index].count++;
                                        if (wgcBuffer[index].count >= 2) {
                                            wgcBuffer.splice(index, 1);
                                            wgc.splice(k, 1);
                                        }
                                    } else {
                                        wgcBuffer.push({
                                            address: wgc[k].account.address,
                                            count: 0,
                                        });
                                    }
                                }
                            } catch {
                                /**/
                            }
                        }
                    }
                    // try to sweep main wallet's tokens back to eth
                    try {
                        await sweepToEth(config, state, tracer, roundCtx);
                    } catch {
                        /**/
                    }
                }
                roundSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (error: any) {
                const snapshot = errorSnapshot("", error);
                roundSpan.setAttribute("severity", ErrorSeverity.HIGH);
                roundSpan.setAttribute("didClear", false);
                roundSpan.recordException(error);
                roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }
            if (config.accounts.length) {
                const accountsWithBalance: Record<string, string> = {};
                config.accounts.forEach(
                    (v) =>
                        (accountsWithBalance[v.account.address] = ethers.utils.formatUnits(
                            v.BALANCE,
                        )),
                );
                roundSpan.setAttribute("circulatingAccounts", JSON.stringify(accountsWithBalance));
                roundSpan.setAttribute("lastAccountIndex", lastUsedAccountIndex);
            }
            if (avgGasCost) {
                roundSpan.setAttribute("avgGasCost", ethers.utils.formatUnits(avgGasCost));
            }

            try {
                // handle order changes (add/remove)
                roundSpan.setAttribute(
                    "watch-new-orders",
                    JSON.stringify({
                        hasRead: lastReadOrdersMap,
                        startTime: lastReadOrdersTimestamp,
                    }),
                );
                let ordersDidChange = false;
                const results = await Promise.allSettled(
                    lastReadOrdersMap.map((v) =>
                        getOrderChanges(v.sg, lastReadOrdersTimestamp, v.skip, roundSpan),
                    ),
                );
                for (let i = 0; i < results.length; i++) {
                    const res = results[i];
                    if (res.status === "fulfilled") {
                        if (res.value.addOrders.length || res.value.removeOrders.length) {
                            ordersDidChange = true;
                        }
                        lastReadOrdersMap[i].skip += res.value.count;
                        try {
                            await handleAddOrderbookOwnersProfileMap(
                                orderbooksOwnersProfileMap,
                                res.value.addOrders.map((v) => v.order),
                                config.viemClient as any as ViemClient,
                                tokens,
                                options.ownerProfile,
                                roundSpan,
                            );
                        } catch {
                            /**/
                        }
                        try {
                            await handleRemoveOrderbookOwnersProfileMap(
                                orderbooksOwnersProfileMap,
                                res.value.removeOrders.map((v) => v.order),
                                roundSpan,
                            );
                        } catch {
                            /**/
                        }
                    }
                }

                // in case there are new orders or removed order, re evaluate owners limits
                if (ordersDidChange) {
                    await downscaleProtection(
                        orderbooksOwnersProfileMap,
                        config.viemClient as any as ViemClient,
                        options.ownerProfile,
                    );
                }
            } catch {
                /**/
            }

            // report rpcs performance for round
            for (const rpc in config.rpcRecords) {
                await tracer.startActiveSpan("rpc-report", {}, roundCtx, async (span) => {
                    const record = config.rpcRecords[rpc];
                    span.setAttributes({
                        "rpc-url": rpc,
                        "request-count": record.req,
                        "success-count": record.success,
                        "failure-count": record.failure,
                        "timeout-count": record.req - (record.success + record.failure),
                    });
                    record.req = 0;
                    record.success = 0;
                    record.failure = 0;
                    record.cache = {};
                    span.end();
                });
            }

            // eslint-disable-next-line no-console
            console.log(`Starting next round in ${roundGap / 1000} seconds...`, "\n");
            roundSpan.end();
            await sleep(roundGap);
            // give otel some time to export
            await sleep(3000);
        });
        counter++;
    }

    // flush and close the connection.
    // eslint-disable-next-line no-unreachable
    await exporter.shutdown();
    await sleep(10000);
};

function getEnv(value: any): any {
    if (value !== undefined && value !== null) {
        if (typeof value === "string") {
            if (value !== "" && !/^\s*$/.test(value)) return value;
            else return undefined;
        } else return value;
    }
    return undefined;
}
