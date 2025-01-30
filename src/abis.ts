import { parseAbi } from "viem";

// structs used in the orderbook and arb abis
export const IO = "(address token, uint8 decimals, uint256 vaultId)" as const;
export const EvaluableV3 = "(address interpreter, address store, bytes bytecode)" as const;
export const SignedContextV1 = "(address signer, uint256[] context, bytes signature)" as const;
export const TaskV1 = `(${EvaluableV3} evaluable, ${SignedContextV1}[] signedContext)` as const;
export const ClearStateChange =
    "(uint256 aliceOutput, uint256 bobOutput, uint256 aliceInput, uint256 bobInput)" as const;
export const OrderV3 =
    `(address owner, ${EvaluableV3} evaluable, ${IO}[] validInputs, ${IO}[] validOutputs, bytes32 nonce)` as const;
export const TakeOrderConfigV3 =
    `(${OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
export const OrderConfigV3 =
    `(${EvaluableV3} evaluable, ${IO}[] validInputs, ${IO}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
export const TakeOrdersConfigV3 =
    `(uint256 minimumInput, uint256 maximumInput, uint256 maximumIORatio, ${TakeOrderConfigV3}[] orders, bytes data)` as const;
export const ClearConfig =
    "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, uint256 aliceBountyVaultId, uint256 bobBountyVaultId)" as const;
export const Quote =
    `(${OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;

/**
 * Minimal ABI for Orderbook contract only including vaultBalance() function
 */
export const orderbookAbi = [
    `event AddOrderV2(address sender, bytes32 orderHash, ${OrderV3} order)`,
    `event RemoveOrderV2(address sender, bytes32 orderHash, ${OrderV3} order)`,
    `event AfterClear(address sender, ${ClearStateChange} clearStateChange)`,
    "function vaultBalance(address owner, address token, uint256 vaultId) external view returns (uint256 balance)",
    `function deposit2(address token, uint256 vaultId, uint256 amount, ${TaskV1}[] calldata tasks) external`,
    `function addOrder2(${OrderConfigV3} calldata config, ${TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
    `function entask(${TaskV1}[] calldata tasks) external`,
    `function withdraw2(address token, uint256 vaultId, uint256 targetAmount, ${TaskV1}[] calldata tasks) external`,
    "function orderExists(bytes32 orderHash) external view returns (bool exists)",
    `function removeOrder2(${OrderV3} calldata order, ${TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
    "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
    `function takeOrders2(${TakeOrdersConfigV3} memory config) external returns (uint256 totalInput, uint256 totalOutput)`,
    `function clear2(${OrderV3} memory aliceOrder, ${OrderV3} memory bobOrder, ${ClearConfig} calldata clearConfig, ${SignedContextV1}[] memory aliceSignedContext, ${SignedContextV1}[] memory bobSignedContext) external`,
    `event TakeOrderV2(address sender, ${TakeOrderConfigV3} config, uint256 input, uint256 output)`,
    `function quote(${Quote} calldata quoteConfig) external view returns (bool, uint256, uint256)`,
] as const;

/**
 * Minimal ABI for IInterpreterV2 contract only including eval() function
 */
export const interpreterV2Abi = [
    `function eval2(
        address store,
        uint256 namespace,
        uint256 dispatch,
        uint256[][] calldata context,
        uint256[] calldata inputs
    ) external view returns (uint256[] calldata stack, uint256[] calldata writes)`,
] as const;

/**
 * Minimal ABI for SushiSwap RouteProcessor3 contract only including processRoute() function
 */
export const routeProcessor3Abi = [
    `function processRoute(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutMin ,address to, bytes memory route) external payable returns (uint256 amountOut)`,
] as const;

/**
 * ExpressionDeployerNPE2 minimal ABI
 */
export const deployerAbi = [
    "function parse2(bytes memory data) external view returns (bytes memory bytecode)",
    "function iStore() external view returns (address)",
    "function iInterpreter() external view returns (address)",
    "function iParser() external view returns (address)",
] as const;

/**
 * Minimal ABI for Arb contract
 */
export const arbAbis = [
    `function arb2(${TakeOrdersConfigV3} calldata takeOrders, uint256 minimumSenderOutput, ${EvaluableV3} calldata evaluable) external payable`,
    `function arb3(address orderBook, ${TakeOrdersConfigV3} calldata takeOrders, ${TaskV1} calldata task)`,
    "function iRouteProcessor() external view returns (address)",
] as const;

export const Call3 = "(address target, bool allowFailure, bytes callData)" as const;
export const Result = "(bool success, bytes returnData)" as const;
export const multicall3Abi = [
    "function getEthBalance(address addr) external view returns (uint256 balance)",
    `function aggregate3(${Call3}[] calldata calls) external payable returns (${Result}[] memory returnData)`,
] as const;

// an empty evaluable mainly used as default evaluable for arb contracts
export const DefaultArbEvaluable = {
    interpreter: "0x" + "0".repeat(40),
    store: "0x" + "0".repeat(40),
    bytecode: "0x",
} as const;

export const TakeOrderV2EventAbi = parseAbi([orderbookAbi[13]]);
export const OrderbookQuoteAbi = parseAbi([orderbookAbi[14]]);
export const VaultBalanceAbi = parseAbi([orderbookAbi[3]]);
export const AfterClearAbi = parseAbi([orderbookAbi[2]]);
export const DeployerAbi = parseAbi(deployerAbi);
export const MulticallAbi = parseAbi(multicall3Abi);

/**
 * Arbitrum node interface address, used to get L1 gas limit.
 * This is not an actual deployed smart contract, it is only
 * available to be called through an Arbitrum RPC node, and not
 * as normally other smart contracts are called.
 */
export const ArbitrumNodeInterfaceAddress: `0x${string}` =
    "0x00000000000000000000000000000000000000C8" as const;

/**
 * Arbitrum node interface abi, used to get L1 gas limit
 */
export const ArbitrumNodeInterfaceAbi = [
    {
        inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "bool", name: "contractCreation", type: "bool" },
            { internalType: "bytes", name: "data", type: "bytes" },
        ],
        name: "gasEstimateComponents",
        outputs: [
            { internalType: "uint64", name: "gasEstimate", type: "uint64" },
            { internalType: "uint64", name: "gasEstimateForL1", type: "uint64" },
            { internalType: "uint256", name: "baseFee", type: "uint256" },
            { internalType: "uint256", name: "l1BaseFeeEstimate", type: "uint256" },
        ],
        stateMutability: "payable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "bool", name: "contractCreation", type: "bool" },
            { internalType: "bytes", name: "data", type: "bytes" },
        ],
        name: "gasEstimateL1Component",
        outputs: [
            { internalType: "uint64", name: "gasEstimateForL1", type: "uint64" },
            { internalType: "uint256", name: "baseFee", type: "uint256" },
            { internalType: "uint256", name: "l1BaseFeeEstimate", type: "uint256" },
        ],
        stateMutability: "payable",
        type: "function",
    },
] as const;
