import { min } from "@perp/common/build/lib/bn"
import { EthService } from "@perp/common/build/lib/eth/EthService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import Big from "big.js"
import { ethers } from "ethers"
import { Service } from "typedi"

import config from "../configs/config.json"
require('dotenv').config();

//TESTING: block 55746888
//TODO.REFACT put on utility function. Templetize

type Wallet = ethers.Wallet
function transformValues(map: Map<string, string>, 
                        func: (n:string) => Wallet): Map<string, Wallet> {
    const result = new Map<string, Wallet>();
    map.forEach((value, key) => { result.set(key, func(value));});
    return result;
  }
  

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    
    minReturn: number
    maxReturn: number
    minMarginRatio: number
    maxMarginRatio: number
// TODO.RMV
orderAmount: Big


}

const DUST_USD_SIZE = Big(100)

@Service()
export class Arbitrageur extends BotService {
    readonly log = Log.getLogger(Arbitrageur.name)

    //private wallet!: ethers.Wallet
    // pkMap<market,pk>
    //private pkMap = new Map<string,string>([...Object.entries(pkconfig.PK_MAP)])
    private pkMap = new Map<string, string>()
    private marketMap: { [key: string]: Market } = {}
    private readonly arbitrageMaxGasFeeEth = Big(config.ARBITRAGE_MAX_GAS_FEE_ETH)

    async setup(): Promise<void> {
        this.log.jinfo({
            event: "SetupNoLo",
        })
        //note. ignore entry on provider url. using vSYMB[_SHORT]
       // Print the names and values of all the variables that match the pattern 'v[A-Z]{3,}'
        const pattern = /^v[A-Z]{3,}/  
        let vk = Object.entries(process.env).filter(([k])=> pattern.test(k))

        for (const [key, value] of vk) {
            this.pkMap.set(key, value!);
          }
          
        // initilize pkMap
        //let wlts = this.pkMap.forEach((v,k) => this.ethService.privateKeyToWallet(v))
          let wlts = transformValues(this.pkMap, v => this.ethService.privateKeyToWallet(v))
        // needed by BotService.retrySendTx
        await this.createNonceMutex([...wlts.values()])
        await this.createMarketMap()

        /*this.log.jinfo({
            event: "Arbitrageur",
            params: {
                address: this.wallet.address,
                //TODO.STK display nextnonce for all walets: nextNonce: this.addrNonceMutexMap[this.walletMap[].address].nextNonce,
                //nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
             }, })*/
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
            const pool = poolMap[marketName.split('_')[0]]
            
            this.marketMap[marketName] = {
                name: marketName,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                //TODO.RMV order amount
                orderAmount: Big(666),
                minReturn: market.MIN_RETURN,
                maxReturn: market.MAX_RETURN,
                minMarginRatio: market.MIN_MARGIN_RATIO,
                maxMarginRatio: market.MAX_MARGIN_RATIO
            }
        }
    }

    async start(): Promise<void> {
        this.ethService.enableEndpointRotation()
        //const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        //this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
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
        //const marginRatio = await this.perpService.getMarginRatio(this.wallet.address)
        this.log.jinfo({
            event: "PerpMarginRatio",
            //params: { marginRatio: marginRatio === null ? null : +marginRatio },
        })
        //return marginRatio !== null && marginRatio.lt(criterion)
    }

    private async isScaleTresh(mkt: string):  Promise<boolean>  {
        //TODO.NEXT refactor out this common code to main routine
        //----- common with stoploss refactor out
        const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)

        // thresh for fhis mkt
        const mmr = this.marketMap[mkt].maxMarginRatio

        const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl
        const mr = await this.perpService.getMarginRatio(wlt.address)
        // TODO.OPTM make it a this param
        const vault = this.perpService.createVault()
        const collat = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
        //TODO.NXT add pending funding to pnl
        let uret = (collat + upnl.toNumber())/collat
        //------------- common

        // check if excessive positive unrealizedReturn i.e approaching DC deceleration of compounding rate
        
        if( uret > this.marketMap[mkt].maxReturn ){ 
            return true; 
            console.log(mkt + ": exceeding max ret")
        }
        return mr !== null && mr.gt(mmr)
    }

    /*private async isScaleTresh(mkt: string) {
        let criterion = this.marketMap[mkt].maxMarginRatio
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        const marginRatio = await this.perpService.getMarginRatio(wlt.address)
        //this.log.jinfo({ event: "mr", params: { marginRatio: marginRatio === null ? null : +marginRatio },})
        return marginRatio !== null && marginRatio.gt(criterion)
    }*/

    /*private async isStopLoss(mkt: string) {
        let criterion = this.marketMap[mkt].lexitTresh
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        const marginRatio = await this.perpService.getMarginRatio(wlt.address)
        this.log.jinfo({ event: "mr", params: { marginRatio: marginRatio === null ? null : +marginRatio },})
        return marginRatio !== null && marginRatio.lt(criterion)
    }*/

    //-----------------------------------------------------------------------------------
    // stop loss on EITHER unrealizedReturn or exit from margin band (default:10-2: 8 )
    // using max lev simplifies collat tracking. always == usdc balance on vault
    //-----------------------------------------------------------------------------------
    
    private async isStopLoss(mkt: string): Promise<boolean> {
        
        const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        // TODO.OPTM make it a this param
        const vault = this.perpService.createVault()

        // check unrealizedReturn
        const maxloss = this.marketMap[mkt].minReturn
        const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl
        //TODO.NXT add pending funding to pnl
        const collat = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
        
        let uret = (collat + upnl.toNumber())/collat
        if( uret < this.marketMap[mkt].minReturn ){ 
            return true
            console.log(mkt + ": bellow min ret")
        }

        // check mr condtion
        const mmr = this.marketMap[mkt].minMarginRatio
        const mr = await this.perpService.getMarginRatio(wlt.address)
        //TODO.BKL support eth collat collTokens =  await vault.getCollateralTokens(wlt.address)

        console.log(mkt + ": uret:" + uret.toPrecision(4) + " mr:" + mr?.toPrecision(4) )
        return mr !== null && mr.lt(mmr)
    }
   

    async arbitrage(market: Market) {
        // --------------------------------------------------------------------------------------------
        // check if stop loss
        // AYB.REFACTOR repetitive code. move to butil?
        // --------------------------------------------------------------------------------------------
        if ( await this.isStopLoss(market.name)) 
        {
            this.log.jinfo({ event: "stop loss trigger", params: { market: market.name }, })
            let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
            // re-open at reset margin
            //TODO.OPTIMIZE avoid keep calculating wallet
            let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)

            await this.closePosition( wlt!, market.baseToken) 
            let coll = await this.perpService.getFreeCollateral(wlt!.address)
            this.log.jinfo({ event: "collat", params: { market: market.name, FC: +coll }, })
            // TODO.NXT handle when absolute size below a minimum. $2 ? then mr=1
            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10
            // TODO.NXT parametrize inconfig PEXIT and LEXIT
            const TP_WITHDRAWL = 0.98
            let rstlev = 1/(config.RESET_MARGIN_RATIO)
            let reOpenSz = TP_WITHDRAWL*rstlev*coll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            await this.openPosition(
                wlt!,
                market.baseToken,
                side,
                AmountType.QUOTE,
                Big(reOpenSz),
                undefined,
                undefined, // WAS: Big(config.BALANCE_MAX_GAS_FEE_ETH),
                undefined, //was this.referralCode,
            ) 
            let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.log.jinfo( {event: "Downscale", params: { market: market.name, sz: +rsz},} )
        }
        // --------------------------------------------------------------------------------------------
        // check if scale trigger
        // --------------------------------------------------------------------------------------------
 
        if ( await this.isScaleTresh(market.name)) 
        {
            this.log.jinfo({ event: "scale trigger", params: { market: market.name }, })
            let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
            // re-open at reset margin
            //TODO.OPTIMIZE avoid keep calculating wallet
            let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)

            await this.closePosition( wlt!, market.baseToken) 
            let coll = await this.perpService.getFreeCollateral(wlt!.address)
            this.log.jinfo({ event: "collat", params: { market: market.name, sz: +coll }, })
            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10
            const TP_WITHDRAWL = 0.9
            let rstlev = 1/(config.RESET_MARGIN_RATIO)
            let reOpenSz = TP_WITHDRAWL*rstlev*coll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            await this.openPosition(
                wlt!,
                market.baseToken,
                side,
                AmountType.QUOTE,
                Big(reOpenSz),
                undefined,
                undefined, // WAS: Big(config.BALANCE_MAX_GAS_FEE_ETH),
                undefined, //was this.referralCode,
            ) 
            let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.log.jinfo( {event: "Rescale", params: { market: market.name, sz: +rsz},} )
        }
        
    }
}
