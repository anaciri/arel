import { min } from "@perp/common/build/lib/bn"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import Big from "big.js"
import { ethers } from "ethers"
import { Service } from "typedi"

import config from "../configs/config.json"

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    orderAmount: Big
}

const DUST_USD_SIZE = Big(100)

@Service()
export class Arbitrageur extends BotService {
    readonly log = Log.getLogger(Arbitrageur.name)

    private wallet!: ethers.Wallet
    private marketMap: { [key: string]: Market } = {}
    private readonly arbitrageMaxGasFeeEth = Big(config.ARBITRAGE_MAX_GAS_FEE_ETH)

    async setup(): Promise<void> {
        this.log.jinfo({
            event: "SetupArbitrageur",
        })
        const privateKey = process.env.PRIVATE_KEY
        this.wallet = this.ethService.privateKeyToWallet(privateKey!)
        await this.createNonceMutex([this.wallet])
        await this.createMarketMap()


        this.log.jinfo({
            event: "Arbitrageur",
            params: {
                address: this.wallet.address,
                nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
             },
        })
    }

    async createMarketMap() {
        const poolMap: { [keys: string]: any } = {}
        for (const pool of this.perpService.metadata.pools) {
            poolMap[pool.baseSymbol] = pool
        }
        for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
            if (!market.IS_ENABLED) {
                continue
            }
            const pool = poolMap[marketName]
            
            this.marketMap[marketName] = {
                name: marketName,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                //TODO.RMV order amount
                orderAmount: Big(666),
                
            }
        }
    }

    async start(): Promise<void> {
        this.ethService.enableEndpointRotation()
        const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
        /*
        if (balance.gt(0)) {
            await this.approve(this.wallet, balance)
            await this.deposit(this.wallet, balance)
        }
        */
        this.arbitrageRoutine()
    }


    async arbitrageRoutine() {
        while (true) {
            //TODO.STK turn on heart beat below
            //this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        await this.arbitrage(market)
                    } catch (err: any) {
                        await this.jerror({ event: "ArbitrageError", params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }


    private async isBelowPerpMarginRatio(criterion: number) {
        const marginRatio = await this.perpService.getMarginRatio(this.wallet.address)
        this.log.jinfo({
            event: "PerpMarginRatio",
            params: { marginRatio: marginRatio === null ? null : +marginRatio },
        })
        return marginRatio !== null && marginRatio.lt(criterion)
    }

    private async isRescaleTresh(criterion: number) {
        const marginRatio = await this.perpService.getMarginRatio(this.wallet.address)
        this.log.jinfo({
            event: "PerpMarginRatio",
            params: { marginRatio: marginRatio === null ? null : +marginRatio },
        })
        return marginRatio !== null && marginRatio.gt(criterion)
    }

    async arbitrage(market: Market) {
        // --------------------------------------------------------------------------------------------
        // check if scale trigger
        // --------------------------------------------------------------------------------------------
        if ( await this.isRescaleTresh(config.TP_MR_SCALE)) 
        {
            this.log.jinfo({ event: "scale trigger", params: { market: market.name }, })
            let sz = await this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken)
            let side = sz.gt(0) ? Side.LONG : Side.SHORT
            // re-open at reset margin
            await this.closePosition( this.wallet, market.baseToken) 
            //TODO.NXT multiple trader accounts
            let coll = await this.perpService.getFreeCollateral(this.wallet.address)
            this.log.jinfo({ event: "collat", params: { market: market.name, sz: +coll }, })
            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10
            const TP_PEXIT_WITHDRAWL = 0.9
            let rstlev = 1/(config.TP_MR_RESET)
            let reOpenSz = TP_PEXIT_WITHDRAWL*rstlev*coll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            await this.openPosition(
                this.wallet,
                market.baseToken,
                side,
                AmountType.QUOTE,
                Big(reOpenSz),
                undefined,
                undefined, // WAS: Big(config.BALANCE_MAX_GAS_FEE_ETH),
                undefined, //was this.referralCode,
            ) 
            let rsz = await this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken)
            this.log.jinfo( {event: "Reset", params: { market: market.name, sz: +rsz},} )
        }
        
    }
}
