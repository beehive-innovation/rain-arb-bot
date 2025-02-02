require("dotenv").config();
const { assert } = require("chai");
const testData = require("./data");
const { ChainKey } = require("sushi");
const { clear } = require("../../src");
const { arbAbis } = require("../../src/abis");
const mockServer = require("mockttp").getLocal();
const { sendTransaction } = require("../../src/tx");
const { ethers, viem, network } = require("hardhat");
const { Resource } = require("@opentelemetry/resources");
const { trace, context } = require("@opentelemetry/api");
const { publicActions, walletActions } = require("viem");
const ERC20Artifact = require("../abis/ERC20Upgradeable.json");
const { abi: orderbookAbi } = require("../abis/OrderBook.json");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { ProcessPairReportStatus } = require("../../src/processOrders");
const { getChainConfig, getDataFetcher } = require("../../src/config");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { prepareOrdersForRound, getOrderbookOwnersProfileMapFromSg } = require("../../src/order");
const {
    arbDeploy,
    encodeMeta,
    getEventArgs,
    randomUint256,
    mockSgFromEvent,
    genericArbrbDeploy,
    encodeQuoteResponse,
    deployOrderBookNPE2,
    rainterpreterNPE2Deploy,
    rainterpreterStoreNPE2Deploy,
    rainterpreterParserNPE2Deploy,
    rainterpreterExpressionDeployerNPE2Deploy,
} = require("../utils");

// run tests on each network in the provided data
for (let i = 0; i < testData.length; i++) {
    const [
        chainId,
        rpc,
        blockNumber,
        tokens,
        addressesWithBalance,
        liquidityProviders,
        deposits,
        orderbookAddress,
        arbAddress,
        botAddress,
    ] = testData[i];

    // if rpc is not defined for a network go to next test
    if (!rpc) continue;

    describe(`Rain Arb Bot E2E Tests on "${ChainKey[chainId]}" Network`, async function () {
        before(() => mockServer.start(8080));
        after(() => mockServer.stop());

        // get config for the chain
        const config = getChainConfig(chainId);

        // get available route processor versions for the chain (only RP4)
        const rpVersions = Object.keys(config.routeProcessors).filter((v) => v === "4");
        if (rpVersions.length === 0)
            assert.fail(`Found no known RP4 contract address on ${ChainKey[chainId]} chain`);

        const exporter = new OTLPTraceExporter();
        const provider = new BasicTracerProvider({
            resource: new Resource({
                [SEMRESATTRS_SERVICE_NAME]: "arb-bot-test",
            }),
        });
        provider.addSpanProcessor(new BatchSpanProcessor(exporter));
        provider.register();
        const tracer = provider.getTracer("arb-bot-tracer");

        config.rpc = [rpc];
        const dataFetcherPromise = getDataFetcher(config, liquidityProviders, true);

        // run tests on each rp version
        for (let j = 0; j < rpVersions.length; j++) {
            const rpVersion = rpVersions[j];

            it(`should clear orders successfully using route processor v${rpVersion}`, async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                const dataFetcher = await dataFetcherPromise;
                const testSpan = tracer.startSpan("test-clearing");
                const ctx = trace.setSpan(context.active(), testSpan);

                // reset network before each test
                await helpers.reset(rpc, blockNumber);
                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTransaction(bot, tx);
                };
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);

                const arb = !arbAddress
                    ? await arbDeploy(orderbook.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(arbAbis, arbAddress);

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    tokens[i].vaultId = ethers.BigNumber.from(randomUint256());
                    tokens[i].depositAmount = ethers.utils.parseUnits(
                        deposits[i] ?? "100",
                        tokens[i].decimals,
                    );
                    // owners.push(
                    //     (await viem.getTestClient({account: addressesWithBalance[i]})).extend(publicActions).extend(walletActions)
                    //     // await ethers.getImpersonatedSigner(addressesWithBalance[i])
                    // );
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook.address, depositConfigStruct.amount);
                    await orderbook
                        .connect(owners[i])
                        .deposit2(
                            depositConfigStruct.token,
                            depositConfigStruct.vaultId,
                            depositConfigStruct.amount,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0 max; :;"
                    const ratio = "0".repeat(64); // 0
                    const maxOutput = "f".repeat(64); // max
                    const bytecode = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput}${ratio}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                decimals: tokens[0].decimals,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                decimals: tokens[i].decimals,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx = await orderbook.connect(owners[i]).addOrder2(addOrderConfig, []);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx, "AddOrderV2", orderbook),
                            orderbook,
                            tokens.map((v) => ({ ...v.contract, knownSymbol: v.symbol })),
                        ),
                    );
                }

                // mock quote responses
                await mockServer
                    .forPost("/rpc")
                    .once()
                    .thenSendJsonRpcResult(
                        encodeQuoteResponse(
                            tokens.slice(1).map((v) => [
                                true, // success
                                v.depositAmount.mul("1" + "0".repeat(18 - v.decimals)), //maxout
                                ethers.constants.Zero, // ratio
                            ]),
                        ),
                    );
                for (let i = 1; i < tokens.length; i++) {
                    const output = tokens[i].depositAmount.mul(
                        "1" + "0".repeat(18 - tokens[i].decimals),
                    );
                    await mockServer
                        .forPost("/rpc")
                        .withBodyIncluding(owners[i].address.substring(2).toLowerCase())
                        .thenSendJsonRpcResult(
                            encodeQuoteResponse([[true, output, ethers.constants.Zero]]),
                        );
                }

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.orderbookAddress = orderbook.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.quoteRpc = [mockServer.url + "/rpc"];
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 100;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };
                orders = prepareOrdersForRound(
                    await getOrderbookOwnersProfileMapFromSg(orders, viemClient, []),
                    false,
                );
                const state = {
                    gasPrice: await bot.getGasPrice(),
                };
                const { reports } = await clear(config, orders, state, tracer, ctx);

                // should have cleared correct number of orders
                assert.ok(reports.length == tokens.length - 1, "Failed to clear all given orders");

                // validate each cleared order
                let inputProfit = ethers.constants.Zero;
                let gasSpent = ethers.constants.Zero;
                for (let i = 0; i < reports.length; i++) {
                    assert.equal(reports[i].status, ProcessPairReportStatus.FoundOpportunity);
                    assert.equal(reports[i].clearedOrders.length, 1);

                    const pair = `${tokens[0].symbol}/${tokens[i + 1].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(reports[i].clearedAmount);
                    const outputVault = await orderbook.vaultBalance(
                        owners[i + 1].address,
                        tokens[i + 1].address,
                        tokens[i + 1].vaultId,
                    );
                    const inputVault = await orderbook.vaultBalance(
                        owners[0].address,
                        tokens[0].address,
                        tokens[0].vaultId,
                    );
                    const botTokenBalance = await tokens[i + 1].contract.balanceOf(
                        bot.account.address,
                    );

                    assert.equal(reports[i].tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[i + 1].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[i + 1].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);
                    assert.ok(
                        originalBotTokenBalances[i + 1].eq(botTokenBalance),
                        `Unexpected current bot ${tokens[i + 1].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(
                        ethers.utils.parseUnits(reports[i].inputTokenIncome),
                    );
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(reports[i].actualGasCost));
                }

                // all input bounties (+ old balance) should be equal to current bot's balance
                assert.ok(
                    originalBotTokenBalances[0]
                        .add(inputProfit)
                        .eq(await tokens[0].contract.balanceOf(bot.account.address)),
                    "Unexpected bot bounty",
                );

                // bot's gas token balance and bounty tokens should be correct
                assert.deepEqual(bot.BOUNTY, [
                    {
                        address: tokens[0].address.toLowerCase(),
                        decimals: tokens[0].decimals,
                        symbol: tokens[0].symbol,
                    },
                ]);
                assert.equal(
                    bot.BALANCE.toString(),
                    (await bot.getBalance({ address: bot.account.address })).toString(),
                );
                assert.equal(
                    gasSpent.toString(),
                    ethers.BigNumber.from("0x4563918244F40000").sub(bot.BALANCE).toString(),
                );

                testSpan.end();
            });

            it("should clear orders successfully using inter-orderbook", async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                const dataFetcher = await dataFetcherPromise;
                const testSpan = tracer.startSpan("test-clearing");
                const ctx = trace.setSpan(context.active(), testSpan);

                // reset network before each test
                await helpers.reset(rpc, blockNumber);

                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTransaction(bot, tx);
                };
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook1 = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);
                const orderbook2 = await deployOrderBookNPE2();
                const genericArb = await genericArbrbDeploy(orderbook2.address);
                const arb = !arbAddress
                    ? await arbDeploy(orderbook1.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(arbAbis, arbAddress);

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    if (i === 0) {
                        tokens[0].vaultIds = [];
                        for (let j = 0; j < tokens.length - 1; j++) {
                            tokens[0].vaultIds.push(ethers.BigNumber.from(randomUint256()));
                        }
                    }
                    tokens[i].vaultId = ethers.BigNumber.from(randomUint256());
                    tokens[i].depositAmount =
                        i > 0
                            ? (tokens[i].depositAmount = ethers.utils.parseUnits(
                                  deposits[i] ?? "100",
                                  tokens[i].decimals,
                              ))
                            : (tokens[i].depositAmount = ethers.utils
                                  .parseUnits(deposits[i] ?? "100", tokens[i].decimals)
                                  .div(tokens.length - 1));
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct1 = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook1.address, depositConfigStruct1.amount);
                    await orderbook1
                        .connect(owners[i])
                        .deposit2(
                            depositConfigStruct1.token,
                            depositConfigStruct1.vaultId,
                            depositConfigStruct1.amount,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0 max; :;"
                    const ratio = "0".repeat(64); // 0
                    const maxOutput = "f".repeat(64); // max
                    const bytecode = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput}${ratio}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig1 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                decimals: tokens[0].decimals,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                decimals: tokens[i].decimals,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx1 = await orderbook1.connect(owners[i]).addOrder2(addOrderConfig1, []);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx1, "AddOrderV2", orderbook1),
                            orderbook1,
                            tokens.map((v) => ({ ...v.contract, knownSymbol: v.symbol })),
                        ),
                    );

                    // opposing orders
                    const depositConfigStruct2 = {
                        token: tokens[0].address,
                        vaultId: tokens[0].vaultIds[i - 1],
                        amount: tokens[0].depositAmount.toString(),
                    };
                    await tokens[0].contract
                        .connect(owners[0])
                        .approve(orderbook2.address, depositConfigStruct2.amount);
                    await orderbook2
                        .connect(owners[0])
                        .deposit2(
                            depositConfigStruct2.token,
                            depositConfigStruct2.vaultId,
                            depositConfigStruct2.amount,
                            [],
                        );
                    const addOrderConfig2 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[i].address,
                                decimals: tokens[i].decimals,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[0].address,
                                decimals: tokens[0].decimals,
                                vaultId: tokens[0].vaultIds[i - 1],
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx2 = await orderbook2.connect(owners[0]).addOrder2(addOrderConfig2, []);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx2, "AddOrderV2", orderbook2),
                            orderbook2,
                            tokens.map((v) => ({ ...v.contract, knownSymbol: v.symbol })),
                        ),
                    );
                }

                // mock quote responses
                for (let i = 1; i < tokens.length; i++) {
                    const output = tokens[i].depositAmount.mul(
                        "1" + "0".repeat(18 - tokens[i].decimals),
                    );
                    await mockServer
                        .forPost("/rpc")
                        .withBodyIncluding(owners[i].address.substring(2).toLowerCase())
                        .thenSendJsonRpcResult(
                            encodeQuoteResponse([[true, output, ethers.constants.Zero]]),
                        );
                }
                await mockServer
                    .forPost("/rpc")
                    .withBodyIncluding(owners[0].address.substring(2).toLowerCase())
                    .thenSendJsonRpcResult(
                        encodeQuoteResponse([[true, ethers.constants.Zero, ethers.constants.Zero]]),
                    );

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.genericArbAddress = genericArb.address;
                config.orderbookAddress = orderbook1.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.quoteRpc = [mockServer.url + "/rpc"];
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 100;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };
                orders = prepareOrdersForRound(
                    await getOrderbookOwnersProfileMapFromSg(orders, viemClient, []),
                    false,
                );
                // mock init quotes
                orders.forEach((ob) => {
                    ob.forEach((pair) => {
                        pair.takeOrders.forEach((takeOrder) => {
                            takeOrder.quote = {
                                ratio: ethers.constants.Zero,
                                maxOutput: tokens
                                    .find(
                                        (t) =>
                                            t.contract.address.toLowerCase() ===
                                            pair.sellToken.toLowerCase(),
                                    )
                                    ?.depositAmount.mul("1" + "0".repeat(18 - ob.decimals)),
                            };
                        });
                    });
                });
                const state = {
                    gasPrice: await bot.getGasPrice(),
                };
                const { reports } = await clear(config, orders, state, tracer, ctx);

                // should have cleared correct number of orders
                assert.ok(
                    reports.length == (tokens.length - 1) * 2,
                    "Failed to clear all given orders",
                );

                // validate each cleared order
                let gasSpent = ethers.constants.Zero;
                let inputProfit = ethers.constants.Zero;
                for (let i = 0; i < reports.length / 2; i++) {
                    assert.equal(reports[i].status, ProcessPairReportStatus.FoundOpportunity);
                    assert.equal(reports[i].clearedOrders.length, 1);

                    const pair = `${tokens[0].symbol}/${tokens[i + 1].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(reports[i].clearedAmount);
                    const outputVault = await orderbook1.vaultBalance(
                        owners[i + 1].address,
                        tokens[i + 1].address,
                        tokens[i + 1].vaultId,
                    );
                    const inputVault = await orderbook1.vaultBalance(
                        owners[0].address,
                        tokens[0].address,
                        tokens[0].vaultId,
                    );
                    const botTokenBalance = await tokens[i + 1].contract.balanceOf(
                        bot.account.address,
                    );

                    assert.equal(reports[i].tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[i + 1].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[i + 1].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);

                    // output bounties should equal to current bot's token balance
                    assert.ok(
                        originalBotTokenBalances[i + 1]
                            .add(
                                ethers.utils.parseUnits(
                                    reports[i].outputTokenIncome,
                                    tokens[i + 1].decimals,
                                ),
                            )
                            .eq(botTokenBalance),
                        `Unexpected current bot ${tokens[i + 1].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(
                        ethers.utils.parseUnits(reports[i].inputTokenIncome),
                    );
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(reports[i].actualGasCost));
                }

                // all input bounties (+ old balance) should be equal to current bot's balance
                assert.ok(
                    originalBotTokenBalances[0]
                        .add(inputProfit)
                        .eq(await tokens[0].contract.balanceOf(bot.account.address)),
                    "Unexpected bot bounty",
                );

                // bot's gas token balance and bounty tokens should be correct
                assert.deepEqual(
                    bot.BOUNTY,
                    tokens.map((v) => ({
                        address: v.address.toLowerCase(),
                        decimals: v.decimals,
                        symbol: v.symbol,
                    })),
                );
                assert.equal(
                    bot.BALANCE.toString(),
                    (await bot.getBalance({ address: bot.account.address })).toString(),
                );
                assert.equal(
                    gasSpent.toString(),
                    ethers.BigNumber.from("0x4563918244F40000").sub(bot.BALANCE).toString(),
                );

                testSpan.end();
            });

            it("should clear orders successfully using intra-orderbook", async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                const dataFetcher = await dataFetcherPromise;
                const testSpan = tracer.startSpan("test-clearing");
                const ctx = trace.setSpan(context.active(), testSpan);

                // reset network before each test
                await helpers.reset(rpc, blockNumber);

                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTransaction(bot, tx);
                };
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);
                const arb = !arbAddress
                    ? await arbDeploy(orderbook.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(arbAbis, arbAddress);

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    if (i === 0) {
                        tokens[0].vaultIds = [];
                        for (let j = 0; j < tokens.length - 1; j++) {
                            tokens[0].vaultIds.push(ethers.BigNumber.from(randomUint256()));
                        }
                    }
                    tokens[i].vaultId = ethers.BigNumber.from(randomUint256());
                    tokens[i].depositAmount =
                        i > 0
                            ? (tokens[i].depositAmount = ethers.utils.parseUnits(
                                  deposits[i] ?? "100",
                                  tokens[i].decimals,
                              ))
                            : (tokens[i].depositAmount = ethers.utils
                                  .parseUnits(deposits[i] ?? "100", tokens[i].decimals)
                                  .div(tokens.length - 1));
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct1 = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook.address, depositConfigStruct1.amount);
                    await orderbook
                        .connect(owners[i])
                        .deposit2(
                            depositConfigStruct1.token,
                            depositConfigStruct1.vaultId,
                            depositConfigStruct1.amount,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0.5 max; :;"
                    const ratio1 = ethers.BigNumber.from("500000000000000000")
                        .toHexString()
                        .substring(2)
                        .padStart(64, "0"); // 0.5
                    const maxOutput1 = "f".repeat(64); // max
                    const bytecode1 = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput1}${ratio1}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig1 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode: bytecode1,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                decimals: tokens[0].decimals,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                decimals: tokens[i].decimals,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx1 = await orderbook.connect(owners[i]).addOrder2(addOrderConfig1, []);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx1, "AddOrderV2", orderbook),
                            orderbook,
                            tokens.map((v) => ({ ...v.contract, knownSymbol: v.symbol })),
                        ),
                    );

                    // opposing orders
                    const depositConfigStruct2 = {
                        token: tokens[0].address,
                        vaultId: tokens[0].vaultIds[i - 1],
                        amount: tokens[0].depositAmount.toString(),
                    };
                    await tokens[0].contract
                        .connect(owners[0])
                        .approve(orderbook.address, depositConfigStruct2.amount);
                    await orderbook
                        .connect(owners[0])
                        .deposit2(
                            depositConfigStruct2.token,
                            depositConfigStruct2.vaultId,
                            depositConfigStruct2.amount,
                            [],
                        );

                    // prebuild bytecode: "_ _: 1 max; :;"
                    const ratio2 = ethers.BigNumber.from("1000000000000000000")
                        .toHexString()
                        .substring(2)
                        .padStart(64, "0"); // 1
                    const maxOutput2 = "f".repeat(64); // max
                    const bytecode2 = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput2}${ratio2}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig2 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode: bytecode2,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[i].address,
                                decimals: tokens[i].decimals,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[0].address,
                                decimals: tokens[0].decimals,
                                vaultId: tokens[0].vaultIds[i - 1],
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx2 = await orderbook.connect(owners[0]).addOrder2(addOrderConfig2, []);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx2, "AddOrderV2", orderbook),
                            orderbook,
                            tokens.map((v) => ({ ...v.contract, knownSymbol: v.symbol })),
                        ),
                    );
                }

                // mock quote responses
                const t0 = [];
                for (let i = 0; i < tokens.length - 1; i++) {
                    t0.push(tokens[0]);
                }
                for (let i = 1; i < tokens.length; i++) {
                    const output = tokens[i].depositAmount.mul(
                        "1" + "0".repeat(18 - tokens[i].decimals),
                    );
                    await mockServer
                        .forPost("/rpc")
                        .withBodyIncluding(owners[i].address.substring(2).toLowerCase())
                        .thenSendJsonRpcResult(
                            encodeQuoteResponse([[true, output, ethers.constants.Zero]]),
                        );
                }
                await mockServer
                    .forPost("/rpc")
                    .withBodyIncluding(owners[0].address.substring(2).toLowerCase())
                    .thenSendJsonRpcResult(
                        encodeQuoteResponse([[true, ethers.constants.Zero, ethers.constants.Zero]]),
                    );

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.orderbookAddress = orderbook.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.quoteRpc = [mockServer.url + "/rpc"];
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 100;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };
                orders = prepareOrdersForRound(
                    await getOrderbookOwnersProfileMapFromSg(orders, viemClient, []),
                    false,
                );

                // mock init quotes
                orders.forEach((ob) => {
                    ob.forEach((pair) => {
                        pair.takeOrders.forEach((takeOrder) => {
                            takeOrder.quote = {
                                ratio: ethers.constants.Zero,
                                maxOutput: tokens
                                    .find(
                                        (t) =>
                                            t.contract.address.toLowerCase() ===
                                            pair.sellToken.toLowerCase(),
                                    )
                                    ?.depositAmount.mul("1" + "0".repeat(18 - ob.decimals)),
                            };
                        });
                    });
                });
                const state = {
                    gasPrice: await bot.getGasPrice(),
                };
                const { reports } = await clear(config, orders, state, tracer, ctx);

                // should have cleared correct number of orders
                assert.ok(
                    reports.length == (tokens.length - 1) * 2,
                    "Failed to clear all given orders",
                );

                // validate each cleared order
                let c = 1;
                let gasSpent = ethers.constants.Zero;
                let inputProfit = ethers.constants.Zero;
                for (let i = 0; i < reports.length; i++) {
                    if (reports[i].status !== ProcessPairReportStatus.FoundOpportunity) continue;
                    assert.equal(reports[i].status, ProcessPairReportStatus.FoundOpportunity);
                    assert.equal(reports[i].clearedOrders.length, 1);

                    const pair = `${tokens[0].symbol}/${tokens[c].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(reports[i].clearedAmount);
                    const outputVault = await orderbook.vaultBalance(
                        owners[c].address,
                        tokens[c].address,
                        tokens[c].vaultId,
                    );
                    const inputVault = await orderbook.vaultBalance(
                        owners[0].address,
                        tokens[0].address,
                        tokens[0].vaultId,
                    );
                    const botTokenBalance = await tokens[c].contract.balanceOf(bot.account.address);

                    assert.equal(reports[i].tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[c].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[c].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);
                    assert.ok(
                        originalBotTokenBalances[c].eq(botTokenBalance),
                        `Unexpected current bot ${tokens[c].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(
                        ethers.utils.parseUnits(reports[i].inputTokenIncome),
                    );
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(reports[i].actualGasCost));
                    c++;
                }
                // all input bounties (+ old balance) should be equal to current bot's balance
                assert.ok(
                    originalBotTokenBalances[0]
                        .add(inputProfit)
                        .eq(await tokens[0].contract.balanceOf(bot.account.address)),
                    "Unexpected bot bounty",
                );

                // bot's gas token balance and bounty tokens should be correct
                assert.deepEqual(bot.BOUNTY, [
                    {
                        address: tokens[0].address.toLowerCase(),
                        decimals: tokens[0].decimals,
                        symbol: tokens[0].symbol,
                    },
                ]);
                assert.equal(
                    bot.BALANCE.toString(),
                    (await bot.getBalance({ address: bot.account.address })).toString(),
                );
                assert.equal(
                    gasSpent.toString(),
                    ethers.BigNumber.from("0x4563918244F40000").sub(bot.BALANCE).toString(),
                );

                testSpan.end();
            });
        }
    });
}
