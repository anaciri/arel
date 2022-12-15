"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var BotService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotService = void 0;
const contracts_1 = require("@eth-optimism/contracts");
const transactions_1 = require("@ethersproject/transactions");
const async_mutex_1 = require("async-mutex");
const big_js_1 = __importDefault(require("big.js"));
const ethers_1 = require("ethers");
const typedi_1 = require("typedi");
const L2EthService_1 = require("../eth/L2EthService");
const FtxService_1 = require("../external/FtxService");
const GraphService_1 = require("../graph/GraphService");
const helper_1 = require("../helper");
const loggers_1 = require("../loggers");
const ServerProfile_1 = require("../profile/ServerProfile");
const SecretsManager_1 = require("../secrets/SecretsManager");
const types_1 = require("../types");
const PerpService_1 = require("./PerpService");
const MAX_RETRY_COUNT = 5;
let BotService = BotService_1 = class BotService {
    perpService;
    ethService;
    ftxService;
    graphService;
    secretsManager;
    serverProfile;
    log = loggers_1.Log.getLogger(BotService_1.name);
    addrNonceMutexMap = {};
    lastRoutineAliveTime = {};
    constructor(perpService, ethService, ftxService, graphService, secretsManager, serverProfile) {
        this.perpService = perpService;
        this.ethService = ethService;
        this.ftxService = ftxService;
        this.graphService = graphService;
        this.secretsManager = secretsManager;
        this.serverProfile = serverProfile;
        if (this.serverProfile.stage !== "test") {
            this.healthCheckRoutine();
        }
    }
    markRoutineAlive(routineName) {
        this.log.jinfo({ event: `${routineName}Alive` });
        this.lastRoutineAliveTime[routineName] = Date.now();
    }
    async healthCheckRoutine() {
        // routine should not be longer than 5 mins
        // TODO: customize max time by routine
        const MAX_ROUTINE_EXEC_TIME_SEC = 5 * 60;
        while (true) {
            const secSinceLastRoutineAliveMap = {};
            for (const [routineName, lastAliveTime] of Object.entries(this.lastRoutineAliveTime)) {
                secSinceLastRoutineAliveMap[routineName] = (Date.now() - lastAliveTime) / 1000;
            }
            /* TODO.STK health rutine stgy
            this.log.jinfo({
                event: "HealthCheckRutinaAlive",
                params: { secSinceLastRoutineAliveMap },
            });*/
            for (const [routineName, secSinceLastRoutineAlive] of Object.entries(secSinceLastRoutineAliveMap)) {
                if (secSinceLastRoutineAlive > MAX_ROUTINE_EXEC_TIME_SEC) {
                    const err = new Error(`${routineName} is not working for ${secSinceLastRoutineAlive} secs`);
                    await this.log.jerror({ event: "RoutineHealthCheckError", params: { err } });
                    throw err;
                }
            }
            await helper_1.sleep(10 * 1000);
        }
    }
    async createNonceMutex(wallets) {
        for (const wallet of wallets) {
            this.addrNonceMutexMap[wallet.address] = {
                nextNonce: await wallet.getTransactionCount(),
                mutex: new async_mutex_1.Mutex(),
            };
        }
    }
    async retrySendTx(wallet, sendTx) {
        const nonceMutex = this.addrNonceMutexMap[wallet.address];
        for (let retryCount = 0; retryCount <= MAX_RETRY_COUNT; retryCount++) {
            if (retryCount > 0) {
                this.log.jinfo({ event: "RetrySendTx", params: { retryCount } });
            }
            const release = await nonceMutex.mutex.acquire();
            try {
                const tx = await sendTx();
                nonceMutex.nextNonce++;
                this.log.jinfo({
                    event: "TxSent",
                    params: {
                        txHash: tx.hash,
                        gasPrice: tx.gasPrice?.toString(),
                        maxFeePerGas: tx.maxFeePerGas ? tx.maxFeePerGas.toString() : null,
                        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? tx.maxPriorityFeePerGas.toString() : null,
                        gasLimit: tx.gasLimit.toString(),
                        nonce: tx.nonce,
                        rawData: tx.raw,
                    },
                });
                return tx;
            }
            catch (err) {
                if (err.code === "NONCE_EXPIRED" || err.message.includes("invalid transaction nonce")) {
                    const expiredNonce = nonceMutex.nextNonce;
                    nonceMutex.nextNonce = await wallet.getTransactionCount();
                    this.log.jinfo({
                        event: "NonceReset",
                        params: { expiredNonce: expiredNonce, newNonce: nonceMutex.nextNonce },
                    });
                    continue;
                }
                throw err;
            }
            finally {
                release();
            }
        }
        throw Error("max retry count reached");
    }
    verifyOverrides(overrides) {
        if (process.env.NETWORK === types_1.Network.OPTIMISM_KOVAN) {
            if (overrides.gasPrice) {
                throw Error("should not set gas price for optimism");
            }
        }
    }
    decorateOverrides(overrides) {
        if (overrides) {
            this.verifyOverrides(overrides);
        }
        return {
            // set default gas limit to prevent "cannot estimate gas limit" error from some provider
            gasLimit: 15_000_000,
            ...overrides,
        };
    }
    async estimateGasFee(contract, methodName, ...args) {
        // sample code: https://community.optimism.io/docs/developers/l2/new-fees.html
        // contract: https://github.com/ethereum-optimism/optimism/blob/master/packages/contracts/contracts/L2/predeploys/OVM_GasPriceOracle.sol
        const tx = await contract.populateTransaction[methodName](...args);
        const signer = this.ethService.provider.getSigner(tx.from);
        const OVM_GasPriceOracle = contracts_1.getContractFactory("OVM_GasPriceOracle", signer).attach(contracts_1.predeploys.OVM_GasPriceOracle);
        const serializedTx = transactions_1.serialize({
            nonce: tx.nonce,
            value: tx.value,
            gasPrice: tx.gasPrice,
            gasLimit: tx.gasLimit,
            to: tx.to,
            data: tx.data,
        });
        const [l1Fee, l2GasUsed, l2GasPrice] = await Promise.all([
            await OVM_GasPriceOracle.getL1Fee(serializedTx),
            await contract.estimateGas[methodName](...args),
            await this.ethService.getGasPrice(),
        ]);
        const l1FeeInEth = PerpService_1.PerpService.fromWei(l1Fee);
        // l2GasPrice is in gwei
        const l2FeeInEth = helper_1.BNToBig(l2GasUsed).mul(l2GasPrice).div(1e9);
        const totalFeeInEth = l1FeeInEth.add(l2FeeInEth);
        this.log.jinfo({
            event: "EstimateGasFee",
            params: {
                l1FeeInEth: +l1FeeInEth,
                l2GasUsed: +l2GasUsed,
                l2GasPrice: +l2GasPrice,
                l2FeeInEth: +l2FeeInEth,
                totalFeeInEth: +totalFeeInEth,
            },
        });
        return totalFeeInEth;
    }
    async checkGasFee(maxGasFee, contract, methodName, ...args) {
        if (!maxGasFee) {
            return;
        }
        const estimatedGasFee = await this.estimateGasFee(contract, methodName, ...args);
        if (estimatedGasFee.gt(maxGasFee)) {
            throw Error("estimated gas fee exceeds max gas fee");
        }
    }
    async approve(trader, amount, overrides, toDelegatableVault = false) {
        const vault = toDelegatableVault
            ? this.perpService.createDelegatableVault(trader)
            : this.perpService.createVault(trader);
        const usdc = this.perpService.createUSDC(trader);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            return usdc.approve(vault.address, PerpService_1.PerpService.toWei(amount, await this.perpService.getUSDCDecimals()), {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
        };
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "ApproveTxSent",
            params: { trader: trader.address, amount: +amount, approvedAddress: vault.address },
        });
        await tx.wait();
        this.log.jinfo({ event: "ApproveTxMined" });
    }
    async deposit(trader, amount, overrides, useDelegatableVault = false) {
        const vault = useDelegatableVault
            ? this.perpService.createDelegatableVault(trader)
            : this.perpService.createVault(trader);
        const usdc = this.perpService.createUSDC(trader);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            return vault.deposit(usdc.address, PerpService_1.PerpService.toWei(amount, await this.perpService.getVaultDecimals()), {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
        };
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "DepositTxSent",
            params: {
                trader: trader.address,
                token: usdc.address,
                amount: +amount,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "DepositTxMined",
            params: {
                trader: trader.address,
                token: usdc.address,
                amount: +amount,
                txHash: tx.hash,
            },
        });
    }
    async removeLiquidity(trader, baseToken, lowerTick, upperTick, liquidity, overrides, useDelegatableVault = false, maxGasFee = undefined) {
        const clearingHouse = useDelegatableVault
            ? this.perpService.createDelegatableVault(trader)
            : this.perpService.createClearingHouse(trader);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            await this.checkGasFee(maxGasFee, clearingHouse, "removeLiquidity", {
                baseToken: baseToken,
                liquidity: helper_1.BigToBN(liquidity),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers_1.constants.MaxUint256,
            }, {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
            return clearingHouse.removeLiquidity({
                baseToken: baseToken,
                liquidity: helper_1.BigToBN(liquidity),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers_1.constants.MaxUint256,
            }, {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
        };
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "RemoveLiquidityTxSent",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                liquidity: +liquidity,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "RemoveLiquidityTxMined",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                liquidity: +liquidity,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        });
    }
    async addLiquidity(trader, baseToken, lowerTick, upperTick, base, quote, useTakerBalance, overrides, useDelegatableVault = false, maxGasFee = undefined) {
        const clearingHouse = useDelegatableVault
            ? this.perpService.createDelegatableVault(trader)
            : this.perpService.createClearingHouse(trader);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            await this.checkGasFee(maxGasFee, clearingHouse, "addLiquidity", {
                baseToken: baseToken,
                base: PerpService_1.PerpService.toWei(base),
                quote: PerpService_1.PerpService.toWei(quote),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: useTakerBalance,
                deadline: ethers_1.constants.MaxUint256,
            }, {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
            return clearingHouse.addLiquidity({
                baseToken: baseToken,
                base: PerpService_1.PerpService.toWei(base),
                quote: PerpService_1.PerpService.toWei(quote),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: useTakerBalance,
                deadline: ethers_1.constants.MaxUint256,
            }, {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            });
        };
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "AddLiquidityTxSent",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                base: +base,
                quote: +quote,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "AddLiquidityTxMined",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                base: +base,
                quote: +quote,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        });
    }
    convertSideAndAmountType(side, amountType) {
        let isBaseToQuote;
        let isExactInput;
        if (side === PerpService_1.Side.SHORT) {
            isBaseToQuote = true;
            // for short, the input is base
            isExactInput = amountType === PerpService_1.AmountType.BASE;
        }
        else {
            isBaseToQuote = false;
            // for long, the input is quote
            isExactInput = amountType === PerpService_1.AmountType.QUOTE;
        }
        return { isBaseToQuote, isExactInput };
    }
    async estimateOpenPositionGasFee(trader, baseToken, side, amountType, amount, originalOverrides, referralCode = null) {
        const clearingHouse = this.perpService.createClearingHouse(trader);
        const { isBaseToQuote, isExactInput } = this.convertSideAndAmountType(side, amountType);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const params = {
            baseToken,
            isBaseToQuote,
            isExactInput,
            amount: PerpService_1.PerpService.toWei(amount),
            oppositeAmountBound: 0,
            deadline: ethers_1.constants.MaxUint256,
            sqrtPriceLimitX96: 0,
            referralCode: referralCode ? ethers_1.utils.formatBytes32String(referralCode) : ethers_1.constants.HashZero,
        };
        const overrides = {
            nonce: nonceMutex.nextNonce,
            ...this.decorateOverrides(originalOverrides),
        };
        return this.estimateGasFee(clearingHouse, "openPosition", params, overrides);
    }
    async openPosition(trader, baseToken, side, amountType, amount, overrides, maxGasFee = undefined, referralCode = null) {
        const clearingHouse = this.perpService.createClearingHouse(trader);
        const { isBaseToQuote, isExactInput } = this.convertSideAndAmountType(side, amountType);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            const params = {
                baseToken,
                isBaseToQuote,
                isExactInput,
                amount: PerpService_1.PerpService.toWei(amount),
                oppositeAmountBound: 0,
                deadline: ethers_1.constants.MaxUint256,
                sqrtPriceLimitX96: 0,
                referralCode: referralCode ? ethers_1.utils.formatBytes32String(referralCode) : ethers_1.constants.HashZero,
            };
            const overrides = {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            };
            try {
                await clearingHouse.callStatic.openPosition(params, overrides);
            }
            catch (e) {
                const errMsg = e.message || e.reason;
                // Don't log error if market is paused
                if (errMsg.includes("EX_MIP")) {
                    this.log.jinfo({ event: "OpenPositionMarketIsPaused", params: { market: baseToken } });
                }
                else {
                    await this.jerror({ event: "OpenPositionCallStaticError", params: { err: e } });
                }
                throw e;
            }
            await this.checkGasFee(maxGasFee, clearingHouse, "openPosition", params, overrides);
            return clearingHouse.openPosition(params, overrides);
        };
        const startTime = Date.now();
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "OpenPositionTxSent",
            params: {
                trader: trader.address,
                baseToken,
                isBaseToQuote,
                isExactInput,
                amount: +amount,
                referralCode,
                timeSpent: Date.now() - startTime,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "OpenPositionTxMined",
            params: {
                trader: trader.address,
                baseToken,
                isBaseToQuote,
                isExactInput,
                amount: +amount,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
                timeSpent: Date.now() - startTime,
            },
        });
    }
    // Note: this only close taker position
    // it can end up increasing total position if there is maker position
    async closePosition(trader, baseToken, overrides, useDelegatableVault = false, maxGasFee = undefined, referralCode = null) {
        let traderAddr = trader.address;
        if (useDelegatableVault) {
            traderAddr = this.perpService.createDelegatableVault(trader).address;
        }
        const takerPositionSize = await this.perpService.getTakerPositionSize(traderAddr, baseToken);
        if (takerPositionSize.eq(0)) {
            return;
        }
        const clearingHouse = useDelegatableVault
            ? this.perpService.createDelegatableVault(trader)
            : this.perpService.createClearingHouse(trader);
        const nonceMutex = this.addrNonceMutexMap[trader.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = async () => {
            const params = {
                baseToken,
                sqrtPriceLimitX96: PerpService_1.PerpService.toWei(big_js_1.default(0)),
                oppositeAmountBound: PerpService_1.PerpService.toWei(big_js_1.default(0)),
                deadline: ethers_1.constants.MaxUint256,
                referralCode: referralCode ? ethers_1.utils.formatBytes32String(referralCode) : ethers_1.constants.HashZero,
            };
            const overrides = {
                nonce: nonceMutex.nextNonce,
                ...decoratedOverrides,
            };
            try {
                await clearingHouse.callStatic.closePosition(params, overrides);
            }
            catch (e) {
                const errMsg = e.message || e.reason;
                // Don't log error if market is paused
                if (errMsg.includes("EX_MIP")) {
                    this.log.jinfo({ event: "ClosePositionMarketIsPaused", params: { market: baseToken } });
                }
                else {
                    await this.jerror({ event: "ClosePositionCallStaticError", params: { err: e } });
                }
                throw e;
            }
            await this.checkGasFee(maxGasFee, clearingHouse, "closePosition", params, overrides);
            return clearingHouse.closePosition(params, overrides);
        };
        const tx = await this.retrySendTx(trader, sendTx);
        this.log.jinfo({
            event: "ClosePositionTxSent",
            params: {
                trader: trader.address,
                baseToken,
                referralCode,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "ClosePositionTxMined",
            params: {
                trader: trader.address,
                baseToken,
                txHash: tx.hash,
                currentPositionSize: +(await this.perpService.getTotalPositionSize(trader.address, baseToken)),
            },
        });
    }
    async cancelAllExcessOrders(signer, maker, baseToken, overrides) {
        const clearingHouse = this.perpService.createClearingHouse(signer);
        const nonceMutex = this.addrNonceMutexMap[signer.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = () => clearingHouse.cancelAllExcessOrders(maker, baseToken, {
            nonce: nonceMutex.nextNonce,
            ...decoratedOverrides,
        });
        const tx = await this.retrySendTx(signer, sendTx);
        this.log.jinfo({
            event: "CancelAllExcessOrdersTxSent",
            params: {
                signer: signer.address,
                maker,
                baseToken,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "CancelAllExcessOrdersTxMined",
            params: {
                signer: signer.address,
                maker,
                baseToken,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        });
    }
    async liquidate(signer, trader, baseToken, oppositeAmountBound, overrides) {
        const clearingHouse = this.perpService.createClearingHouse(signer);
        const nonceMutex = this.addrNonceMutexMap[signer.address];
        const decoratedOverrides = this.decorateOverrides(overrides);
        const sendTx = () => clearingHouse["liquidate(address,address,uint256)"](trader, baseToken, PerpService_1.PerpService.toWei(oppositeAmountBound), {
            nonce: nonceMutex.nextNonce,
            ...decoratedOverrides,
        });
        const tx = await this.retrySendTx(signer, sendTx);
        this.log.jinfo({
            event: "LiquidateTxSent",
            params: {
                signer: signer.address,
                trader,
                baseToken,
                oppositeAmountBound: +oppositeAmountBound,
            },
        });
        await tx.wait();
        this.log.jinfo({
            event: "LiquidateTxMined",
            params: {
                signer: signer.address,
                trader,
                baseToken,
                oppositeAmountBound: +oppositeAmountBound,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        });
    }
    async jerror(errorLogData) {
        let blockNumber;
        try {
            blockNumber = await this.ethService.getLatestBlockNumber();
        }
        catch (e) {
            // don't throw error i we could not get the latest block number
        }
        const _errorLogData = { ...errorLogData };
        _errorLogData.params = { ..._errorLogData.params, ts: Date.now(), blockNumber };
        await this.log.jerror(_errorLogData);
    }
};
BotService = BotService_1 = __decorate([
    typedi_1.Service(),
    __metadata("design:paramtypes", [PerpService_1.PerpService,
        L2EthService_1.L2EthService,
        FtxService_1.FtxService,
        GraphService_1.GraphService,
        SecretsManager_1.SecretsManager,
        ServerProfile_1.ServerProfile])
], BotService);
exports.BotService = BotService;
//# sourceMappingURL=BotService.js.map