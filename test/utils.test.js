const { assert } = require("chai");
const testData = require("./data");
const {
    ethers,
    BigNumber,
    utils: { hexlify, randomBytes },
} = require("ethers");
const {
    clone,
    scale18,
    scale18To,
    getTotalIncome,
    checkOwnedOrders,
    extendSpanAttributes,
} = require("../src/utils");

describe("Test utils functions", async function () {
    it("should clone correctly", async function () {
        const obj = {
            a: 123,
            b: true,
            c: "some string",
            d: [1, 2, 3],
            e: ethers.BigNumber.from(1),
            f: {
                a: ethers.BigNumber.from(2),
                b: ["1", "2", "3"],
                c: {
                    a: true,
                    b: [ethers.BigNumber.from(1), ethers.BigNumber.from(2)],
                },
            },
        };
        const result = clone(obj);
        assert.deepEqual(result, obj);
        assert.notEqual(result, obj);
        assert.notEqual(result.f.b, obj.f.b);
        assert.notEqual(result.f.c, obj.f.c);
        assert.notEqual(result.f.c.b, obj.f.c.b);
    });

    it("should get total income", async function () {
        const inputTokenIncome = ethers.BigNumber.from("10000000");
        const outputTokenIncome = ethers.BigNumber.from("20000");
        const inputTokenPrice = "1.25";
        const outputTokenPrice = "0.8";
        const inputTokenDecimals = 6;
        const outputTokenDecimals = 3;

        const result = getTotalIncome(
            inputTokenIncome,
            outputTokenIncome,
            inputTokenPrice,
            outputTokenPrice,
            inputTokenDecimals,
            outputTokenDecimals,
        );
        const expected = ethers.utils.parseUnits((10 * 1.25 + 20 * 0.8).toString());
        assert.equal(result.toString(), expected.toString());
    });

    it("should check owned orders", async function () {
        const owner = hexlify(randomBytes(20));
        const { orderPairObject1: order1, opposingOrderPairObject: order2 } = testData;
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

    it("should scale to 18", async function () {
        // down
        const value1 = "123456789";
        const decimals1 = 3;
        const result1 = scale18(value1, decimals1);
        const expected1 = BigNumber.from("123456789000000000000000");
        assert.deepEqual(result1, expected1);

        // up
        const value2 = "123456789";
        const decimals2 = 23;
        const result2 = scale18(value2, decimals2);
        const expected2 = BigNumber.from("1234");
        assert.deepEqual(result2, expected2);
    });

    it("should scale from 18", async function () {
        // down
        const value1 = "123456789";
        const decimals1 = 12;
        const result1 = scale18To(value1, decimals1);
        const expected1 = BigNumber.from("123");
        assert.deepEqual(result1, expected1);

        // up
        const value2 = "123456789";
        const decimals2 = 23;
        const result2 = scale18To(value2, decimals2);
        const expected2 = BigNumber.from("12345678900000");
        assert.deepEqual(result2, expected2);
    });

    it("should test extendSpanAttributes", async function () {
        const newAttrs = {
            a: 10,
            b: true,
            c: "some string",
        };
        const spanAttrs = {
            oldKey: "some value",
        };
        extendSpanAttributes(spanAttrs, newAttrs, "header");

        const expected = {
            oldKey: "some value",
            "header.a": 10,
            "header.b": true,
            "header.c": "some string",
        };
        assert.deepEqual(spanAttrs, expected);
    });
});
