# Rain Orderbook Arbitrage Bot
NodeJS app that clears Rain orderbook orders against major DeFi platforms liquidity by finding arbitrage trades for token pairs of orders details queried from a subgraph or from file containing array of `Order Struct`, bundling them as `takeOrders` and submitting them to one of [Rain Arb Contracts](https://github.com/rainprotocol/rain.orderbook/tree/main/src/concrete).

This app requires NodeJS v18 or higher to run and is docker ready.
This app can also be run in Github Actions with a cron job, please read below for more details.

## The Case for Profitability
Profitablity can be adjusted by using an integer ≥0 for `--gas-coverage` arg as the percentage of the gas cost of the transaction, denominated in receiving ERC20 token, the cost of the transaction is calculated in the receiving ERC20 token unit with current market price of that token against chain's native token.

for example:
- If set to 100, the receiving profit must be at least equal or greater than tx gas cost.
- If set above 100, the receiving profit must be more than the amount of gas cost, for example a transaction costs 0.01 USDT (calculated by current market price of ETH/USDT) and a value of 500 means the profit must be at least 5x the amount of gas used i.e. ≥0.05 USDT for the transaction to be successfull, so at least 0.04 USDT profit will be guaranteed.
- If set to 0, profitablity becomes irrevelant meaning any match will be submitted irrespective of whether or not the transaction will be profitable. 

## Tutorial
### Setup
Start by cloning the repo and then:
- with nix package manager (recommended way):

first you need to run `./prep-sushi.sh` which would need nix package manager installed on your system:
```bash
./prep-sushi.sh
```
next enter nix shell:
```bash
nix develop
```
and then:
```bash
npm install
npm run build
```
  or without entering the nix shell
```bash
nix develop -c npm install
nix develop -c npm run build
```

<br>
- without nix package manager:

you need to have pnpm `>= v8.15.3` and then run the following:
```bash
git submodule update --init --recursive
cd lib/sushiswap
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=./packages/sushi
cd ../..
```
and then install the dependencies, requires `>= nodejs v18`:
```bash
npm install
npm run build
```
<br>

### CLI
For starting the app:
- with nix package manager (recommended way):

from nix shell:
if you are not already in nix shell, enter by following command:
```bash
nix develop
```
and then:
```bash
node arb-bot <OPTIONS>
```

out of nix shell:

run the following if you don't want to enter nix shell
```bash
nix develop -c node arb-bot <OPTIONS>
```
<br>

- without nix package manager (requires `>= nodejs v18`):

```bash
node arb-bot <OPTIONS>
```

<br>

The app requires these arguments (all arguments can be set in env variables alternatively, more details below):
- `-k` or `--key`, Private key of wallet that performs the transactions, one of this or --mnemonic should be specified. Will override the 'BOT_WALLET_PRIVATEKEY' in env variables
- `-m` or `--mnemonic`, Mnemonic phrase of wallet that performs the transactions, one of this or --key should be specified, requires `--wallet-count` and `--topup-amount`. Will override the 'MNEMONIC' in env variables
- `-r` or `--rpc`, RPC URL(s) that will be provider for interacting with evm, use different providers if more than 1 is specified to prevent banning. Will override the 'RPC_URL' in env variables
- `--arb-address`, Address of the deployed arb contract, Will override the 'ARB_ADDRESS' in env variables
- `--bot-min-balance` The minimum gas token balance the bot wallet must have. Will override the 'BOT_MIN_BALANCE' in env variables
- `-s` or `--subgraph`, Subgraph URL(s) to read orders details from, can be used in combination with --orders, Will override the 'SUBGRAPH' in env variables
- `--dispair`, Address of dispair (ExpressionDeployer contract) to use for tasks, Will override the 'DISPAIR' in env variables

Other optional arguments are:
- `--generic-arb-address`, Address of the deployed generic arb contract to perform inter-orderbook clears, Will override the 'GENERIC_ARB_ADDRESS' in env variables
- `-l` or `--lps`, List of liquidity providers (dex) to use by the router as one quoted string seperated by a comma for each, example: 'SushiSwapV2,UniswapV3', Will override the 'LIQUIDITY_PROVIDERS' in env variables, if unset will use all available liquidty providers
- `-g` or `--gas-coverage`, The percentage of gas to cover to be considered profitable for the transaction to be submitted, an integer greater than equal 0, default is 100 meaning full coverage, Will override the 'GAS_COVER' in env variables
- `--orderbook-address`, Option to filter the subgraph query results with address of the deployed orderbook contract, Will override the 'ORDERBOOK_ADDRESS' in env variables
- `--order-hash`, Option to filter the subgraph query results with a specific order hash, Will override the 'ORDER_HASH' in env variables
- `--order-owner`, Option to filter the subgraph query results with a specific order owner address, Will override the 'ORDER_OWNER' in env variables
- `--sleep`, Seconds to wait between each arb round, default is 10, Will override the 'SLEEP' in env variables
- `--max-ratio`, Option to maximize maxIORatio, Will override the 'MAX_RATIO' in env variables
- `--timeout`, Optional seconds to wait for the transaction to mine before disregarding it, Will override the 'TIMEOUT' in env variables
- `--write-rpc`, Option to explicitly use for write transactions, such as flashbots or mev protect rpc to protect against mev attacks, Will override the 'WRITE_RPC' in env variables
- `--hops`, Option to specify how many hops the binary search should do, default is 0 if left unspecified, Will override the 'HOPS' in env variables
- `--retries`, Option to specify how many retries should be done for the same order, max value is 3, default is 1 if left unspecified, Will override the 'RETRIES' in env variables
- `--pool-update-interval`, Option to specify time (in minutes) between pools updates, default is 15 minutes, Will override the 'POOL_UPDATE_INTERVAL' in env variables
- `--self-fund-orders`, Specifies owned order to get funded once their vault goes below the specified threshold, example: token,vaultId,threshold,toptupamount;token,vaultId,threshold,toptupamount;... . Will override the 'SELF_FUND_ORDERS' in env variables
- `--route`, Specifies the routing mode 'multi' or 'single' or 'full', default is 'single'. Will override the 'ROUTE' in env variables
- `-w` or `--wallet-count`, Number of wallet to submit transactions with, requirs `--mnemonic`. Will override the 'WALLET_COUNT' in env variables
- `-t` or `--topup-amount`, The initial topup amount of excess wallets, requirs `--mnemonic`. Will override the 'TOPUP_AMOUNT' in env variables
- `--owner-profile`, Specifies the owner limit, example: --owner-profile 0x123456=12 . Will override the 'OWNER_PROFILE' in env variables
- `--public-rpc`, Allows to use public RPCs as fallbacks, default is false. Will override the 'PUBLIC_RPC' in env variables
- `--gas-price-multiplier`, Option to multiply the gas price fetched from the rpc as percentage, default is 107, ie +7%. Will override the 'GAS_PRICE_MULTIPLIER' in env variables
- `--gas-limit-multiplier`, Option to multiply the gas limit estimation from the rpc as percentage, default is 100, ie no change. Will override the 'GAS_LIMIT_MULTIPLIER' in env variables
- `--tx-gas`, Option to set a gas limit for all submitting txs optionally with appended percentage sign to apply as percentage to original gas. Will override the 'TX_GAS' in env variables
- `--quote-gas`, Option to set a static gas limit for quote read calls, default is 1 milion. Will override the 'QUOTE_GAS' in env variables
- `--rp-only`, Only clear orders through RP4, excludes intra and inter orderbook clears. Will override the 'RP_ONLY' in env variablesin env variables
- `-V` or `--version`, output the version number
- `-h` or `--help`, output usage information

<br>

### List of available supported dexes (decentralized exchanges)
- all of the below names are case INSENSITIVE:
`SushiSwapV2`,
`SushiSwapV3`,
`UniswapV2`,
`UniswapV3`,
`Trident`,
`QuickSwap`,
`ApeSwap`,
`PancakeSwapV2`,
`PancakeSwapV3`,
`TraderJoe`,
`Dfyn`,
`Elk`,
`JetSwap`,
`SpookySwapV2`,
`SpookySwapV3`,
`NetSwap`,
`NativeWrap`,
`HoneySwap`,
`UbeSwap`,
`Biswap`,
`CurveSwap`,
`DovishV3`,
`Wagmi`,
`LaserSwap`,
`BaseSwap`,
`AlgebraIntegral`,
`Solarbeam`,
`Swapsicle`,
`VVSStandard`,
`Fraxswap`,
`SwapBlast`,
`BlastDEX`,
`MonoswapV2`,
`MonoswapV3`,
`ThrusterV2`,
`ThrusterV3`,
`DyorV2`,
`HyperBlast`,
`KinetixV2`,
`KinetixV3`,
`Enosys`,
`BlazeSwap`,

<br>

CLI options can be viewed by running:
```bash
node arb-bot -h
```
<br>

Alternatively all variables can be specified in env variables with below keys:
```bash
# private key of the matchmaker bot's wallet
BOT_WALLET_PRIVATEKEY="123..."

# mnemonic phrase
MNEMONIC=""

# RPC URL(s) that will be provider for interacting with evm, use different providers if more than 1 is specified to prevent banning. 
# for specifying more than 1 RPC in the env, separate them by a comma and a space
RPC_URL="https://polygon-mainnet.g.alchemy.com/v2/{API_KEY}, https://rpc.ankr.com/polygon/{API_KEY}"

# Option to explicitly use for write transactions, such as flashbots or mev protect rpc to protect against mev attacks.
WRITE_RPC=""

# arb contract address
ARB_ADDRESS="0x123..."

# generic arb contract address
GENERIC_ARB_ADDRESS="0x123..."

# Option to filter the subgraph query results with orderbook contract address
ORDERBOOK_ADDRESS="0x123..."

# one or more subgraph urls to read orders details from, can be used in combination with ORDERS
# for more than 1 subgraphs, seperate them by comma and a space
SUBGRAPH="https://api.thegraph.com/subgraphs/name/org1/sg1, https://api.thegraph.com/subgraphs/name/org2/sg2"

# list of liquidity providers names seperated by a comma for each
LIQUIDITY_PROVIDERS="sushiswapv2,uniswapv3,quickswap"

# gas coverage percentage for each transaction to be considered profitable to be submitted
GAS_COVER="100"

# Option to filter the subgraph query results with a specific order hash
ORDER_HASH=""

# Option to filter the subgraph query results with a specific order owner address
ORDER_OWNER=""

# Seconds to wait between each arb round, default is 10
SLEEP=10

# Option to maximize maxIORatio
MAX_RATIO="true"

# Optional seconds to wait for the transaction to mine before disregarding it
TIMEOUT=""

# number of hops of binary search, if left unspecified will be 7 by default
HOPS=11

# api key for heyperDx platfomr to send spans to, if not set will send traces to localhost
HYPERDX_API_KEY=""

# trace/spans service name, defaults to "arb-bot" if not set
TRACER_SERVICE_NAME=""

# The amount of retries for the same order, max is 3, default is 1
RETRIES=1

# Option to specify time (in minutes) between pools updates, default is 0 minutes
POOL_UPDATE_INTERVAL=

# number of excess wallets for submitting txs, requires mnemonic option
WALLET_COUNT=

# topup amount for excess accounts, requires mnemonic option
TOPUP_AMOUNT=

# Minimum bot's wallet gas token balance before alering
BOT_MIN_BALANCE=

# Specifies owned order to get funded once their vault goes below the specified threshold
# example: token,vaultId,threshold,toptupamount;token,vaultId,threshold,toptupamount;...
SELF_FUND_ORDERS=

# Specifies the owner limit, in form of owner1=limit,owner2=limit,... , example: 0x123456=12,0x3456=44
OWNER_PROFILE= 

# Allows to use public RPCs as fallbacks, default is false
PUBLIC_RPC=

# Specifies the routing mode 'multi' or 'single' or 'full', default is 'single'
ROUTE="single"

# Option to multiply the gas price fetched from the rpc as percentage, default is 107, ie +7%
GAS_PRICE_MULTIPLIER=

# Option to multiply the gas limit estimation from the rpc as percentage, default is 100, ie no change
GAS_LIMIT_MULTIPLIER=

# Option to set a gas limit for all submitting txs optionally with appended percentage sign to apply as percentage to original gas
TX_GAS=

# Option to set a static gas limit for quote read calls, default is 1 milion
QUOTE_GAS=

# Only clear orders through RP4, excludes intra and inter orderbook clears
RP_ONLY="true"

# Address of dispair (ExpressionDeployer contract) to use for tasks
DISPAIR="address"
```
If both env variables and CLI argument are set, the CLI arguments will be prioritized and override the env variables.

If you install this app as a dependency for your project you can run it by (All the above arguments apply here as well):

```bash
arb-bot <OPTIONS>
```

<br>

## Running On Github Actions
In order to run this app periodically to clear orders in Github Actions, first you need to fork this repository, then you can modify the `./.github/workflows/take-orders.yaml` file with your desired configuration so the app run periodically. You can set the schedule for the app to run by modifying the cron syntax of the mentioned file and in the last line of the file, you can pass the required/optional arguments for the app to run. All the mentioned CLI arguments can be applied, for wallet private key and rpc url, you can set up Github Secrets.

Please be aware that schediled Github Actions can only be run at minimum once every 5 minutes and even that is not guarateed because it depends on Github resource availability at that time, so it is recommended to run the app on personal/reliable host if there is sensitivity with running on a schedule.

## Developers Guide
First run the [setup](#setup) section and then you can use following commands either from nix shell (`nix develop -c <COMMAND>`) or normally from your commandline.
To run the tests:
```bash
npm test
```
which runs on hardhat forked polygon network.

To lint or lint and fix:
```bash
npm run lint
```
```bash
npm run lint-fix
```
<br>

## Diag Order
Read this [document](./DiagOrder.md) in order to diag what happenes when an order is being tried to find an opportunity to clear against onchain liquidity, you would find the onchain liquidity price at the time the order is being executed against it as well as the what the order evals to, ie its `maxouput` and `ratio`.

## Docker

Use docker compose if possible as it handles several things for you:

- Restart policy
- Rebuild policy
- Volume management
- Log rotation/policy
- Potentially other stuff like networking

### .env

Docker compose natively supports .env so configure it as per example.env and above.

Notably `DOCKER_CHANNEL` MUST be set to the git branch that you're currently on,
and you should be at the HEAD of said branch when attempting to interact with it.

This ensures that you'll download a docker image compatible with the current code
in your repository.

### Up & volumes

Run `docker compose up -d` to bring the container up. If this is the first time
you are doing this for the current channel you will likely see a complaint about
a missing volume.

You can create the volume however you want using `docker volume` but if you want
to map a specific path on the host to the volume mounted in the guest you'll need
to tell Docker to do so. The default behaviour of Docker is that it manages
volumes opaquely within its own system files, which has pros and cons. Either way
the default behaviour won't give you a predictable path on the host to work with.

To create a bind mount to a specific absolute path on the host

```
docker volume create --driver local --opt type=none --opt device=<absolute-host-path> --opt o=bind <volume-name>
```