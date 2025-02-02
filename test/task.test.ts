import { assert } from "chai";
import { getLocal } from "mockttp";
import { BigNumber, utils } from "ethers";
import { encodeAbiParameters } from "viem";
import { createViemClient } from "../src/config";
import { getBountyEnsureRainlang, getWithdrawEnsureRainlang, parseRainlang } from "../src/task";

describe("Test task", async function () {
    const mockServer = getLocal();
    beforeEach(() => mockServer.start(8095));
    afterEach(() => mockServer.stop());

    it("should get ensure bounty rainlang", async function () {
        const inputToEthPrice = BigNumber.from(10);
        const outputToEthPrice = BigNumber.from(20);
        const minimumExpected = BigNumber.from(15);
        const sender = utils.hexlify(utils.randomBytes(20));

        const result = await getBountyEnsureRainlang(
            inputToEthPrice,
            outputToEthPrice,
            minimumExpected,
            sender,
        );
        const expected = `/* 0. main */ 
:ensure(equal-to(${sender} context<0 0>()) "unknown sender"),
total-bounty-eth: add(
    mul(${utils.formatUnits(inputToEthPrice)} context<1 0>())
    mul(${utils.formatUnits(outputToEthPrice)} context<1 1>())
),
:ensure(
    greater-than-or-equal-to(
        total-bounty-eth
        ${utils.formatUnits(minimumExpected)}
    )
    "minimum sender output"
);`;
        assert.equal(result, expected);
    });

    it("should get withdraw ensure bounty rainlang", async function () {
        const inputToEthPrice = BigNumber.from(10);
        const outputToEthPrice = BigNumber.from(20);
        const minimumExpected = BigNumber.from(15);
        const sender = utils.hexlify(utils.randomBytes(20));
        const botAddress = utils.hexlify(utils.randomBytes(20));
        const inputToken = utils.hexlify(utils.randomBytes(20));
        const outputToken = utils.hexlify(utils.randomBytes(20));
        const orgInputBalance = BigNumber.from(45);
        const orgOutputBalance = BigNumber.from(55);

        const result = await getWithdrawEnsureRainlang(
            botAddress,
            inputToken,
            outputToken,
            orgInputBalance,
            orgOutputBalance,
            inputToEthPrice,
            outputToEthPrice,
            minimumExpected,
            sender,
        );
        const expected = `/* 0. main */ 
:ensure(equal-to(${sender} context<0 0>()) "unknown sender"),
input-bounty: sub(
    erc20-balance-of(${inputToken} ${botAddress})
    ${utils.formatUnits(orgInputBalance)}
),
output-bounty: sub(
    erc20-balance-of(${outputToken} ${botAddress})
    ${utils.formatUnits(orgOutputBalance)}
),
total-bounty-eth: add(
    mul(input-bounty ${utils.formatUnits(inputToEthPrice)})
    mul(output-bounty ${utils.formatUnits(outputToEthPrice)})
),
:ensure(
    greater-than-or-equal-to(
        total-bounty-eth
        ${utils.formatUnits(minimumExpected)}
    )
    "minimum sender output"
);`;
        assert.equal(result, expected);
    });

    it("should parse rainlang to bytecode", async function () {
        const viemClient = await createViemClient(1, [mockServer.url + "/rpc"]);
        const rainlang = "some-rainlang";
        const dispair = {
            interpreter: utils.hexlify(utils.randomBytes(20)),
            store: utils.hexlify(utils.randomBytes(20)),
            deployer: utils.hexlify(utils.randomBytes(20)),
        };

        const expected = utils.hexlify(utils.randomBytes(32)) as `0x${string}`;
        const callResult = encodeAbiParameters([{ type: "bytes" }], [expected]);

        // mock call
        await mockServer
            .forPost("/rpc")
            .withBodyIncluding("0xa3869e14") // parse2() selector
            .thenSendJsonRpcResult(callResult);
        const result = await parseRainlang(rainlang, viemClient, dispair);

        assert.equal(result, expected);
    });
});
