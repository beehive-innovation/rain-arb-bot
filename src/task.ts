// import fs from "fs";
// import { DeployerAbi } from "./abis";
// import { BigNumber, utils } from "ethers";
// import { Dispair, ViemClient } from "./types";
// import { PublicClient, stringToHex } from "viem";
// import { MetaStore, RainDocument } from "@rainlanguage/dotrain";

// const metaStore = new MetaStore(false);
// export const TaskEntryPoint = ["main"] as const;
// export const EnsureBountyDotrain = fs.readFileSync("./tasks/ensure-bounty.rain", {
//     encoding: "utf8",
// });
// export const WithdrawEnsureBountyDotrain = fs.readFileSync("./tasks/withdraw-ensure-bounty.rain", {
//     encoding: "utf8",
// });

// /**
//  * Get the bounty check ensure task rainlang
//  * @param inputToEthPrice - Input token to Eth price
//  * @param outputToEthPrice - Output token to Eth price
//  * @param minimumExpected - Minimum expected amount
//  * @param sender - The msg sender
//  */
// export async function getBountyEnsureRainlang(
//     inputToEthPrice: BigNumber,
//     outputToEthPrice: BigNumber,
//     minimumExpected: BigNumber,
//     sender: string,
// ): Promise<string> {
//     return await RainDocument.composeText(
//         EnsureBountyDotrain,
//         TaskEntryPoint as any as string[],
//         metaStore,
//         [
//             ["sender", sender],
//             ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
//             ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
//             ["minimum-expected", utils.formatUnits(minimumExpected)],
//         ],
//     );
// }

// /**
//  * Get the bounty check ensure task rainlang for clear2 withdraw
//  * @param botAddress - Bot wallet address
//  * @param inputToken - Input token address
//  * @param outputToken - Output token address
//  * @param orgInputBalance - Input token original balance
//  * @param orgOutputBalance - Output token original balance
//  * @param inputToEthPrice - Input token to Eth price
//  * @param outputToEthPrice - Output token to Eth price
//  * @param minimumExpected - Minimum expected amount
//  * @param sender - The msg sender
//  */
// export async function getWithdrawEnsureRainlang(
//     botAddress: string,
//     inputToken: string,
//     outputToken: string,
//     orgInputBalance: BigNumber,
//     orgOutputBalance: BigNumber,
//     inputToEthPrice: BigNumber,
//     outputToEthPrice: BigNumber,
//     minimumExpected: BigNumber,
//     sender: string,
// ): Promise<string> {
//     return await RainDocument.composeText(
//         WithdrawEnsureBountyDotrain,
//         TaskEntryPoint as any as string[],
//         metaStore,
//         [
//             ["sender", sender],
//             ["bot-address", botAddress],
//             ["input-token", inputToken],
//             ["output-token", outputToken],
//             ["minimum-expected", utils.formatUnits(minimumExpected)],
//             ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
//             ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
//             ["org-input-balance", utils.formatUnits(orgInputBalance)],
//             ["org-output-balance", utils.formatUnits(orgOutputBalance)],
//         ],
//     );
// }

// /**
//  * Calls parse2 on a given deployer to parse the given rainlang text
//  */
// export async function parseRainlang(
//     rainlang: string,
//     viemClient: ViemClient | PublicClient,
//     dispair: Dispair,
// ): Promise<string> {
//     return await viemClient.readContract({
//         address: dispair.deployer as `0x${string}`,
//         abi: DeployerAbi,
//         functionName: "parse2",
//         args: [stringToHex(rainlang)],
//     });
// }
