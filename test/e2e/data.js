require("dotenv").config();
const { ChainId, LiquidityProviders } = require("sushi");
const { USDT, WNATIVE, USDC, ENOSYS_HLN, Token } = require("sushi/currency");

module.exports = [
    [
        // chain id
        ChainId.POLYGON,

        // fork rpc url
        process?.env?.TEST_POLYGON_RPC,

        // block number of fork network
        56738134,

        // tokens to test with
        [
            WNATIVE[ChainId.POLYGON],
            USDC[ChainId.POLYGON],
            new Token({
                chainId: ChainId.POLYGON,
                address: "0xd0e9c8f5Fae381459cf07Ec506C1d2896E8b5df6",
                decimals: 18,
                symbol: "IOEN",
            }),
            new Token({
                chainId: ChainId.POLYGON,
                address: "0x874e178A2f3f3F9d34db862453Cd756E7eAb0381",
                decimals: 18,
                symbol: "GFI",
            }),
        ],

        // addresses with token balance, in order with specified tokens
        [
            "0xdF906eA18C6537C6379aC83157047F507FB37263",
            "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245",
            "0xdFB5396f06bE50eAA745094ff51d272C292cc218",
            "0x9294132f9d423b0FD5823aB400133d814fe73016",
        ],

        // liq providers to use for test
        // ideally specify at least one for each univ2 and univ3 protocols
        [
            LiquidityProviders.QuickSwapV2,
            LiquidityProviders.QuickSwapV3,
            LiquidityProviders.GravityFinance,
        ],

        // deposist amounts per token pair order
        ["100", "100", "100", "100"],
    ],
    [
        ChainId.ARBITRUM,
        process?.env?.TEST_ARBITRUM_RPC,
        226810501,
        [
            WNATIVE[ChainId.ARBITRUM],
            USDT[ChainId.ARBITRUM],
            new Token({
                chainId: ChainId.ARBITRUM,
                address: "0x9cAAe40DCF950aFEA443119e51E821D6FE2437ca",
                decimals: 18,
                symbol: "BJ",
            }),
        ],
        [
            "0xc3e5607cd4ca0d5fe51e09b60ed97a0ae6f874dd",
            "0x8f9c79B9De8b0713dCAC3E535fc5A1A92DB6EA2D",
            "0x9f29801ac82befe279786e5691b0399b637c560c",
        ],
        [LiquidityProviders.UniswapV3, LiquidityProviders.Camelot],
        ["1", "100", "100"],
    ],
    [
        ChainId.FLARE,
        process?.env?.TEST_FLARE_RPC,
        28269400,
        [WNATIVE[ChainId.FLARE], USDT[ChainId.FLARE], ENOSYS_HLN],
        [
            "0x2258e7Ad1D8AC70FAB053CF59c027960e94DB7d1",
            "0x51cD71ec61487A3359993922A5BBac294934A628",
            "0x2e574D0802F433E71F7dC91650aB2C23aDeb0D81",
        ],
        [LiquidityProviders.Enosys, LiquidityProviders.SparkDexV2, LiquidityProviders.SparkDexV3],
        ["1", "100", "100"],
    ],
    [
        ChainId.ETHEREUM,
        process?.env?.TEST_ETH_RPC,
        19829125,
        [
            WNATIVE[ChainId.ETHEREUM],
            USDT[ChainId.ETHEREUM],
            // new Token({
            //     chainId: ChainId.ETHEREUM,
            //     address: "0x922D8563631B03C2c4cf817f4d18f6883AbA0109",
            //     decimals: 18,
            //     symbol: "LOCK"
            // }),
        ],
        [
            "0x17FD2FeeDabE71f013F5228ed9a52DE58291b15d",
            "0x83B9c290E8D86e686a9Eda6A6DC8FA6d281A5157",
            // "0x3776100a4b669Ef0d727a81FC69bF50DE74A976c",
        ],
        [
            // LiquidityProviders.SushiSwapV2,
            LiquidityProviders.UniswapV3,
        ],
        ["1", "100", "100"],

        // ob, arb, bot addresses
        // "0xf1224A483ad7F1E9aA46A8CE41229F32d7549A74",
        // "0x96C3673Ee4B0d5303272193BaB0c565B7ce58D7A",
        // "0x22025257BeF969A81eDaC0b343ce82d777931327",
    ],
    [
        ChainId.BASE,
        process?.env?.TEST_BASE_RPC,
        16418720,
        [
            WNATIVE[ChainId.BASE],
            new Token({
                chainId: ChainId.BASE,
                address: "0x99b2B1A2aDB02B38222ADcD057783D7e5D1FCC7D",
                decimals: 18,
                symbol: "WLTH",
            }),
            new Token({
                chainId: ChainId.BASE,
                address: "0x71DDE9436305D2085331AF4737ec6f1fe876Cf9f",
                decimals: 18,
                symbol: "PAID",
            }),
            new Token({
                chainId: ChainId.BASE,
                address: "0x3982E57fF1b193Ca8eb03D16Db268Bd4B40818f8",
                decimals: 18,
                symbol: "BLOOD",
            }),
        ],
        [
            "0x2B8804c2b652f05F7FDD8e0a02F01eE58F01667E",
            "0xD6216fC19DB775Df9774a6E33526131dA7D19a2c",
            "0x3ea31919Ef9b3e72Cc25657b604DB1ACDb1DdB4b",
            "0xf6D07A291443F31B129Ca7e2b46C6F882f0FAa5b",
        ],
        [LiquidityProviders.UniswapV3, LiquidityProviders.UniswapV2, LiquidityProviders.BaseSwap],
        ["1", "10000", "10000", "10000"],
    ],
    [
        ChainId.BSC,
        process?.env?.TEST_BSC_RPC,
        40393189,
        [
            WNATIVE[ChainId.BSC],
            new Token({
                chainId: ChainId.BSC,
                address: "0x8f0FB159380176D324542b3a7933F0C2Fd0c2bbf",
                decimals: 7,
                symbol: "TFT",
            }),
            new Token({
                chainId: ChainId.BSC,
                address: "0xAD86d0E9764ba90DDD68747D64BFfBd79879a238",
                decimals: 18,
                symbol: "PAID",
            }),
        ],
        [
            "0x59d779BED4dB1E734D3fDa3172d45bc3063eCD69",
            "0x66803c0B34B1baCCb68fF515f76cd63ba48a2039",
            "0x604b2B06ad0D5a2f8ef4383626f6dD37E780D090",
        ],
        [LiquidityProviders.PancakeSwapV2, LiquidityProviders.PancakeSwapV3],
        ["1", "10000", "10000"],
    ],
    [
        ChainId.LINEA,
        process?.env?.TEST_LINEA_RPC,
        7879600,
        [
            WNATIVE[ChainId.LINEA],
            USDC[ChainId.LINEA],
            new Token({
                chainId: ChainId.LINEA,
                address: "0x4Ea77a86d6E70FfE8Bb947FC86D68a7F086f198a",
                decimals: 18,
                symbol: "CLIP",
            }),
        ],
        [
            "0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67",
            "0x555CE236C0220695b68341bc48C68d52210cC35b",
            "0x0000619b2b909a6a422c18eb804b92f798370705",
        ],
        [LiquidityProviders.LynexV1, LiquidityProviders.LynexV2],
        ["1", "100"],
    ],
    [
        ChainId.MATCHAIN,
        process?.env?.TEST_MATCHAIN_RPC,
        4077685,
        [WNATIVE[ChainId.MATCHAIN], USDT[ChainId.MATCHAIN]],
        [
            "0xf270cAd1CC39E55BaF5B0607e40D39f583dFA4a8",
            "0xF41a883B88CCD3a2978F176C3e0230128573eB05",
        ],
        [LiquidityProviders.MSwap],
        ["0.01", "100"],
    ],
];
