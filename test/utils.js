const { assert } = require("chai");
const { ethers } = require("hardhat");
const { OrderV3 } = require("../src/abis");
const { DefaultArbEvaluable } = require("../src/abis");
const OrderbookArtifact = require("./abis/OrderBook.json");
const RainterpreterNPE2Artifact = require("./abis/RainterpreterNPE2.json");
const RainterpreterStoreNPE2Artifact = require("./abis/RainterpreterStoreNPE2.json");
const RainterpreterParserNPE2Artifact = require("./abis/RainterpreterParserNPE2.json");
const RainterpreterExpressionDeployerNPE2Artifact = require("./abis/RainterpreterExpressionDeployerNPE2.json");
const GenericPoolOrderBookV4ArbOrderTakerArtifact = require("./abis/GenericPoolOrderBookV4ArbOrderTaker.json");
const RouteProcessorOrderBookV4ArbOrderTakerArtifact = require("./abis/RouteProcessorOrderBookV4ArbOrderTaker.json");

/**
 * Deploys a simple contracts that takes no arguments for deployment
 *
 * @param {object} artifact - The compiled contract artifact
 * @param {any[]} args - (optional) The arguments for deploying this contract
 * @returns ethers Contract
 */
exports.basicDeploy = async (artifact, ...args) => {
    const factory = await ethers.getContractFactory(artifact.abi, artifact.bytecode);
    const contract = await factory.deploy(...args);
    await contract.deployed();
    return contract;
};

exports.arbDeploy = async (orderbookAddress, rpAddress) => {
    return await this.basicDeploy(RouteProcessorOrderBookV4ArbOrderTakerArtifact, {
        orderBook: orderbookAddress ?? `0x${"0".repeat(40)}`,
        task: {
            evaluable: DefaultArbEvaluable,
            signedContext: [],
        },
        implementationData: ethers.utils.defaultAbiCoder.encode(["address"], [rpAddress]),
    });
};

exports.genericArbrbDeploy = async (orderbookAddress) => {
    return await this.basicDeploy(GenericPoolOrderBookV4ArbOrderTakerArtifact, {
        orderBook: orderbookAddress ?? `0x${"0".repeat(40)}`,
        task: {
            evaluable: DefaultArbEvaluable,
            signedContext: [],
        },
        implementationData: "0x",
    });
};

exports.deployOrderBookNPE2 = async () => {
    return await this.basicDeploy(OrderbookArtifact);
};

exports.rainterpreterNPE2Deploy = async () => {
    return await this.basicDeploy(RainterpreterNPE2Artifact);
};

exports.rainterpreterStoreNPE2Deploy = async () => {
    return await this.basicDeploy(RainterpreterStoreNPE2Artifact);
};

exports.rainterpreterParserNPE2Deploy = async () => {
    return await this.basicDeploy(RainterpreterParserNPE2Artifact);
};

exports.rainterpreterExpressionDeployerNPE2Deploy = async (deployConfig) => {
    return await this.basicDeploy(RainterpreterExpressionDeployerNPE2Artifact, deployConfig);
};

/**
 * Extracts an emitted event from a contract
 *
 * @param {ethers.ContractTransaction} tx - transaction where event occurs
 * @param {string} eventName - name of event
 * @param {ethers.Contract} contract - contract object holding the address, filters, interface
 * @param {string} contractAddressOverride - (optional) override the contract address which emits this event
 * @returns Array of events with their arguments, which can each be deconstructed by array index or by object key
 */
exports.getEvents = async (tx, eventName, contract, contractAddressOverride = null) => {
    const address = contractAddressOverride ? contractAddressOverride : contract.address;

    const eventObjs = (await tx.wait()).events.filter(
        (x) => x.topics[0] == contract.filters[eventName]().topics[0] && x.address == address,
    );

    if (!eventObjs.length) {
        throw new Error(`Could not find event ${eventName} at address ${address}`);
    }

    return eventObjs.map((eventObj) =>
        contract.interface.decodeEventLog(eventName, eventObj.data, eventObj.topics),
    );
};

/**
 * Extracts arguments of an emitted event from a contract
 *
 * @param {ethers.ContractTransaction} tx - transaction where event occurs
 * @param {string} eventName - name of event
 * @param {ethers.Contract} contract - contract object holding the address, filters, interface
 * @param {string} contractAddressOverride - (optional) override the contract address which emits this event
 * @returns Event arguments of first matching event, can be deconstructed by array index or by object key
 */
exports.getEventArgs = async (tx, eventName, contract, contractAddressOverride = null) => {
    const address = contractAddressOverride ? contractAddressOverride : contract.address;

    const eventObj = (await tx.wait()).events.find(
        (x) => x.topics[0] == contract.filters[eventName]().topics[0] && x.address == address,
    );

    if (!eventObj) {
        throw new Error(`Could not find event ${eventName} at address ${address}`);
    }

    return contract.interface.decodeEventLog(eventName, eventObj.data, eventObj.topics);
};

/**
 * @returns a random 32 byte number in hexstring format
 */
exports.randomUint256 = () => {
    return ethers.utils.hexZeroPad(ethers.utils.randomBytes(32), 32);
};

/**
 * Builds an EvaluableConfig struct with expressionConfig and a store.
 *
 * @param {ethers.Contract} expressionDeployer - The ExpressionDeployer contract instance
 * @param {object} expressionConfig - The ExpressionConfig struct
 * @returns The evalubaleConfig struct
 */
exports.generateEvaluableConfig = (expressionDeployer, expressionConfig) => {
    return {
        deployer: expressionDeployer.address,
        ...expressionConfig,
    };
};

/**
 * Encodes an string
 * @param {string} data - The data to encode
 * @returns The encoded data as hex string
 */
exports.encodeMeta = (data) => {
    return (
        "0x" +
        BigInt(0xff0a89c674ee7874n).toString(16).toLowerCase() +
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes(data)).split("x")[1]
    );
};

/**
 * Constructs subgraph-like query results from an addOrder event
 *
 * @param {any} eventArgs - The addOrder event arguments
 * @param {ethers.Contract} orderbook - The orderbook contract instance
 * @param {ethers.Contract[]} tokens - The tokens contracts
 * @returns An array of order details in form of subgraph query result
 */
exports.mockSgFromEvent = async (eventArgs, orderbook, tokens) => {
    const inputDetails = [];
    const outputDetails = [];
    for (let i = 0; i < eventArgs.order.validInputs.length; i++) {
        const token = tokens.find(
            (e) => e.address.toLowerCase() === eventArgs.order.validInputs[i].token.toLowerCase(),
        );
        const symbol =
            token?.knownSymbol ?? (await token.contract?.symbol()) ?? (await token.symbol());
        inputDetails.push({
            symbol,
            balance: await orderbook.vaultBalance(
                eventArgs.order.owner,
                eventArgs.order.validInputs[i].token,
                eventArgs.order.validInputs[i].vaultId.toString(),
            ),
        });
    }
    for (let i = 0; i < eventArgs.order.validOutputs.length; i++) {
        const token = tokens.find(
            (e) => e.address.toLowerCase() === eventArgs.order.validOutputs[i].token.toLowerCase(),
        );
        const symbol =
            token?.knownSymbol ?? (await token.contract?.symbol()) ?? (await token.symbol());
        outputDetails.push({
            symbol,
            balance: await orderbook.vaultBalance(
                eventArgs.order.owner,
                eventArgs.order.validOutputs[i].token,
                eventArgs.order.validOutputs[i].vaultId.toString(),
            ),
        });
    }

    return {
        id:
            typeof eventArgs.orderHash === "string"
                ? eventArgs.orderHash.toLowerCase()
                : eventArgs.orderHash.toHexString().toLowerCase(),
        owner: eventArgs.order.owner.toLowerCase(),
        orderHash:
            typeof eventArgs.orderHash === "string"
                ? eventArgs.orderHash.toLowerCase()
                : eventArgs.orderHash.toHexString().toLowerCase(),
        orderBytes: ethers.utils.defaultAbiCoder.encode([OrderV3], [eventArgs.order]),
        active: true,
        nonce: eventArgs.order.nonce,
        orderbook: {
            id: orderbook.address.toLowerCase(),
        },
        inputs: eventArgs.order.validInputs.map((v, i) => {
            return {
                token: {
                    address: v.token.toLowerCase(),
                    decimals: v.decimals,
                    symbol: inputDetails[i].symbol,
                },
                balance: inputDetails[i].balance.toString(),
                vaultId: v.vaultId.toString(),
            };
        }),
        outputs: eventArgs.order.validOutputs.map((v, i) => {
            return {
                token: {
                    address: v.token.toLowerCase(),
                    decimals: v.decimals,
                    symbol: outputDetails[i].symbol,
                },
                balance: outputDetails[i].balance.toString(),
                vaultId: v.vaultId.toString(),
            };
        }),
    };
};

/**
 * Prepares orders to be in usable format for arb
 */
exports.prepareOrders = async (
    owners,
    tokens,
    tokensDecimals,
    vaultIds,
    orderbook,
    expressionDeployer,
) => {
    // topping up owners 1 2 3 vaults with 100 of each token
    for (let i = 0; i < 3; i++) {
        const depositConfigStruct = {
            token: tokens[0].address,
            vaultId: vaultIds[0],
            amount: "100" + "0".repeat(tokensDecimals[0]),
        };
        await tokens[0].connect(owners[i]).approve(orderbook.address, depositConfigStruct.amount);
        await orderbook
            .connect(owners[i])
            .deposit(
                depositConfigStruct.token,
                depositConfigStruct.vaultId,
                depositConfigStruct.amount,
            );
    }
    for (let i = 0; i < 3; i++) {
        const depositConfigStruct = {
            token: tokens[1].address,
            vaultId: vaultIds[1],
            amount: "100" + "0".repeat(tokensDecimals[1]),
        };
        await tokens[1].connect(owners[i]).approve(orderbook.address, depositConfigStruct.amount);
        await orderbook
            .connect(owners[i])
            .deposit(
                depositConfigStruct.token,
                depositConfigStruct.vaultId,
                depositConfigStruct.amount,
            );
    }
    for (let i = 0; i < 3; i++) {
        const depositConfigStruct = {
            token: tokens[2].address,
            vaultId: vaultIds[2],
            amount: "100" + "0".repeat(tokensDecimals[2]),
        };
        await tokens[2].connect(owners[i]).approve(orderbook.address, depositConfigStruct.amount);
        await orderbook
            .connect(owners[i])
            .deposit(
                depositConfigStruct.token,
                depositConfigStruct.vaultId,
                depositConfigStruct.amount,
            );
    }
    for (let i = 0; i < 3; i++) {
        const depositConfigStruct = {
            token: tokens[3].address,
            vaultId: vaultIds[3],
            amount: "100" + "0".repeat(tokensDecimals[3]),
        };
        await tokens[3].connect(owners[i]).approve(orderbook.address, depositConfigStruct.amount);
        await orderbook
            .connect(owners[i])
            .deposit(
                depositConfigStruct.token,
                depositConfigStruct.vaultId,
                depositConfigStruct.amount,
            );
    }

    const sgOrders = [];
    // order expression config
    const expConfig = {
        constants: [
            ethers.constants.MaxUint256.toHexString(), // max output
            "0",
        ],
        bytecode: "0x020000000c02020002010000000100000100000000",
    };

    const EvaluableConfig = this.generateEvaluableConfig(expressionDeployer, expConfig);

    // add orders
    const owner1_order1 = {
        validInputs: [
            { token: tokens[1].address, decimals: tokensDecimals[1], vaultId: vaultIds[1] },
            { token: tokens[3].address, decimals: tokensDecimals[3], vaultId: vaultIds[3] },
        ],
        validOutputs: [
            { token: tokens[0].address, decimals: tokensDecimals[0], vaultId: vaultIds[0] },
        ],
        evaluableConfig: EvaluableConfig,
        meta: this.encodeMeta("owner1_order1"),
    };
    const tx_owner1_order1 = await orderbook.connect(owners[0]).addOrder(owner1_order1);

    // get sg-like order details from tx event
    sgOrders.push(
        await this.mockSgFromEvent(
            await this.getEventArgs(tx_owner1_order1, "AddOrder", orderbook),
            orderbook,
            tokens,
        ),
    );

    const owner1_order2 = {
        validInputs: [
            { token: tokens[2].address, decimals: tokensDecimals[2], vaultId: vaultIds[2] },
        ],
        validOutputs: [
            { token: tokens[0].address, decimals: tokensDecimals[0], vaultId: vaultIds[0] },
        ],
        evaluableConfig: EvaluableConfig,
        meta: this.encodeMeta("owner1_order2"),
    };
    const tx_owner1_order2 = await orderbook.connect(owners[0]).addOrder(owner1_order2);
    sgOrders.push(
        await this.mockSgFromEvent(
            await this.getEventArgs(tx_owner1_order2, "AddOrder", orderbook),
            orderbook,
            tokens,
        ),
    );

    const owner2_order1 = {
        validInputs: [
            { token: tokens[2].address, decimals: tokensDecimals[2], vaultId: vaultIds[2] },
        ],
        validOutputs: [
            { token: tokens[0].address, decimals: tokensDecimals[0], vaultId: vaultIds[0] },
        ],
        evaluableConfig: EvaluableConfig,
        meta: this.encodeMeta("owner2_order1"),
    };
    const tx_owner2_order1 = await orderbook.connect(owners[1]).addOrder(owner2_order1);
    sgOrders.push(
        await this.mockSgFromEvent(
            await this.getEventArgs(tx_owner2_order1, "AddOrder", orderbook),
            orderbook,
            tokens,
        ),
    );

    const owner3_order1 = {
        validInputs: [
            { token: tokens[1].address, decimals: tokensDecimals[1], vaultId: vaultIds[1] },
        ],
        validOutputs: [
            { token: tokens[0].address, decimals: tokensDecimals[0], vaultId: vaultIds[0] },
        ],
        evaluableConfig: EvaluableConfig,
        meta: this.encodeMeta("owner3_order1"),
    };
    const tx_owner3_order1 = await orderbook.connect(owners[2]).addOrder(owner3_order1);
    sgOrders.push(
        await this.mockSgFromEvent(
            await this.getEventArgs(tx_owner3_order1, "AddOrder", orderbook),
            orderbook,
            tokens,
        ),
    );

    return sgOrders;
};

exports.assertError = async function (f, s, e) {
    let didError = false;
    try {
        await f();
    } catch (e) {
        assert.ok(
            JSON.stringify(e).includes(s),
            `error string ${JSON.stringify(e)} does not include ${s}`,
        );
        didError = true;
    }
    assert.ok(didError, e);
};

exports.encodeQuoteResponse = function (quoteResult) {
    return ethers.utils.defaultAbiCoder.encode(["(bool,uint256,uint256)"], [quoteResult]);
};
