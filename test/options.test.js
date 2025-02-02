const { assert } = require("chai");
const { getConfig } = require("../src");
const { assertError } = require("./utils");
const { LiquidityProviders } = require("sushi");

describe("Test app options", async function () {
    it("should use defaults", async function () {
        const rpcs = ["https://rpc.ankr.com/polygon", "https://polygon-rpc.com"];
        const config = await getConfig(
            rpcs,
            "0x" + "1".repeat(64), // wallet key
            "0x" + "3".repeat(40), // arb address
            {
                lps: ["SUShIswapV2", "bIsWaP"],
                dispair: "0xE7116BC05C8afe25e5B54b813A74F916B5D42aB1",
            },
        );

        assert.deepEqual(config.lps, [LiquidityProviders.SushiSwapV2, LiquidityProviders.Biswap]);
        assert.equal(config.flashbotRpc, undefined);
        assert.equal(config.maxRatio, false);
        assert.equal(config.hops, 1);
        assert.equal(config.retries, 1);
        assert.equal(config.chain.id, 137);
        assert.equal(config.gasCoveragePercentage, "100");
        assert.deepEqual(config.rpc, rpcs);
    });

    it("should error if retries is not between 1-3", async function () {
        const configPromise = async () =>
            await getConfig(
                ["https://rpc.ankr.com/polygon"],
                "0x" + "1".repeat(64),
                "0x" + "3".repeat(40),
                { retries: 5 },
            );
        await assertError(
            configPromise,
            "invalid retries value, must be an integer between 1 - 3",
            "unexpected error",
        );
    });
});
