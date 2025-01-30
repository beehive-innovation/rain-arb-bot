const { assert } = require("chai");
const testData = require("./data");
const { ethers } = require("hardhat");
const { clone } = require("../src/utils");
const { OrderV3 } = require("../src/abis");
const mockServer = require("mockttp").getLocal();
const { encodeQuoteResponse } = require("./utils");
const { checkOwnedOrders } = require("../src/account");
const { decodeAbiParameters, parseAbiParameters } = require("viem");
const {
    utils: { hexlify, randomBytes, keccak256 },
} = require("ethers");
const {
    toOrder,
    getOrderPairs,
    quoteSingleOrder,
    prepareOrdersForRound,
    getOrderbookOwnersProfileMapFromSg,
    buildOtovMap,
    fetchVaultBalances,
    evaluateOwnersLimits,
    resetLimits,
    downscaleProtection,
} = require("../src/order");

describe("Test order", async function () {
    beforeEach(() => mockServer.start(8081));
    afterEach(() => mockServer.stop());

    const getOrders = () => {
        const order1 = {
            id: "0x004349d76523bce3b6aeec93cf4c2a396b9cb71bc07f214e271cab363a0c89eb",
            orderHash: "0x004349d76523bce3b6aeec93cf4c2a396b9cb71bc07f214e271cab363a0c89eb",
            owner: "0x0f47a0c7f86a615606ca315ad83c3e302b474bd6",
            orderBytes: "",
            active: true,
            nonce: `0x${"0".repeat(64)}`,
            orderbook: {
                id: `0x${"2".repeat(40)}`,
            },
            inputs: [
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
                        decimals: 6,
                        symbol: "USDT",
                    },
                },
            ],
            outputs: [
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
                        decimals: 18,
                        symbol: "WMATIC",
                    },
                },
            ],
        };
        const orderStruct1 = getOrderStruct(order1);
        const orderBytes1 = ethers.utils.defaultAbiCoder.encode([OrderV3], [orderStruct1]);
        order1.orderBytes = orderBytes1;

        const order2 = {
            id: "0x008817a4b6f264326ef14357df54e48b9c064051f54f3877807970bb98096c01",
            orderHash: "0x008817a4b6f264326ef14357df54e48b9c064051f54f3877807970bb98096c01",
            owner: "0x0eb840e5acd0125853ad630663d3a62e673c22e6",
            orderBytes: "",
            active: true,
            nonce: `0x${"0".repeat(64)}`,
            orderbook: {
                id: `0x${"2".repeat(40)}`,
            },
            inputs: [
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
                        decimals: 6,
                        symbol: "USDT",
                    },
                },
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
                        decimals: 18,
                        symbol: "WMATIC",
                    },
                },
            ],
            outputs: [
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
                        decimals: 6,
                        symbol: "USDT",
                    },
                },
                {
                    balance: "1",
                    vaultId: "1",
                    token: {
                        address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
                        decimals: 18,
                        symbol: "WMATIC",
                    },
                },
            ],
        };
        const orderStruct2 = getOrderStruct(order2);
        const orderBytes2 = ethers.utils.defaultAbiCoder.encode([OrderV3], [orderStruct2]);
        order2.orderBytes = orderBytes2;

        return [order1, order2];
    };

    const getNewOrder = (orderbook, owner, token1, token2, nonce) => {
        const order = {
            id: "",
            orderHash: "",
            owner,
            orderBytes: "",
            active: true,
            nonce: `0x${nonce.toString().repeat(64)}`,
            orderbook: {
                id: orderbook,
            },
            inputs: [
                {
                    balance: "1",
                    vaultId: "0x01",
                    token: token1,
                },
            ],
            outputs: [
                {
                    balance: "1",
                    vaultId: "0x01",
                    token: token2,
                },
            ],
        };
        const orderStruct = getOrderStruct(order);
        const orderBytes = ethers.utils.defaultAbiCoder.encode([OrderV3], [orderStruct]);
        order.orderBytes = orderBytes;
        order.struct = orderStruct;
        order.id = keccak256(orderBytes);
        order.orderHash = keccak256(orderBytes);
        return order;
    };

    it("should single quote order", async function () {
        const orderbook = `0x${"2".repeat(40)}`;
        const orderDetails = {
            orderbook: orderbook,
            takeOrders: [
                {
                    id: `0x${"1".repeat(64)}`,
                    quote: {
                        maxOutput: ethers.BigNumber.from("33"),
                        ratio: ethers.BigNumber.from("44"),
                    },
                    takeOrder: {
                        order: {
                            owner: `0x${"2".repeat(40)}`,
                            evaluable: {
                                interpreter: `0x${"2".repeat(40)}`,
                                store: `0x${"2".repeat(40)}`,
                                bytecode: "0x",
                            },
                            validInputs: [
                                {
                                    token: `0x${"2".repeat(40)}`,
                                    decimals: 18,
                                    vaultId: ethers.BigNumber.from("1"),
                                },
                            ],
                            validOutputs: [
                                {
                                    token: `0x${"2".repeat(40)}`,
                                    decimals: 18,
                                    vaultId: ethers.BigNumber.from("1"),
                                },
                            ],
                            nonce: `0x${"1".repeat(64)}`,
                        },
                        inputIOIndex: 0,
                        outputIOIndex: 0,
                        signedContext: [],
                    },
                },
            ],
        };
        const viemClient = {
            call: async (args) => {
                if (args?.data?.includes("0xe0e530b7")) {
                    return {
                        data: encodeQuoteResponse([
                            true,
                            ethers.BigNumber.from(1),
                            ethers.BigNumber.from(2),
                        ]),
                    };
                } else {
                    return;
                }
            },
        };
        await quoteSingleOrder(orderDetails, viemClient);
        const expected = {
            maxOutput: ethers.BigNumber.from(1),
            ratio: ethers.BigNumber.from(2),
        };
        assert.deepEqual(orderDetails.takeOrders[0].quote, expected);
    });

    it("should get order pairs", async function () {
        const [order1] = getOrders();
        const orderStruct = toOrder(
            decodeAbiParameters(parseAbiParameters(OrderV3), order1.orderBytes)[0],
        );
        const result = await getOrderPairs(order1.orderHash, orderStruct, undefined, [], order1);
        const expected = [
            {
                buyToken: orderStruct.validInputs[0].token,
                buyTokenSymbol: order1.inputs[0].token.symbol,
                buyTokenDecimals: orderStruct.validInputs[0].decimals,
                sellToken: orderStruct.validOutputs[0].token,
                sellTokenSymbol: order1.outputs[0].token.symbol,
                sellTokenDecimals: orderStruct.validOutputs[0].decimals,
                takeOrder: {
                    id: order1.orderHash,
                    takeOrder: {
                        order: orderStruct,
                        inputIOIndex: 0,
                        outputIOIndex: 0,
                        signedContext: [],
                    },
                },
            },
        ];
        assert.deepEqual(result, expected);
    });

    it("should make orderbook owner order map", async function () {
        const [order1, order2] = getOrders();
        const orderStruct1 = toOrder(
            decodeAbiParameters(parseAbiParameters(OrderV3), order1.orderBytes)[0],
        );
        const orderStruct2 = toOrder(
            decodeAbiParameters(parseAbiParameters(OrderV3), order2.orderBytes)[0],
        );
        const result = await getOrderbookOwnersProfileMapFromSg(
            [order1, order2],
            undefined,
            [],
            {},
        );
        const ownerMap = new Map();
        ownerMap.set(order1.owner.toLowerCase(), {
            limit: 25,
            orders: new Map([
                [
                    order1.orderHash.toLowerCase(),
                    {
                        active: true,
                        order: orderStruct1,
                        takeOrders: [
                            {
                                buyToken: orderStruct1.validInputs[0].token,
                                buyTokenSymbol: order1.inputs[0].token.symbol,
                                buyTokenDecimals: orderStruct1.validInputs[0].decimals,
                                sellToken: orderStruct1.validOutputs[0].token,
                                sellTokenSymbol: order1.outputs[0].token.symbol,
                                sellTokenDecimals: orderStruct1.validOutputs[0].decimals,
                                takeOrder: {
                                    id: order1.orderHash.toLowerCase(),
                                    takeOrder: {
                                        order: orderStruct1,
                                        inputIOIndex: 0,
                                        outputIOIndex: 0,
                                        signedContext: [],
                                    },
                                },
                            },
                        ],
                    },
                ],
            ]),
            lastIndex: 0,
        });
        ownerMap.set(order2.owner.toLowerCase(), {
            limit: 25,
            orders: new Map([
                [
                    order2.orderHash.toLowerCase(),
                    {
                        active: true,
                        order: orderStruct2,
                        takeOrders: [
                            {
                                buyToken: orderStruct2.validInputs[1].token,
                                buyTokenSymbol: order2.inputs[1].token.symbol,
                                buyTokenDecimals: orderStruct2.validInputs[1].decimals,
                                sellToken: orderStruct2.validOutputs[0].token,
                                sellTokenSymbol: order2.outputs[0].token.symbol,
                                sellTokenDecimals: orderStruct2.validOutputs[0].decimals,
                                takeOrder: {
                                    id: order2.orderHash.toLowerCase(),
                                    takeOrder: {
                                        order: orderStruct2,
                                        inputIOIndex: 1,
                                        outputIOIndex: 0,
                                        signedContext: [],
                                    },
                                },
                            },
                            {
                                buyToken: orderStruct2.validInputs[0].token,
                                buyTokenSymbol: order2.inputs[0].token.symbol,
                                buyTokenDecimals: orderStruct2.validInputs[0].decimals,
                                sellToken: orderStruct2.validOutputs[1].token,
                                sellTokenSymbol: order2.outputs[1].token.symbol,
                                sellTokenDecimals: orderStruct2.validOutputs[1].decimals,
                                takeOrder: {
                                    id: order2.orderHash.toLowerCase(),
                                    takeOrder: {
                                        order: orderStruct2,
                                        inputIOIndex: 0,
                                        outputIOIndex: 1,
                                        signedContext: [],
                                    },
                                },
                            },
                        ],
                    },
                ],
            ]),
            lastIndex: 0,
        });
        const expected = new Map([]);
        expected.set(`0x${"2".repeat(40)}`, ownerMap);

        const resultAsArray = Array.from(result).map((v) => [
            v[0],
            Array.from(v[1]).map((e) => [e[0], { ...e[1], orders: Array.from(e[1].orders) }]),
        ]);
        const expectedAsArray = Array.from(expected).map((v) => [
            v[0],
            Array.from(v[1]).map((e) => [e[0], { ...e[1], orders: Array.from(e[1].orders) }]),
        ]);

        assert.deepEqual(resultAsArray, expectedAsArray);
    });

    it("should prepare orders for rounds by specified owner limits", async function () {
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner1 = hexlify(randomBytes(20)).toLowerCase();
        const owner2 = hexlify(randomBytes(20)).toLowerCase();
        const token1 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const token2 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const [order1, order2, order3, order4, order5, order6, order7, order8] = [
            getNewOrder(orderbook, owner1, token1, token2, 1), // owner 1
            getNewOrder(orderbook, owner1, token1, token2, 2), // //
            getNewOrder(orderbook, owner1, token1, token2, 3), // //
            getNewOrder(orderbook, owner1, token1, token2, 4), // //
            getNewOrder(orderbook, owner1, token1, token2, 5), // //
            getNewOrder(orderbook, owner1, token1, token2, 6), // //
            getNewOrder(orderbook, owner2, token2, token1, 1), // owner 2
            getNewOrder(orderbook, owner2, token2, token1, 2), // //
        ];
        const owner1Orders = [order1, order2, order3, order4, order5, order6];
        const owner2Orders = [order7, order8];

        // build orderbook owner map
        const allOrders = await getOrderbookOwnersProfileMapFromSg(
            [order1, order2, order3, order4, order5, order6, order7, order8],
            undefined,
            [],
            { [owner1]: 4, [owner2]: 1 }, // set owner1 limit as 4, owner2 to 1
        );

        // prepare orders for first round
        const result1 = prepareOrdersForRound(allOrders, false);
        const expected1 = [
            [
                {
                    buyToken: token1.address,
                    buyTokenSymbol: token1.symbol,
                    buyTokenDecimals: token1.decimals,
                    sellToken: token2.address,
                    sellTokenSymbol: token2.symbol,
                    sellTokenDecimals: token2.decimals,
                    orderbook,
                    // first 4 owner1 orders for round1, owner1 limit is 4
                    takeOrders: owner1Orders.slice(0, 4).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
                {
                    buyToken: token2.address,
                    buyTokenSymbol: token2.symbol,
                    buyTokenDecimals: token2.decimals,
                    sellToken: token1.address,
                    sellTokenSymbol: token1.symbol,
                    sellTokenDecimals: token1.decimals,
                    orderbook,
                    // first 1 owner2 orders for round1, owner2 limit is 1
                    takeOrders: owner2Orders.slice(0, 1).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
            ],
        ];
        assert.deepEqual(result1, expected1);

        // prepare orders for second round
        const result2 = prepareOrdersForRound(allOrders, false);
        const expected2 = [
            [
                {
                    buyToken: token1.address,
                    buyTokenSymbol: token1.symbol,
                    buyTokenDecimals: token1.decimals,
                    sellToken: token2.address,
                    sellTokenSymbol: token2.symbol,
                    sellTokenDecimals: token2.decimals,
                    orderbook,
                    // first2 and last 2 owner1 orders for round2, owner1 limit is 4
                    takeOrders: [
                        ...owner1Orders.slice(4, owner1Orders.length),
                        ...owner1Orders.slice(0, 2),
                    ].map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
                {
                    buyToken: token2.address,
                    buyTokenSymbol: token2.symbol,
                    buyTokenDecimals: token2.decimals,
                    sellToken: token1.address,
                    sellTokenSymbol: token1.symbol,
                    sellTokenDecimals: token1.decimals,
                    orderbook,
                    // second 1 owner2 orders for round2, owner2 limit is 1
                    takeOrders: owner2Orders.slice(1, owner2Orders.length).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
            ],
        ];
        assert.deepEqual(result2, expected2);

        // prepare orders for 3rd round, so should be back to consuming
        // orders of onwer1 and 2 just like round 1
        const result3 = prepareOrdersForRound(allOrders, false);
        const expected3 = [
            [
                {
                    buyToken: token1.address,
                    buyTokenSymbol: token1.symbol,
                    buyTokenDecimals: token1.decimals,
                    sellToken: token2.address,
                    sellTokenSymbol: token2.symbol,
                    sellTokenDecimals: token2.decimals,
                    orderbook,
                    // last 4 owner1 orders again for round3, owner1 limit is 4
                    takeOrders: owner1Orders.slice(2).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
                {
                    buyToken: token2.address,
                    buyTokenSymbol: token2.symbol,
                    buyTokenDecimals: token2.decimals,
                    sellToken: token1.address,
                    sellTokenSymbol: token1.symbol,
                    sellTokenDecimals: token1.decimals,
                    orderbook,
                    // first 1 owner2 orders again for round3, owner2 limit is 1
                    takeOrders: owner2Orders.slice(0, 1).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
            ],
        ];
        assert.deepEqual(result3, expected3);

        // prepare orders for 4th round
        const result4 = prepareOrdersForRound(allOrders, false);
        const expected4 = [
            [
                {
                    buyToken: token1.address,
                    buyTokenSymbol: token1.symbol,
                    buyTokenDecimals: token1.decimals,
                    sellToken: token2.address,
                    sellTokenSymbol: token2.symbol,
                    sellTokenDecimals: token2.decimals,
                    orderbook,
                    // back to first 4 owner1 orders for round4, owner1 limit is 4
                    takeOrders: owner1Orders.slice(0, 4).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
                {
                    buyToken: token2.address,
                    buyTokenSymbol: token2.symbol,
                    buyTokenDecimals: token2.decimals,
                    sellToken: token1.address,
                    sellTokenSymbol: token1.symbol,
                    sellTokenDecimals: token1.decimals,
                    orderbook,
                    // second 1 owner2 orders for round4, owner2 limit is 1
                    takeOrders: owner2Orders.slice(1).map((v) => ({
                        id: v.id,
                        takeOrder: {
                            order: v.struct,
                            inputIOIndex: 0,
                            outputIOIndex: 0,
                            signedContext: [],
                        },
                    })),
                },
            ],
        ];
        assert.deepEqual(result4, expected4);
    });

    it("should build OTOV map", async function () {
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner1 = hexlify(randomBytes(20)).toLowerCase();
        const owner2 = hexlify(randomBytes(20)).toLowerCase();
        const token1 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const token2 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const [order1, order2] = [
            getNewOrder(orderbook, owner1, token1, token2, 1),
            getNewOrder(orderbook, owner2, token2, token1, 1),
        ];

        // build orderbook owner profile map
        const ownerProfileMap = await getOrderbookOwnersProfileMapFromSg(
            [order1, order2],
            undefined,
            [],
        );

        const result = buildOtovMap(ownerProfileMap);
        const expected = new Map([
            [
                orderbook,
                new Map([
                    [
                        token2.address,
                        new Map([[owner1, [{ vaultId: order1.outputs[0].vaultId, balance: 0n }]]]),
                    ],
                    [
                        token1.address,
                        new Map([[owner2, [{ vaultId: order2.outputs[0].vaultId, balance: 0n }]]]),
                    ],
                ]),
            ],
        ]);

        assert.deepEqual(result, expected);
    });

    it("should get vault balances for owners vaults", async function () {
        // mock viem client
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [8n, 3n, 5n],
        };
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner = hexlify(randomBytes(20)).toLowerCase();
        const token = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const vaults = [
            { vaultId: "1", balance: 0n },
            { vaultId: "2", balance: 0n },
            { vaultId: "3", balance: 0n },
        ];
        await fetchVaultBalances(orderbook, token.address, owner, vaults, viemClient);
        const expected = [
            { vaultId: "1", balance: 8n },
            { vaultId: "2", balance: 3n },
            { vaultId: "3", balance: 5n },
        ];

        assert.deepEqual(vaults, expected);
    });

    it("should evaluate owner limits", async function () {
        // mock viem client
        let counter = -1;
        const viemClient = {
            chain: { id: 137 },
            readContract: async () => 10n,
            multicall: async () => {
                counter++;
                if (counter === 0) return [5n]; // for tkn1 owner2
                if (counter === 1) return [1n]; // for tkn2 owner2
            },
        };
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner1 = hexlify(randomBytes(20)).toLowerCase();
        const owner2 = hexlify(randomBytes(20)).toLowerCase();
        const token1 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const token2 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const [owner1order1, owner2order1, owner1order2, owner2order2] = [
            getNewOrder(orderbook, owner1, token1, token2, 1),
            getNewOrder(orderbook, owner2, token1, token2, 1),
            getNewOrder(orderbook, owner1, token2, token1, 1),
            getNewOrder(orderbook, owner2, token2, token1, 1),
        ];

        // build orderbook owner profile map
        const ownerProfileMap = await getOrderbookOwnersProfileMapFromSg(
            [owner1order1, owner2order1, owner1order2, owner2order2],
            undefined,
            [],
            { [owner1]: 4 }, // set owner1 limit as 4, owner2 unset (defaults to 25)
        );
        const otovMap = new Map([
            [
                orderbook,
                new Map([
                    [
                        token2.address,
                        new Map([
                            [owner1, [{ vaultId: owner1order1.outputs[0].vaultId, balance: 5n }]],
                            [owner2, [{ vaultId: owner2order1.outputs[0].vaultId, balance: 5n }]],
                        ]),
                    ],
                    [
                        token1.address,
                        new Map([
                            [owner1, [{ vaultId: owner1order2.outputs[0].vaultId, balance: 9n }]],
                            [owner2, [{ vaultId: owner2order2.outputs[0].vaultId, balance: 1n }]],
                        ]),
                    ],
                ]),
            ],
        ]);
        await evaluateOwnersLimits(ownerProfileMap, otovMap, viemClient, { [owner1]: 4 });

        // after evaluation, owner 2 limit should be reduced to 10 from the default 25,
        // that is because owner2 relative to owner1 has 2/9 of the total token1 supply
        // and has 1/1 of token2 supply, 1/9 goes into the bracket of 0 - 25%, ie divide factor
        // of 4 and 1/1 goes into barcket of 75 - >100%, ie divide factor of 1, avg of the factors
        // equals to: (1 + 4) / 2 = 2.5 and then the default owner2 limit which was 25,
        // divided by 2/5 equals to 10
        // owner1 limit stays unchanged because it was set originally by the admin
        const expected = await getOrderbookOwnersProfileMapFromSg(
            [owner1order1, owner2order1, owner1order2, owner2order2],
            undefined,
            [],
            { [owner1]: 4, [owner2]: 10 },
        );

        assert.deepEqual(ownerProfileMap, expected);
    });

    it("should reset owners limit", async function () {
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner1 = hexlify(randomBytes(20)).toLowerCase();
        const owner2 = hexlify(randomBytes(20)).toLowerCase();
        const token1 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const token2 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const [order1, order2] = [
            getNewOrder(orderbook, owner1, token1, token2, 1),
            getNewOrder(orderbook, owner2, token2, token1, 1),
        ];

        // build orderbook owner profile map
        const ownerProfileMap = await getOrderbookOwnersProfileMapFromSg(
            [order1, order2],
            undefined,
            [],
            { [owner1]: 4, [owner2]: 10 }, // explicitly set owner2 limit to 10 for reset test
        );
        // reset owner limits, only resets non admin set owner limit, ie only owner2 limit back to 25
        resetLimits(ownerProfileMap, { [owner1]: 4 });

        const expected = await getOrderbookOwnersProfileMapFromSg([order1, order2], undefined, [], {
            [owner1]: 4,
        });
        assert.deepEqual(ownerProfileMap, expected);
    });

    it("should run downscaleProtection", async function () {
        // mock viem client
        let counter = -1;
        const viemClient = {
            chain: { id: 137 },
            readContract: async () => 10n,
            multicall: async () => {
                counter++;
                if (counter === 0) return [5n]; // for tkn1 owner2
                if (counter === 1) return [1n]; // for tkn2 owner2
            },
        };
        const orderbook = hexlify(randomBytes(20)).toLowerCase();
        const owner1 = hexlify(randomBytes(20)).toLowerCase();
        const owner2 = hexlify(randomBytes(20)).toLowerCase();
        const token1 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const token2 = {
            address: hexlify(randomBytes(20)).toLowerCase(),
            decimals: 6,
            symbol: "NewToken1",
        };
        const [owner1order1, owner2order1, owner1order2, owner2order2] = [
            getNewOrder(orderbook, owner1, token1, token2, 1),
            getNewOrder(orderbook, owner2, token1, token2, 1),
            getNewOrder(orderbook, owner1, token2, token1, 1),
            getNewOrder(orderbook, owner2, token2, token1, 1),
        ];

        // build orderbook owner profile map
        const ownerProfileMap = await getOrderbookOwnersProfileMapFromSg(
            [owner1order1, owner2order1, owner1order2, owner2order2],
            undefined,
            [],
            { [owner1]: 4 },
        );
        await downscaleProtection(ownerProfileMap, viemClient, { [owner1]: 4 });
        const expected = await getOrderbookOwnersProfileMapFromSg(
            [owner1order1, owner2order1, owner1order2, owner2order2],
            undefined,
            [],
            { [owner1]: 4, [owner2]: 10 },
        );

        assert.deepEqual(ownerProfileMap, expected);
    });

    it("should check owned orders", async function () {
        const owner = hexlify(randomBytes(20));
        const { orderPairObject1, opposingOrderPairObject } = testData;
        const order1 = clone(orderPairObject1);
        const order2 = clone(opposingOrderPairObject);
        order1.takeOrders[0].takeOrder.order.owner = owner;
        order2.takeOrders[0].takeOrder.order.owner = owner;
        const orders = [order1, order2];
        const config = {
            chain: {
                id: 123,
            },
            mainAccount: {
                account: {
                    address: owner,
                },
            },
            viemClient: {
                multicall: async () => [0n, 10n],
            },
        };
        const result = await checkOwnedOrders(config, orders, hexlify(randomBytes(20)));
        const expected = orders.map((v, i) => ({
            id: v.takeOrders[0].id,
            vaultId:
                v.takeOrders[0].takeOrder.order.validOutputs[
                    v.takeOrders[0].takeOrder.outputIOIndex
                ].vaultId,
            token: v.sellToken,
            symbol: v.sellTokenSymbol,
            decimals: v.sellTokenDecimals,
            orderbook: v.orderbook,
            vaultBalance: ethers.BigNumber.from(i * 10),
        }));
        assert.deepEqual(result, expected);
    });
});

function getOrderStruct(order) {
    return {
        nonce: order.nonce,
        owner: order.owner.toLowerCase(),
        evaluable: {
            interpreter: `0x${"1".repeat(40)}`,
            store: `0x${"2".repeat(40)}`,
            bytecode: "0x1234",
        },
        validInputs: order.inputs.map((v) => ({
            token: v.token.address.toLowerCase(),
            decimals: v.token.decimals,
            vaultId: v.vaultId,
        })),
        validOutputs: order.outputs.map((v) => ({
            token: v.token.address.toLowerCase(),
            decimals: v.token.decimals,
            vaultId: v.vaultId,
        })),
    };
}
