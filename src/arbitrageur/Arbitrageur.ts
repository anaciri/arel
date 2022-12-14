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
                orderAmount: Big(market.ORDER_AMOUNT),
                
            }
        }
    }

    async start(): Promise<void> {
        this.ethService.enableEndpointRotation()
        const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
        if (balance.gt(0)) {
            await this.approve(this.wallet, balance)
            await this.deposit(this.wallet, balance)
        }

        this.arbitrageRoutine()
    }


    async arbitrageRoutine() {
        while (true) {
            this.markRoutineAlive("ArbitrageRoutine")
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

    async arbitrage(market: Market) {
        // getting margin ratio
        const [isBelowPerpMR, perpPositionSize] = 
        await Promise.all([
            this.isBelowPerpMarginRatio(config.PERP_MIN_MARGIN_RATIO),
            this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken),
        ])
     
        const orderAmount = market.orderAmount

        
        this.log.jinfo({
            event: "PositionSizeBefore",
            params: { market: market.name, perpPositionSize: +perpPositionSize },
        })
        // AYB: if below margin close and RE-OPEN. TO parametrize for now use 0.8
        // TODO: check max gas fee is reasonable
        const side = perpPositionSize.gt(0) ? Side.SHORT : Side.LONG
        if (isBelowPerpMR ) {
            // close first 
            await this.closePosition( this.wallet, market.baseToken) 
        }
        
        /*await this.openPosition(
                this.wallet,
                market.baseToken,
                side,
                AmountType.BASE,
                positionSizeDiffAbs,
                        undefined,
                        Big(config.BALANCE_MAX_GAS_FEE_ETH),
                        this.referralCode,
        ) */
        let perpPositionSizeAfter = await Promise.all([
            this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken),
              ])
        this.log.jinfo({
            event: "PositionSizeAfter",
            params: {
                market: market.name,
                perpPositionSize: +perpPositionSizeAfter
            },
        })
    }
}
