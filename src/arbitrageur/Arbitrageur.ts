import { min } from "@perp/common/build/lib/bn"
import { EthService } from "@perp/common/build/lib/eth/EthService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import { CollateralManager, IClearingHouse } from "@perp/common/build/types/curie"
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
  // NOTE: START_COLLATERAL, collateral and peakcollateral: collat is the 'real collat' init to START_COLLATERAL and update on
  // scale down/up. virtual collateral is the 'peak' unrealized collateral

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    minReturn: number
    maxReturn: number
    minMarginRatio: number
    maxMarginRatio: number
    collateral: number
    peakCollateral: number
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
                peakCollateral: market.START_COLLATERAL,
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
        //TODO.NXT add pending funding to p
        //let uret = (collat + upnl.toNumber())/collat
        //------------- commonif

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


    private async isStopLoss(mkt: string): Promise<boolean> {
        
        //const OP_USDC_ADDR = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(mkt)!)
        // TODO.OPTM make it a this param
        const vault = this.perpService.createVault()

        // check unrealizedReturn
        //TODO.NXT add pending funding to pnl
        // supportedvault func??? better useconst collatCurr = (await vault.getBalanceByToken(wlt.address, OP_USDC_ADDR)) / 10**6
 
        
        const upnl =  (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl.toNumber()
        // --- Check if peakCollateral needs to be updtate. Wrong place i know, refactor into main routine
        let collat = this.marketMap[mkt].collateral
        let pcoll =  this.marketMap[mkt].peakCollateral

        if ( (pcoll > collat) && (upnl > 0) ) {
            if ( collat + upnl* config.TP_EXECUTION_HAIRCUT > pcoll) {
                this.marketMap[mkt].peakCollateral += upnl*config.TP_EXECUTION_HAIRCUT
                console.log("INFO: peakCollat updated = " + this.marketMap[mkt].peakCollateral)
            }
        }

            // check if breached TP_MAX_ROLL_LOSS => disable mkt and exit block
            // use peakCollateral only if you have cleared the start seed

        //--- Only If already in profitable zone use the peak collat as basis. else ignore peak collateral 
        let basis = (collat > config.TP_START_CAP) ? this.marketMap[mkt].peakCollateral : collat
        //--- Check if exceeded max absolute loss relative to initial seed
        if (upnl < 0) { 
            let cumloss = this.marketMap[mkt].cummulativeLoss + upnl
            let ret = 1 + ( (basis + cumloss) -basis )/basis

            if (ret < config.TP_MAX_ROLL_LOSS ) {
                await this.closePosition( wlt!, this.marketMap[mkt].baseToken) 
                delete this.marketMap[mkt]
                console.log("INFO: " + mkt + "MAX_LOSS_ROLL reached. CumLoss " + cumloss)
                //TODO. HACK to exit loop. need to refactor
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

    }
   
 // TODO move to butil file
 async open(wlt: ethers.Wallet, btoken: string, side: Side, usdAmount: number ) {
    try {
        await this.openPosition(wlt!, btoken ,side,AmountType.QUOTE,Big(usdAmount),undefined,undefined,undefined)
        }
        catch (e: any) {
            console.error(`ERROR: FAILED OPEN. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.openPosition( wlt!,btoken,side,AmountType.QUOTE, Big(usdAmount),undefined,undefined,undefined )
            console.log("Re-oppened...")
        }
 }

 async close(wlt: ethers.Wallet, btoken: string) {
    try {
        await this.closePosition(wlt!, btoken, undefined,undefined,undefined)
        }
        catch (e: any) {
            console.error(`ERROR: FAILED CLOSE. Rotating endpoint: ${e.toString()}`)
            this.ethService.rotateToNextEndpoint()
            await this.closePosition(wlt!, btoken, undefined,undefined,undefined)
            console.log("closed...")
        }
 }
 
    async arbitrage(market: Market) {
        // TODO.OPTM make it a this param
        //const vault = this.perpService.createVault()

        //--- Get pnl/free collat
        //--- factor out to avoid recomputing unnecesary on most cycles
        let wlt = this.ethService.privateKeyToWallet(this.pkMap.get(market.name)!)
        let freec = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
        const upnl = (await this.perpService.getOwedAndUnrealizedPnl(wlt.address)).unrealizedPnl.toNumber()
        let side = market.name.endsWith("SHORT") ? Side.SHORT : Side.LONG
        let offsetSide = (side == Side.SHORT) ? Side.LONG : Side.SHORT
        //let offsetSide = side.endsWith("SHORT") ? Side.LONG : Side.SHORT
        // current collateral needed to compute actual loss to add to cumulative loss. mr = [upnl + collat]/position value
        let posVal = (await this.perpService.getTotalAbsPositionValue(wlt.address)).toNumber()
        let mr = await this.perpService.getMarginRatio(wlt.address)
        
        let lvrj = this.marketMap[market.name].leverage
        let actualLoss = null
        let actualProfit = null
        
        let uret = 1 + upnl/this.marketMap[market.name].collateral
        //--------------------------------------------------------------------------------------------------------------------
        //   Handle negative pnl 
        //--------------------------------------------------------------------------------------------------------------------
        if (upnl < 0) {
        //------------------- [ mir check ] ------------------------------------------------------
        if( uret < this.marketMap[market.name].minReturn ) { 
            let newlvrj = config.TP_DELEVERAGE_FACTOR*lvrj
            let adjLoss = Math.abs(upnl)/config.TP_EXECUTION_HAIRCUT
            
            if (freec > adjLoss ) { //--- reduce position if enough freec --
                if (adjLoss > config.TP_EXEC_MIN_PNL) {
                    await this.open(wlt!,this.marketMap[market.name].baseToken,offsetSide,adjLoss*newlvrj)
                    //compute change in coll (loss) [(mr*posVal-pnl), where pnl = 0 right after open] - collzero
                    let mr = (await this.perpService.getMarginRatio(wlt.address))!.toNumber()
                    actualLoss = mr!*posVal - this.marketMap[market.name].collateral
                }
                else { // amount too small to execute but still count as an (urealiaze) loss
                    console.log(adjLoss.toFixed(2) + " Too small loss to exec: " + market.name )
                    actualLoss = -adjLoss
                }
            }
            else { //---- insufficient freec.close and reopen UNLIKELY to be less than TP_EXEC_MIN_ PNL. 
                   await this.close( wlt!, market.baseToken) 
                   //compute actual loss using current collat == free collateral
                   let ccollat = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
                   actualLoss = ccollat - this.marketMap[market.name].collateral
                   //delverage reopen 
                   await this.open(wlt!, this.marketMap[market.name].baseToken,side,ccollat*newlvrj)
                   console.log("INFO, Reopen" +"," + market.name)
            }
            // update collateral and cumulative loss
            let fcol = this.marketMap[market.name].collateral += actualLoss
            let fcloss = this.marketMap[market.name].cummulativeLoss += actualLoss

            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            let ts = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
            console.log(ts + ",LMit:" + market.name + " aloss:" + actualLoss.toFixed(4) + 
                        " cumLoss:" + fcloss.toFixed(4) + " ccollat:" + fcol.toFixed(4))
        } // end of mir check
        //------------------- [ cumLoss check ] ------------------------------------------------------
        // unrealized-cumulative- loss (ucl) ret relative to initial basis 1 + (basis+cumloss -basis + upnl)/basis =>
            // uret (cumLoss + upnl)/initialSeed. unrealizedCummulativeLoss
            // if collateral < initial collateral use seed capital so we clip the worse path for 
        // if above then use peak collateral. rr is rollreturn 
            let ucl = this.marketMap[market.name].cummulativeLoss + upnl
            let basis = (this.marketMap[market.name].collateral > config.TP_START_CAP) 
                        ? this.marketMap[market.name].peakCollateral 
                        : config.TP_START_CAP
            let rr = 1 + ucl/basis
            if (rr < config.TP_MAX_ROLL_LOSS ) {
                await this.close( wlt!, market.baseToken) 
                delete this.marketMap[market.name]
                console.log("INFO: " + market.name + "MAX_LOSS_ROLL reached. CumLoss " + ucl)
                //exit main loop
                return 
            }
            console.log(market.name + ":ucl:" + ucl.toFixed(4) + ":basis: " + basis.toFixed(4))
        } // end of negative upnl 
        //--------------------------------------------------------------------------------------------------------------------
        //   Handle positive pnl 
        //--------------------------------------------------------------------------------------------------------------------
        if (upnl > 0) {
            //---- mar check (scaling check)
            if( uret > this.marketMap[market.name].maxReturn ){ 
                let newlvrj = config.TP_RELEVERAGE_FACTOR*lvrj
                let adjRet = upnl*config.TP_EXECUTION_HAIRCUT  // reduce the nominal pnl to accoutn for execution cost
                
                if (freec > adjRet ) { //--- reduce position if enough freec --
                    if (adjRet > config.TP_EXEC_MIN_PNL) {
                        await this.open(wlt!,this.marketMap[market.name].baseToken,offsetSide,adjRet*newlvrj)
                        //compute change in coll (abs return) [(mr*posVal-pnl), where pnl = 0 right after open] - collzero
                        let mr = (await this.perpService.getMarginRatio(wlt.address))!.toNumber()
                        actualProfit = mr!*posVal - this.marketMap[market.name].collateral
                    }
                    else { // amount too small to execute but still count as an (urealiaze) loss
                        actualProfit = adjRet
                        console.log(actualProfit.toFixed(2) + " Too small profit to exec: " + market.name )
                    }
                }
                else { //---- insufficient freec. close and reopen
                       await this.close( wlt!, market.baseToken) 
                       //compute abs ret using current collat == free collateral
                       let ccollat = (await this.perpService.getFreeCollateral(wlt!.address)).toNumber()
                       actualProfit = ccollat - this.marketMap[market.name].collateral
                       //delverage reopen 
                       await this.open(wlt!, this.marketMap[market.name].baseToken,side,ccollat*newlvrj)
                       console.log("INFO, Reopen" +"," + market.name)
                }
                // update collateral and cumulative loss
                let fcol = this.marketMap[market.name].collateral += actualProfit
                let fcloss = this.marketMap[market.name].cummulativeLoss += actualProfit
    
                //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
                //--- print time, actual loss, newcoll, cumLoss
                
                let ts = new Date(Date.now()).toLocaleTimeString([], {hour12: false})
                console.log(ts + ",LMit:" + market.name +  "prft:" + actualProfit.toFixed(4) + 
                            " cumLoss:" + fcloss.toFixed(4) + " ccollat: " + fcol.toFixed(4))
            }
        }
        //--- beats Print info: pnl, returns
        console.log(market.name + ":pnl:" + upnl.toFixed(4) + " uret:" + uret.toFixed(4) + " mr:" + mr!.toFixed(4))

        /*
        console.log("INFO: " + mkt + ": pnl: " + upnl.toFixed(4) + " uret: " + uret.toFixed(4))
    
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
            await this.openPosition(wlt!, market.baseToken,side,AmountType.QUOTE,Big(reOpenSz),undefined,undefined,undefined)
            }
            catch (e: any) {
                console.error(`FAILED OPEN: ${e.toString()}`)
                this.ethService.rotateToNextEndpoint()
                console.log("RETRY OPEN")
                await this.openPosition( wlt!, market.baseToken,side,AmountType.QUOTE, Big(reOpenSz),undefined,undefined,undefined )
            }
            
            this.marketMap[market.name].collateral = newcoll.toNumber()
            //let rsz = await this.perpService.getTotalPositionSize(wlt.address, market.baseToken)
            this.log.jinfo( {event: "Backoff", params: { market: market.name, ncoll: +newcoll,
                                                         nlvrj: newlvrj},} )
        }
        */
        // --------------------------------------------------------------------------------------------
        // check if scale trigger
        // --------------------------------------------------------------------------------------------
        // --- OJO: the key may have been removed  bcoz of MAX_ROLL_LOSS, but dont want to check
        // relying on the if statement evaluating to false for undefined
        /*
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
        }*/
        
    }
}