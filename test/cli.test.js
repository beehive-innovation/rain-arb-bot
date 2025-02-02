require("dotenv").config();
const { assert } = require("chai");
const mockServer = require("mockttp").getLocal();
const { arbRound, startup } = require("../src/cli");
const { trace, context } = require("@opentelemetry/api");
const { Resource } = require("@opentelemetry/resources");
const { BasicTracerProvider } = require("@opentelemetry/sdk-trace-base");
const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
const { sleep } = require("../src/utils");

describe("Test cli", async function () {
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockServer.stop());

    it("return correct result for empty orders array", async function () {
        const provider = new BasicTracerProvider({
            resource: new Resource({
                [SEMRESATTRS_SERVICE_NAME]: "arb-bot-test",
            }),
        });
        const tracer = provider.getTracer("arb-bot-tracer");
        const testSpan = tracer.startSpan("test");
        const ctx = trace.setSpan(context.active(), testSpan);

        // Mock sg status and orders query
        await mockServer
            .forPost("/sg-url")
            .withBodyIncluding("_meta")
            .thenReply(200, JSON.stringify({ data: { _meta: { hasIndexingErrors: false } } }));
        await mockServer
            .forPost("/sg-url")
            .withBodyIncluding("orders")
            .thenReply(200, JSON.stringify({ data: { orders: [] } }));

        // mock provider chain id call
        await mockServer
            .forPost("/rpc-url")
            .withBodyIncluding("eth_chainId")
            .thenReply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "137" }));

        const options = {
            rpc: ["http://localhost:8080/rpc-url"],
            key: "0x" + "1".repeat(64),
            orderbookAddress: "0x" + "0".repeat(40),
            arbAddress: "0x" + "0".repeat(40),
            maxRatio: true,
            subgraph: ["http://localhost:8080/sg-url"],
        };

        const response = await arbRound(tracer, ctx, options, { mainAccount: {} });
        const expected = { txs: [], foundOpp: false, didClear: false, avgGasCost: undefined };
        assert.deepEqual(response, expected);

        testSpan.end();
    });

    it("test cli startup", async function () {
        process.env.CLI_STARTUP_TEST = true;
        const deployer = "0xE7116BC05C8afe25e5B54b813A74F916B5D42aB1";

        try {
            await startup(["", ""]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "undefined wallet, only one of key or mnemonic should be specified";
            assert.equal(error, expected);
        }

        try {
            await startup(["", "", "--key", `0x${"0".repeat(64)}`, "-m", "something"]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "undefined wallet, only one of key or mnemonic should be specified";
            assert.equal(error, expected);
        }

        try {
            await startup(["", "", "--key", `0x${"0".repeat(63)}`]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "invalid wallet private key";
            assert.equal(error, expected);
        }

        try {
            await startup(["", "", "-m", "some-mnemonic"]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected =
                "--wallet-count and --toptup-amount are required when using mnemonic option";
            assert.equal(error, expected);
        }

        try {
            await startup(["", "", "--key", `0x${"0".repeat(64)}`]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "undefined RPC URL";
            assert.equal(error, expected);
        }

        try {
            await startup(["", "", "--key", `0x${"0".repeat(64)}`, "--rpc", "some-rpc"]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "undefined arb contract address";
            assert.equal(error, expected);
        }

        try {
            await startup([
                "",
                "",
                "--key",
                `0x${"0".repeat(64)}`,
                "--rpc",
                "some-rpc",
                "--arb-address",
                `0x${"0".repeat(64)}`,
                "--orderbook-address",
                `0x${"0".repeat(64)}`,
                "--sleep",
                "abcd",
            ]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "invalid sleep value, must be an integer greater than equal 0";
            assert.equal(error, expected);
        }

        try {
            await startup([
                "",
                "",
                "--key",
                `0x${"0".repeat(64)}`,
                "--rpc",
                "some-rpc",
                "--arb-address",
                `0x${"0".repeat(64)}`,
                "--orderbook-address",
                `0x${"0".repeat(64)}`,
                "--pool-update-interval",
                "abcd",
            ]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected =
                "invalid poolUpdateInterval value, must be an integer greater than equal zero";
            assert.equal(error, expected);
        }

        try {
            await startup([
                "",
                "",
                "--key",
                `0x${"0".repeat(64)}`,
                "--rpc",
                "some-rpc",
                "--arb-address",
                `0x${"0".repeat(64)}`,
                "--orderbook-address",
                `0x${"0".repeat(64)}`,
                "--pool-update-interval",
                "10",
            ]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected =
                "expected a valid value for --bot-min-balance, it should be an number greater than 0";
            assert.equal(error, expected);
        }

        try {
            await startup([
                "",
                "",
                "--key",
                `0x${"0".repeat(64)}`,
                "--rpc",
                "some-rpc",
                "--arb-address",
                `0x${"0".repeat(64)}`,
                "--orderbook-address",
                `0x${"0".repeat(64)}`,
                "--pool-update-interval",
                "10",
                "--bot-min-balance",
                "12",
            ]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "undefined dispair address";
            assert.equal(error, expected);
        }

        try {
            await startup([
                "",
                "",
                "--key",
                `0x${"1".repeat(64)}`,
                "--rpc",
                "https://rpc.ankr.com/polygon",
                "--arb-address",
                `0x${"1".repeat(40)}`,
                "--orderbook-address",
                `0x${"2".repeat(40)}`,
                "--pool-update-interval",
                "10",
                "--bot-min-balance",
                "12",
                "--dispair",
                "0x783b82f0fBF6743882072AE2393B108F5938898B",
            ]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "failed to get dispair interpreter address";
            assert.equal(error, expected);
        }

        const result = await startup([
            "",
            "",
            "--key",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            "--rpc",
            "https://rpc.ankr.com/polygon",
            "--arb-address",
            `0x${"1".repeat(40)}`,
            "--orderbook-address",
            `0x${"2".repeat(40)}`,
            "--bot-min-balance",
            "0.123",
            "--gas-price-multiplier",
            "120",
            "--gas-limit-multiplier",
            "110",
            "--tx-gas",
            "123456789",
            "--quote-gas",
            "7777",
            "--rp-only",
            "--dispair",
            deployer,
        ]);
        const expected = {
            roundGap: 10000,
            poolUpdateInterval: 900000,
            config: {
                chain: { id: 137 },
                rpc: ["https://rpc.ankr.com/polygon"],
                orderbookAddress: `0x${"2".repeat(40)}`,
                arbAddress: `0x${"1".repeat(40)}`,
                route: "single",
                rpcRecords: {
                    "https://rpc.ankr.com/polygon/": {
                        req: 4,
                        success: 4,
                        failure: 0,
                        cache: {},
                    },
                },
                gasPriceMultiplier: 120,
                gasLimitMultiplier: 110,
                txGas: "123456789",
                quoteGas: 7777n,
                rpOnly: true,
                dispair: {
                    interpreter: "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8D",
                    store: "0xFA4989F5D49197FD9673cE4B7Fe2A045A0F2f9c8",
                    deployer,
                },
            },
            options: {
                botMinBalance: "0.123",
                gasPriceMultiplier: 120,
                gasLimitMultiplier: 110,
                txGas: "123456789",
                quoteGas: 7777n,
                rpOnly: true,
                dispair: deployer,
            },
        };
        await sleep(1000);
        assert.equal(result.roundGap, expected.roundGap);
        assert.equal(result.poolUpdateInterval, expected.poolUpdateInterval);
        assert.equal(result.config.chain.id, expected.config.chain.id);
        assert.equal(result.config.rpc[0], expected.config.rpc[0]);
        assert.equal(result.config.arbAddress, expected.config.arbAddress);
        assert.equal(result.config.route, expected.config.route);
        assert.deepEqual(result.config.rpcRecords, expected.config.rpcRecords);
        assert.equal(result.options.botMinBalance, expected.options.botMinBalance);
        assert.equal(result.options.gasPriceMultiplier, expected.options.gasPriceMultiplier);
        assert.equal(result.config.gasPriceMultiplier, expected.config.gasPriceMultiplier);
        assert.equal(result.options.gasLimitMultiplier, expected.options.gasLimitMultiplier);
        assert.equal(result.config.gasLimitMultiplier, expected.config.gasLimitMultiplier);
        assert.equal(result.options.txGas, expected.options.txGas);
        assert.equal(result.config.txGas, expected.config.txGas);
        assert.equal(result.options.quoteGas, expected.options.quoteGas);
        assert.equal(result.config.quoteGas, expected.config.quoteGas);
        assert.equal(result.options.rpOnly, expected.options.rpOnly);
        assert.equal(result.config.rpOnly, expected.config.rpOnly);
        assert.deepEqual(result.options.dispair, expected.options.dispair);
        assert.deepEqual(result.config.dispair, expected.config.dispair);
    });
});
