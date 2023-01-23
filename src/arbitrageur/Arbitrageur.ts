import { min } from "@perp/common/build/lib/bn"
import { EthService } from "@perp/common/build/lib/eth/EthService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import { CollateralManager } from "@perp/common/build/types/curie"
import Big from "big.js"
import { ethers } from "ethers"
import { padEnd } from "lodash"
import { Service } from "typedi"

import config from "../configs/config.json"
require('dotenv').config();

//TESTING: block SOLShort: 65131100, 55746888
//TODO.REFACT put on utility function. Templetize
const TP_MIN_MR    = 0.12  // 8.33x
const TP_MR_DEC_SZ = 0.02
const TP_MAX_MR    = 0.50 
const TP_MR_INC_SZ = 0.02  // OJO you INC onStopLoss 5x

// below not used remove
const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'

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
    collateral: number
    leverage: number
    resetNeeded:boolean
    resetSize: number
    cummulativeLoss: number
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
    private resetMap = new Map<string, boolean>()
    private pkMap = new Map<string, string>()
    private marketMap: { [key: string]: Market } = {}
    private readonly arbitrageMaxGasFeeEth = Big(config.ARBITRAGE_MAX_GAS_FEE_ETH)

//----------------------------------------------------------------------------------------
// DBG
// block: 888, vPERP
//----------------------------------------------------------------------------------------

async dbg_get_uret() {
    // OJO. dont wast time testing what u know already works. closing and reopening
    // works that is not changing only logi to compute ure. the other changes
    // initialize initialCollatera are trivial
    let mkt = 'vPERP'
    let perpBaseToken = "0x9482AaFdCed6b899626f465e1FA0Cf1B1418d797"
    let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
    let test =  await this.perpService.getTotalPositionSize(wlt.address, perpBaseToken)
    let vault = await this.perpService.createVault()

    const initalCollateral = this.marketMap[mkt].collateral
    const currCollateral = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
    const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl

    //check return value makes sense
    let uret = 1 + (currCollateral + upnl.toNumber() - initalCollateral)/initalCollateral
    
     //regardless if stoploss or scale, need to 1.close and 2.open 
     // that is not changing. no need to retest  
    console.log(uret)
}

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
                maxMarginRatio: market.MAX_MARGIN_RATIO,
                collateral: market.START_COLLATERAL,
                leverage: market.RESET_LEVERAGE,
                cummulativeLoss: 0,
                //TODO.rmv
                resetNeeded: false,
                resetSize:0
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
       // OJO. BOOKMARK. after done testin. COMMENT out AND uncomment this.arbitrageRoutine()
        //this.dbg_get_uret()
        // UNCOMMENT ME ABOVE to debug
        // WAIT FOR setup to finish

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
        //const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)

        // thresh for fhis mkt
        //const mmr = this.marketMap[mkt].maxMarginRatio

        //const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl
        //const mr = await this.perpService.getMarginRatio(wlt.address)
        // TODO.OPTM make it a this param
        const vault = this.perpService.createVault()
        //const collatCurr = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
        //TODO.NXT add pending funding to pnl
        //let uret = (collat + upnl.toNumber())/collat
        //------------- common

        // check if excessive positive unrealizedReturn i.e approaching DC deceleration of compounding rate
        let collat = this.marketMap[mkt].collateral
        const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl

        //let uret = 1 + ((collatCurr + upnl.toNumber()) - collatInitial)/collatInitial
        let uret = 1 + upnl.toNumber()/collat
        if( uret > this.marketMap[mkt].maxReturn ){ 
            console.log(mkt + " SCALE: "+ mkt + "curcoll: " + collat)
            return true; 
        }
        return false
        // NO more MR triggers
        //return mr !== null && mr.gt(mmr)
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
        
        //const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        // TODO.OPTM make it a this param
        const vault = this.perpService.createVault()

        // check unrealizedReturn
        //TODO.NXT add pending funding to pnl
        // supportedvault func??? better useconst collatCurr = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
 
        let collat = this.marketMap[mkt].collateral
        const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl.toNumber()

            // check if breached TP_MAX_ROLL_LOSS => disable mkt and exit block
            if (upnl < 0) { 
                let capz = config.TP_START_CAP
                let cumloss = this.marketMap[mkt].cummulativeLoss + upnl
                let ret = 1 + ( (capz + cumloss) -capz )/capz

            if (ret < config.TP_MAX_ROLL_LOSS ) {
                await this.closePosition( wlt!, this.marketMap[mkt].baseToken) 
                delete this.marketMap[mkt]
                console.log(mkt + ": MAX_LOSS_ROLL reached. removed")
                //TODO. HACK need to refactor
                return false
            }
        }


        let uret = 1 + upnl/collat

        if( uret < this.marketMap[mkt].minReturn ){ 
            console.log(mkt + " LMit: "+ mkt + "pnl: " + upnl)
            return true
        }
        console.log(mkt + ": pnl: " + upnl.toFixed(4) + " uret: " + uret.toFixed(4))
        return false

        // check mr condtion. remove
        /*
        const mmr = this.marketMap[mkt].minMarginRatio
        const mr = await this.perpService.getMarginRatio(wlt.address)
        //TODO.BKL support eth collat collTokens =  await vault.getCollateralTokens(wlt.address)

        console.log(mkt + ": uret:" + uret.toPrecision(4) + " mr:" + mr?.toPrecision(4) )
        return mr !== null && mr.lt(mmr)
         */
    }
   
    /*
    private async resetCheck(mkt: string) {
        // loop through failed open. double check again and try reopen
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        let bt = this.marketMap[mkt].baseToken
        let posz = await this.perpService.getTotalPositionSize(wlt.address, bt)
        if (posz.toNumber() !=0  ) {
            // false alarm
            this.marketMap[mkt].resetNeeded = false
        }
        else {
            // last open attempt failed. 
            let side = mkt.endsWith("SHORT") ? Side.SHORT : Side.LONG
            //let coll = await this.perpService.getFreeCollateral(wlt!.address)
            //let reOpenSz = this.marketMap[mkt].leverage*coll.toNumber()
            // ensure you are carrying the attempted leverjing from failed open
            let reOpenSz = this.marketMap[mkt].resetSize
            // try, again to open position
            try {
                // flag main routine to reset if open fails again
                console.log("RESET ATTEMPT...")
                await this.openPosition(
                    wlt!, bt, side, AmountType.QUOTE,
                    Big(reOpenSz),undefined, undefined, undefined
                ) 
                this.log.jinfo({ event: "RESET: ", params: { market: mkt, size: + reOpenSz }, })
                // OK. it worked set back to false
                this.marketMap[mkt].resetNeeded = false
            }
            catch (e: any) {
                console.error(`FAILED RESET: ${e.toString()}`)
            }
        }
    }*/


    async arbitrage(market: Market) {
        //-----------------------------------------------------------------
        // check if reset is needed
        //-----------------------------------------
        //this.resetCheck(market.name)
        // --------------------------------------------------------------------------------------------
        // check if stop loss
        // AYB.REFACTOR repetitive code. move to butil?
        // --------------------------------------------------------------------------------------------
        if ( await this.isStopLoss(market.name)) 
        {
            this.log.jinfo({ event: "stop loss trigger", params: { market: market.name }, })
            let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
            
            //TODO.OPTIMIZE avoid keep calculating wallet
            let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)
            await this.closePosition( wlt!, market.baseToken) 
            let newcoll = await this.perpService.getFreeCollateral(wlt!.address)

            // update cummulative loss
            let loss = newcoll.toNumber() - config.TP_START_CAP
            this.marketMap[market.name].cummulativeLoss = this.marketMap[market.name].cummulativeLoss + loss
                        
            //let newcoll = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
            this.log.jinfo({ event: "lMit: ", params: { market: market.name, newColl: + newcoll }, })
            // TODO.NXT handle when absolute size below a minimum. $2 ? then mr=1
            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10
            // TODO.NXT parametrize inconfig PEXIT and LEXIT
            //const TP_WITHDRAWL = 0.98

             // deleverage
            let mr = 1/this.marketMap[market.name].leverage
            let newlvrj = 1/Math.min(TP_MAX_MR, mr + TP_MR_INC_SZ)
            
            let reOpenSz = newlvrj*newcoll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            try {
            await this.openPosition(
                wlt!, market.baseToken,side,AmountType.QUOTE,Big(reOpenSz),undefined,undefined,undefined)
            }
            catch (e: any) {
                console.error(`FAILED OPEN: ${e.toString()}`)
                this.ethService.rotateToNextEndpoint()
                console.log("RETRY OPEN")
                await this.openPosition( wlt!, market.baseToken,side,AmountType.QUOTE,
                                         Big(reOpenSz),undefined,undefined,undefined )
    
                
                /*
                try {  // UGLY nested try catch
                    let r = await this.openPosition(
                        wlt!, market.baseToken, side, AmountType.QUOTE,
                        Big(reOpenSz),undefined, undefined, undefined)
                    }
                    catch(e: any) {
                        console.log("GIVING UP. delegate to checkReset()")
                        // flag main routine to reset if open fails again
                        // so at start of routine will try again
                        market.resetNeeded = true
                        market.resetSize = reOpenSz
                    }*/
            }
            
            this.marketMap[market.name].collateral = newcoll.toNumber()
            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.log.jinfo( {event: "Backoff", params: { market: market.name, ncoll: +newcoll,
                                                         nlvrj: newlvrj},} )
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
            //let coll = await this.perpService.getFreeCollateral(wlt!.address)
            // rebase collateral
            //const vault = this.perpService.createVault()
            //const newcollat = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
            let newcoll = await this.perpService.getFreeCollateral(wlt!.address)

            // TODO.NXT wdraw TP_PEXIT_WITHDRAWL .10

            // releverage
            let mr = 1/this.marketMap[market.name].leverage
            let newlvrj = 1/Math.max(TP_MIN_MR, mr - TP_MR_DEC_SZ)

            let reOpenSz = newlvrj*newcoll.toNumber()
            // TODO.STK  adjust default max gas fee is reasonable
            try {
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
            }
            catch (e: any) {
                console.error(`Scale: FAILED OPEN: ${e.toString()}`)
                this.ethService.rotateToNextEndpoint()
                console.log("RETRY OPEN")
                await this.openPosition( wlt!, market.baseToken,side,AmountType.QUOTE,
                                         Big(reOpenSz),undefined,undefined,undefined )
            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.marketMap[market.name].collateral = newcoll.toNumber()
                }
            this.log.jinfo( {event: "Scale", params: { mkt: market.name, 
                                                       nlevrj: newlvrj, ncoll: +newcoll},} )
        }
        
    }
}
