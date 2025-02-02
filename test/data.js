const { Token } = require("sushi/currency");
const { visualizeRoute } = require("../src/utils");
const { ConstantProductRPool } = require("sushi/tines");
const { arbAbis, orderbookAbi } = require("../src/abis");
const { ConstantProductPoolCode, Router } = require("sushi");
const {
    ethers,
    BigNumber,
    utils: { hexlify, randomBytes },
} = require("ethers");

const chainId = 137;
const token1 = {
    address: hexlify(randomBytes(20)),
    decimals: 6,
    symbol: "TOKEN-1",
};
const token2 = {
    address: hexlify(randomBytes(20)),
    decimals: 18,
    symbol: "TOKEN-2",
};
const rp3_2 = hexlify(randomBytes(20));
const arbAddress = hexlify(randomBytes(20));
const orderbookAddress = hexlify(randomBytes(20));
const opposingOrderbookAddress = hexlify(randomBytes(20));
const inputToEthPrice = "0.5";
const outputToEthPrice = "2";
const gasPrice = BigNumber.from("30000000");
const gasLimitEstimation = BigNumber.from("456789");
const arb = new ethers.Contract(arbAddress, arbAbis);
const orderbook = new ethers.Contract(orderbookAddress, orderbookAbi);
const pair = token1.symbol + "/" + token2.symbol;
const txHash = hexlify(randomBytes(32));
const effectiveGasPrice = BigNumber.from("30000000");
const gasUsed = 234567;
const fromToken = new Token({
    chainId: chainId,
    decimals: token2.decimals,
    address: token2.address,
    symbol: token2.symbol,
});
const toToken = new Token({
    chainId: chainId,
    decimals: token1.decimals,
    address: token1.address,
    symbol: token1.symbol,
});
const scannerUrl = "https://scanner.com";
const config = {
    hops: 3,
    retries: 2,
    maxRatio: true,
    concurrency: "max",
    arbAddress,
    orderbookAddress,
    routeProcessors: { 3.2: rp3_2 },
    chain: {
        id: chainId,
        blockExplorers: { default: { url: scannerUrl } },
    },
    gasCoveragePercentage: "100",
    nativeWrappedToken: {
        address: token2.address,
        decimals: token2.decimals,
        symbol: token2.symbol,
    },
    gasPriceMultiplier: 107,
    gasLimitMultiplier: 100,
    dispair: {
        interpreter: hexlify(randomBytes(20)),
        store: hexlify(randomBytes(20)),
        deployer: hexlify(randomBytes(20)),
    },
};

const vaultBalance1 = BigNumber.from("10000000000000000000");
const vaultBalance2 = BigNumber.from("20000000000000000000");
const orderPairObject2 = {
    orderbook: orderbookAddress,
    buyToken: token1.address,
    buyTokenSymbol: token1.symbol,
    buyTokenDecimals: token1.decimals,
    sellToken: token2.address,
    sellTokenSymbol: token2.symbol,
    sellTokenDecimals: token2.decimals,
    takeOrders: [
        {
            id: hexlify(randomBytes(32)),
            quote: {
                maxOutput: vaultBalance1,
                ratio: ethers.constants.Zero,
            },
            takeOrder: {
                order: {
                    owner: hexlify(randomBytes(20)),
                    nonce: `0x${"0".repeat(64)}`,
                    evaluable: {
                        interpreter: hexlify(randomBytes(20)),
                        store: hexlify(randomBytes(20)),
                        bytecode: hexlify(randomBytes(20)),
                    },
                    validInputs: [
                        {
                            token: token1.address,
                            decimals: token1.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                    validOutputs: [
                        {
                            token: token2.address,
                            decimals: token2.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                },
                inputIOIndex: 0,
                outputIOIndex: 0,
                signedContext: [],
            },
        },
        {
            id: hexlify(randomBytes(32)),
            quote: {
                maxOutput: vaultBalance2,
                ratio: ethers.constants.Zero,
            },
            takeOrder: {
                order: {
                    owner: hexlify(randomBytes(20)),
                    nonce: `0x${"0".repeat(64)}`,
                    evaluable: {
                        interpreter: hexlify(randomBytes(20)),
                        store: hexlify(randomBytes(20)),
                        bytecode: hexlify(randomBytes(20)),
                    },
                    validInputs: [
                        {
                            token: token1.address,
                            decimals: token1.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                    validOutputs: [
                        {
                            token: token2.address,
                            decimals: token2.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                },
                inputIOIndex: 0,
                outputIOIndex: 0,
                signedContext: [],
            },
        },
    ],
};

const vaultBalance = BigNumber.from("10000000000000000000");
const orderPairObject1 = {
    orderbook: orderbookAddress,
    buyToken: token1.address,
    buyTokenSymbol: token1.symbol,
    buyTokenDecimals: token1.decimals,
    sellToken: token2.address,
    sellTokenSymbol: token2.symbol,
    sellTokenDecimals: token2.decimals,
    takeOrders: [
        {
            id: hexlify(randomBytes(32)),
            quote: {
                maxOutput: vaultBalance,
                ratio: ethers.utils.parseUnits("0.4"),
            },
            takeOrder: {
                order: {
                    owner: hexlify(randomBytes(20)),
                    nonce: `0x${"0".repeat(64)}`,
                    evaluable: {
                        interpreter: hexlify(randomBytes(20)),
                        store: hexlify(randomBytes(20)),
                        bytecode: hexlify(randomBytes(20)),
                    },
                    validInputs: [
                        {
                            token: token1.address,
                            decimals: token1.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                    validOutputs: [
                        {
                            token: token2.address,
                            decimals: token2.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                },
                inputIOIndex: 0,
                outputIOIndex: 0,
                signedContext: [],
            },
        },
    ],
};

const opposingVaultBalance = BigNumber.from("100000000");
const opposingOrderPairObject = {
    orderbook: opposingOrderbookAddress,
    buyToken: token2.address,
    buyTokenSymbol: token2.symbol,
    buyTokenDecimals: token2.decimals,
    sellToken: token1.address,
    sellTokenSymbol: token1.symbol,
    sellTokenDecimals: token1.decimals,
    takeOrders: [
        {
            id: hexlify(randomBytes(32)),
            quote: {
                maxOutput: vaultBalance,
                ratio: ethers.utils.parseUnits("1.5"),
            },
            takeOrder: {
                order: {
                    owner: hexlify(randomBytes(20)),
                    nonce: `0x${"0".repeat(64)}`,
                    evaluable: {
                        interpreter: hexlify(randomBytes(20)),
                        store: hexlify(randomBytes(20)),
                        bytecode: hexlify(randomBytes(20)),
                    },
                    validInputs: [
                        {
                            token: token2.address,
                            decimals: token2.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                    validOutputs: [
                        {
                            token: token1.address,
                            decimals: token1.decimals,
                            vaultId: hexlify(randomBytes(32)),
                        },
                    ],
                },
                inputIOIndex: 0,
                outputIOIndex: 0,
                signedContext: [],
            },
        },
    ],
};
const orderbooksOrders = [[opposingOrderPairObject]];

const poolAddress = hexlify(randomBytes(20));
const poolCodeMap = new Map([
    [
        poolAddress,
        new ConstantProductPoolCode(
            new ConstantProductRPool(
                poolAddress,
                fromToken,
                toToken,
                0.003,
                100000000000000000000000n,
                100000000000n,
            ),
            "QuickSwap",
            "QuickSwap 0.3%",
        ),
    ],
]);
const route = Router.findBestRoute(
    poolCodeMap,
    chainId,
    fromToken,
    vaultBalance.toBigInt(),
    toToken,
    gasPrice.toNumber(),
);
const expectedRouteData = ethers.utils.defaultAbiCoder.encode(
    ["bytes"],
    [
        Router.routeProcessor4Params(poolCodeMap, route, fromToken, toToken, arb.address, rp3_2)
            .routeCode,
    ],
);
const expectedRouteVisual = visualizeRoute(fromToken, toToken, route.legs);

function getCurrentPrice(amountIn) {
    const amountInFixed = amountIn.mul("1" + "0".repeat(18 - fromToken.decimals));
    const route = Router.findBestRoute(
        poolCodeMap,
        chainId,
        fromToken,
        amountIn.toBigInt(),
        toToken,
        gasPrice.toNumber(),
    );
    const amountOutFixed = BigNumber.from(route.amountOutBI).mul(
        "1" + "0".repeat(18 - toToken.decimals),
    );
    const price = amountOutFixed.mul("1" + "0".repeat(18)).div(amountInFixed);
    return price;
}

function getAmountOut(amountIn) {
    const route = Router.findBestRoute(
        poolCodeMap,
        chainId,
        fromToken,
        amountIn.toBigInt(),
        toToken,
        gasPrice.toNumber(),
    );
    return BigNumber.from(route.amountOutBI);
}

function getCurrentInputToEthPrice() {
    const amountIn = BigNumber.from("1" + "0".repeat(toToken.decimals));
    const amountInFixed = amountIn.mul("1" + "0".repeat(18 - toToken.decimals));
    const route = Router.findBestRoute(
        poolCodeMap,
        chainId,
        toToken,
        amountIn.toBigInt(),
        fromToken,
        gasPrice.toNumber(),
    );
    const amountOutFixed = BigNumber.from(route.amountOutBI).mul(
        "1" + "0".repeat(18 - fromToken.decimals),
    );
    const price = amountOutFixed.mul("1" + "0".repeat(18)).div(amountInFixed);
    return price;
}

module.exports = {
    config,
    token1,
    token2,
    arbAddress,
    orderbookAddress,
    rp3_2,
    inputToEthPrice,
    gasPrice,
    gasLimitEstimation,
    arb,
    orderbook,
    pair,
    txHash,
    effectiveGasPrice,
    gasUsed,
    fromToken,
    toToken,
    poolCodeMap,
    route,
    expectedRouteData,
    expectedRouteVisual,
    vaultBalance,
    vaultBalance1,
    vaultBalance2,
    orderPairObject1,
    orderPairObject2,
    scannerUrl,
    getCurrentPrice,
    chainId,
    opposingVaultBalance,
    opposingOrderPairObject,
    orderbooksOrders,
    outputToEthPrice,
    opposingOrderbookAddress,
    getCurrentInputToEthPrice,
    getAmountOut,
};
